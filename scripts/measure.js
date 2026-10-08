// Chạy ma trận đo (decisions.md mục 6.3, 7.4) và ghi bảng đo thô results/raw/runs.csv.
//   npm run measure                 -> đầy đủ: main + throttle + fault
//   node scripts/measure.js --quick -> 1 lượt × 2 warm, để thử nhanh
//   node scripts/measure.js --matrix main,fault --rounds 5 --warm 5
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR, ROOT } from '../shared/config.js';
import { launchBrowser, loadScreen } from './browser.js';
import { LogTail, countEvents } from './logs.js';
import { Stack, ensureClient, setFault } from './stack.js';

// ---------- Tham số ----------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const quick = argv.includes('--quick');
const ROUNDS = Number(arg('rounds', quick ? 1 : 5));
const WARM = Number(arg('warm', quick ? 2 : 5));
const MATRICES = arg('matrix', 'main,throttle,fault').split(',');
const DATASETS = arg('datasets', 'small,large').split(',');
const THROTTLE_MS = 100;

const USERS = { small: 'u_small', large: 'u_large' };
const META = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta.json'), 'utf8')).users;

// 7 tổ hợp (variant, client) của ma trận chính.
const COMBOS = [
  { variant: 'baseline', client: 'web' },
  { variant: 'bff', client: 'web' },
  { variant: 'bff', client: 'mobile' },
  { variant: 'gql-naive', client: 'web' },
  { variant: 'gql-naive', client: 'mobile' },
  { variant: 'gql-batched', client: 'web' },
  { variant: 'gql-batched', client: 'mobile' },
];
const pageVariant = (v) => (v.startsWith('gql') ? 'graphql' : v);
const loaderOf = (v) => (v === 'gql-naive' ? 'naive' : 'batched');

const FAULTS = [
  { id: 'delay300', mode: 'delay', delayMs: 300 },
  { id: 'delay3000', mode: 'delay', delayMs: 3000 },
  { id: 'error500', mode: 'error', delayMs: 0 },
  { id: 'hang', mode: 'hang', delayMs: 0 },
];

// ---------- Đầu ra ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = `logs/measure-${stamp}`;
const RAW_DIR = path.join(ROOT, 'results', 'raw');
const SHOT_DIR = path.join(ROOT, 'results', 'screenshots');
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const COLUMNS = [
  'run_id', 'ts', 'variant', 'client', 'dataset', 'throttle', 'fault', 'round', 'mode', 'run_no', 'rid',
  'client_requests', 'preflight', 'static_requests',
  'user_calls', 'order_calls', 'product_calls', 'cache_hits',
  'user_db', 'order_db', 'product_db',
  't_data_ms', 't_complete_ms', 't_images_ms',
  'payload_bytes', 'payload_gzip_bytes', 'http_status', 'has_errors', 'rows_rendered',
  // Cột bổ sung để kiểm chứng (ngoài danh sách mục 5.5)
  'items_rendered', 'screen_status', 'error_codes', 'timed_out', 'count_check', 'valid',
];
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const runsFile = path.join(RAW_DIR, 'runs.csv');
const timingFile = path.join(RAW_DIR, 'client-timing.jsonl');
fs.writeFileSync(runsFile, COLUMNS.join(',') + '\n');
fs.writeFileSync(timingFile, '');

// ---------- Một lần chạy ----------
let runId = 0;
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

async function run(browser, tail, spec) {
  const { variant, client, dataset, throttle = 'none', fault = 'none', round, mode, runNo, screenshot = null, record = true } = spec;
  const rid = crypto.randomUUID();
  const user = USERS[dataset];
  const { screen, dataRequests, staticRequests } = await loadScreen(browser, {
    page: client,
    variant: pageVariant(variant),
    user,
    rid,
    throttleMs: throttle === 'none' ? 0 : THROTTLE_MS,
    screenshot,
  });
  const events = await tail.collect(rid);
  if (!record) return null;

  const counts = countEvents(events);
  const expected = META[user];
  const { rows = 0, items = 0 } = screen.detail ?? {};
  const valid = screen.status !== 'error' && rows === expected.N && items === expected.M;
  const bodies = dataRequests.map((r) => r.body);

  const row = {
    run_id: ++runId,
    ts: new Date().toISOString(),
    variant,
    client,
    dataset,
    throttle,
    fault,
    round,
    mode,
    run_no: runNo,
    rid,
    client_requests: dataRequests.length,
    preflight: counts.preflight,
    static_requests: staticRequests,
    user_calls: counts.user_calls,
    order_calls: counts.order_calls,
    product_calls: counts.product_calls,
    cache_hits: counts.cache_hits,
    user_db: counts.user_db,
    order_db: counts.order_db,
    product_db: counts.product_db,
    t_data_ms: round1(screen.screenComplete - screen.dataStart),
    t_complete_ms: round1(screen.screenComplete),
    t_images_ms: round1(screen.imagesComplete),
    payload_bytes: bodies.reduce((a, b) => a + b.length, 0),
    payload_gzip_bytes: bodies.reduce((a, b) => a + zlib.gzipSync(b).length, 0),
    http_status: [...new Set(dataRequests.map((r) => r.status))].join('|'),
    has_errors: (screen.errors?.length ?? 0) > 0,
    rows_rendered: rows,
    items_rendered: items,
    screen_status: screen.status,
    error_codes: [...new Set((screen.errors ?? []).map((e) => e.extensions?.code))].join('|'),
    timed_out: counts.timed_out,
    count_check: counts.count_check,
    valid,
  };
  fs.appendFileSync(runsFile, COLUMNS.map((c) => csvCell(row[c])).join(',') + '\n');
  fs.appendFileSync(
    timingFile,
    JSON.stringify({
      run_id: row.run_id,
      rid,
      variant,
      client,
      dataset,
      throttle,
      fault,
      mode,
      timeOrigin: screen.timeOrigin,
      dataStart: screen.dataStart,
      screenComplete: screen.screenComplete,
      imagesComplete: screen.imagesComplete,
      resources: screen.resources.filter((r) => r.initiatorType !== 'img'),
      images: screen.resources.filter((r) => r.initiatorType === 'img').length,
    }) + '\n',
  );
  return row;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const summarize = (label, rows) => {
  const t = rows.map((r) => r.t_data_ms);
  const bad = rows.filter((r) => !r.valid || r.count_check !== 'ok').length;
  console.log(
    `  ${label.padEnd(44)} n=${String(rows.length).padStart(2)} t_data median=${median(t).toFixed(1).padStart(7)} ms ` +
      `[${Math.min(...t).toFixed(1)}–${Math.max(...t).toFixed(1)}] product_calls=${rows[0]?.product_calls}${bad ? `  (${bad} invalid/mismatch)` : ''}`,
  );
};

// ---------- Chạy ma trận ----------
const client = await ensureClient({ logDir: LOG_DIR });
const stack = new Stack({ logDir: LOG_DIR, enableFault: true });
const tail = new LogTail(path.join(ROOT, LOG_DIR));
const { browser, name: browserName } = await launchBrowser();

fs.writeFileSync(
  path.join(RAW_DIR, 'session.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      logDir: LOG_DIR,
      browser: browserName,
      node: process.version,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      params: { rounds: ROUNDS, warm: WARM, matrices: MATRICES, datasets: DATASETS, throttleMs: THROTTLE_MS },
    },
    null,
    2,
  ) + '\n',
);
console.log(`Trình duyệt: ${browserName}. Log: ${LOG_DIR}. Bảng thô: results/raw/runs.csv`);

const started = Date.now();
try {
  if (MATRICES.includes('main')) {
    console.log(`\n[main] ${ROUNDS} lượt × (restart → 1 cold + ${WARM} warm)`);
    for (const dataset of DATASETS) {
      for (const { variant, client: c } of COMBOS) {
        const cold = [];
        const warm = [];
        for (let round = 1; round <= ROUNDS; round++) {
          await stack.restart({ productLoader: loaderOf(variant) });
          cold.push(await run(browser, tail, { variant, client: c, dataset, round, mode: 'cold', runNo: 1 }));
          for (let w = 1; w <= WARM; w++) warm.push(await run(browser, tail, { variant, client: c, dataset, round, mode: 'warm', runNo: w + 1 }));
        }
        summarize(`${variant}/${c}/${dataset} cold`, cold);
        summarize(`${variant}/${c}/${dataset} warm`, warm);
      }
    }
  }

  if (MATRICES.includes('throttle')) {
    console.log(`\n[throttle] RTT +${THROTTLE_MS} ms, 1 lượt × ${WARM} warm (1 lần khởi động bỏ đi)`);
    for (const dataset of DATASETS) {
      for (const { variant, client: c } of COMBOS) {
        await stack.restart({ productLoader: loaderOf(variant) });
        await run(browser, tail, { variant, client: c, dataset, mode: 'cold', record: false });
        const rows = [];
        for (let w = 1; w <= WARM; w++) {
          rows.push(await run(browser, tail, { variant, client: c, dataset, throttle: `rtt${THROTTLE_MS}`, round: 1, mode: 'warm', runNo: w + 1 }));
        }
        summarize(`${variant}/${c}/${dataset} rtt${THROTTLE_MS}`, rows);
      }
    }
  }

  if (MATRICES.includes('fault')) {
    console.log(`\n[fault] ${FAULTS.map((f) => f.id).join(', ')} × {bff, gql-batched} × {web, mobile} × small, ${WARM} warm`);
    for (const variant of ['bff', 'gql-batched']) {
      await stack.restart({ productLoader: 'batched' });
      for (const c of ['web', 'mobile']) await run(browser, tail, { variant, client: c, dataset: 'small', mode: 'cold', record: false });
      for (const f of FAULTS) {
        await setFault(f.mode, f.delayMs);
        for (const c of ['web', 'mobile']) {
          const rows = [];
          for (let w = 1; w <= WARM; w++) {
            const screenshot = w === 1 ? path.join(SHOT_DIR, `fault-${f.id}-${variant}-${c}.png`) : null;
            rows.push(await run(browser, tail, { variant, client: c, dataset: 'small', fault: f.id, round: 1, mode: 'warm', runNo: w + 1, screenshot }));
          }
          summarize(`${variant}/${c}/small ${f.id}`, rows);
        }
      }
      await setFault('none');
    }
  }
} finally {
  await browser.close();
  await stack.stop();
  await client?.stop();
}
console.log(`\nXong ${runId} lần chạy trong ${((Date.now() - started) / 1000).toFixed(0)} s. Tiếp: npm run report`);
