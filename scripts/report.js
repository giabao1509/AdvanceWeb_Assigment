// Tổng hợp results/raw/runs.csv -> results/summary.csv và results/summary.md (median và min–max).
// Chạy: npm run report
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../shared/config.js';
import { median, readCsv } from './csv.js';

const RAW = path.join(ROOT, 'results', 'raw', 'runs.csv');
const session = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'raw', 'session.json'), 'utf8'));

const NUM = ['client_requests', 'preflight', 'static_requests', 'user_calls', 'order_calls', 'product_calls', 'cache_hits', 'user_db', 'order_db', 'product_db', 't_data_ms', 't_complete_ms', 't_images_ms', 'payload_bytes', 'payload_gzip_bytes', 'timed_out'];
const runs = readCsv(RAW, NUM);

const stats = (xs) => {
  const v = xs.filter((x) => x != null);
  return { median: median(v), min: Math.min(...v), max: Math.max(...v) };
};

const VARIANT_ORDER = ['baseline', 'bff', 'gql-naive', 'gql-batched'];
const KEY = ['variant', 'client', 'dataset', 'throttle', 'fault', 'mode'];
const groups = new Map();
for (const r of runs) {
  const k = KEY.map((c) => r[c]).join('|');
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
// Thứ tự: dataset, throttle, fault, mode, client (web trước), variant.
const sortKey = (k) => {
  const [variant, client, dataset, throttle, fault, mode] = k.split('|');
  return [dataset, throttle, fault, mode, client === 'web' ? 0 : 1, VARIANT_ORDER.indexOf(variant)];
};
const ordered = [...groups.entries()].sort(([a], [b]) => {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
});

// ---------- summary.csv ----------
const SUM_COLS = [...KEY, 'n', 'invalid', 'count_mismatch', 'screen_status', 'error_codes'];
const METRICS = ['t_data_ms', 't_complete_ms', 'client_requests', 'preflight', 'user_calls', 'order_calls', 'product_calls', 'cache_hits', 'user_db', 'order_db', 'product_db', 'payload_bytes', 'payload_gzip_bytes', 'timed_out'];
const summaryRows = ordered.map(([k, rs]) => {
  const row = Object.fromEntries(KEY.map((c, i) => [c, k.split('|')[i]]));
  row.n = rs.length;
  row.invalid = rs.filter((r) => r.valid !== 'true').length;
  row.count_mismatch = rs.filter((r) => r.count_check !== 'ok').length;
  row.screen_status = [...new Set(rs.map((r) => r.screen_status))].join('|');
  row.error_codes = [...new Set(rs.map((r) => r.error_codes).filter(Boolean))].join('|');
  for (const m of METRICS) {
    const s = stats(rs.map((r) => r[m]));
    row[`${m}_median`] = s.median;
    row[`${m}_min`] = s.min;
    row[`${m}_max`] = s.max;
  }
  return row;
});
const sumHeader = [...SUM_COLS, ...METRICS.flatMap((m) => [`${m}_median`, `${m}_min`, `${m}_max`])];
fs.writeFileSync(
  path.join(ROOT, 'results', 'summary.csv'),
  [sumHeader.join(','), ...summaryRows.map((r) => sumHeader.map((c) => r[c] ?? '').join(','))].join('\n') + '\n',
);

// ---------- summary.md ----------
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : Number.isInteger(x) ? String(x) : x.toFixed(d));
const range = (r, m, d = 1) => {
  const med = r[`${m}_median`];
  const lo = r[`${m}_min`];
  const hi = r[`${m}_max`];
  return lo === hi ? fmt(med, d) : `${fmt(med, d)} [${fmt(lo, d)}–${fmt(hi, d)}]`;
};
const calls = (r, svc) => `${range(r, `${svc}_calls`, 0)} / ${range(r, `${svc}_db`, 0)}`;
const kb = (r) => `${(r.payload_bytes_median / 1024).toFixed(1)} KB (gzip ${(r.payload_gzip_bytes_median / 1024).toFixed(1)})`;

function table(title, rows, extra = []) {
  const head = ['Biến thể', 'Client', 'Data', 'Mode', 'n', 't_data ms median [min–max]', 't_complete ms', 'Client req (+preflight)', 'User call/DB', 'Order call/DB', 'Product call/DB', 'cache-hit', 'Payload', ...extra.map((e) => e.label)];
  const lines = rows.map((r) =>
    [
      r.variant,
      r.client,
      r.dataset,
      r.mode,
      r.n + (r.invalid || r.count_mismatch ? ` (⚠ ${r.invalid} invalid, ${r.count_mismatch} mismatch)` : ''),
      range(r, 't_data_ms'),
      fmt(r.t_complete_ms_median),
      `${range(r, 'client_requests', 0)} (+${range(r, 'preflight', 0)})`,
      calls(r, 'user'),
      calls(r, 'order'),
      calls(r, 'product'),
      range(r, 'cache_hits', 0),
      kb(r),
      ...extra.map((e) => e.get(r)),
    ].join(' | '),
  );
  return `### ${title}\n\n| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${lines.map((l) => `| ${l} |`).join('\n')}\n`;
}

const pick = (pred) => summaryRows.filter(pred);
const sections = [];
sections.push(`# Kết quả đo (tự sinh bởi scripts/report.js)

- Phiên đo: ${session.startedAt}, trình duyệt ${session.browser}, Node ${session.node}, ${session.os}, CPU ${session.cpu}
- Tham số: ${JSON.stringify(session.params)}
- Log thô: \`${session.logDir}/*.jsonl\` · bảng thô: \`results/raw/runs.csv\` (${runs.length} lần chạy) · tổng hợp: \`results/summary.csv\`
- Cách đếm: decisions.md mục 5. Client req lấy từ Playwright (tương đương HAR), preflight/service call/DB query lấy từ log theo \`rid\`.
- Ô có dạng \`median [min–max]\`; chỉ có một số nghĩa là mọi lần chạy cho cùng giá trị.
`);

for (const dataset of ['small', 'large']) {
  for (const mode of ['cold', 'warm']) {
    const rows = pick((r) => r.dataset === dataset && r.throttle === 'none' && r.fault === 'none' && r.mode === mode);
    if (rows.length) sections.push(table(`Ma trận chính · ${dataset} · ${mode}`, rows));
  }
}
for (const dataset of ['small', 'large']) {
  const rows = pick((r) => r.dataset === dataset && r.throttle !== 'none');
  if (rows.length) sections.push(table(`Throttle RTT +${session.params.throttleMs} ms · ${dataset} · warm`, rows));
}
const faultRows = pick((r) => r.fault !== 'none');
if (faultRows.length) {
  sections.push(
    table('Product Service chậm/lỗi · small · warm', faultRows, [
      { label: 'Fault', get: (r) => r.fault },
      { label: 'Màn hình', get: (r) => r.screen_status },
      { label: 'Mã lỗi', get: (r) => r.error_codes || '–' },
      { label: 'Call timeout', get: (r) => range(r, 'timed_out', 0) },
    ]),
  );
}

fs.writeFileSync(path.join(ROOT, 'results', 'summary.md'), sections.join('\n') + '\n');
console.log(`Đã ghi results/summary.md và results/summary.csv từ ${runs.length} lần chạy (${summaryRows.length} nhóm).`);
