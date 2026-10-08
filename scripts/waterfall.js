// Waterfall (SVG), trace N+1 (GraphQL) và call graph nội bộ (BFF) từ một phiên đo (decisions.md mục 6.3).
// Chạy sau measure.js: npm run waterfall
import fs from 'node:fs';
import path from 'node:path';
import { PORTS, ROOT } from '../shared/config.js';
import { median, readCsv } from './csv.js';
import { readAllEvents } from './logs.js';

const RAW_DIR = path.join(ROOT, 'results', 'raw');
const WF_DIR = path.join(ROOT, 'results', 'waterfall');
const TRACE_DIR = path.join(ROOT, 'results', 'traces');
fs.mkdirSync(WF_DIR, { recursive: true });
fs.mkdirSync(TRACE_DIR, { recursive: true });

const session = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'session.json'), 'utf8'));
const runs = readCsv(path.join(RAW_DIR, 'runs.csv'), ['run_id', 't_data_ms', 'product_calls', 'cache_hits']);
const timing = new Map(
  fs
    .readFileSync(path.join(RAW_DIR, 'client-timing.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((t) => [t.rid, t]),
);
console.log(`Đọc log ${session.logDir} …`);
const eventsByRid = readAllEvents(path.join(ROOT, session.logDir));

// Lần chạy có t_data gần median nhất của một nhóm.
function medianRun(filter) {
  const rs = runs.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
  if (!rs.length) return null;
  const m = median(rs.map((r) => r.t_data_ms));
  return rs.reduce((best, r) => (Math.abs(r.t_data_ms - m) < Math.abs(best.t_data_ms - m) ? r : best));
}

const stripRid = (p) => p.replace(/[?&]rid=[^&]*/, '').replace(/\?$/, '');
const shorten = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- Dựng các hàng của waterfall ----------
const LANE_COLOR = {
  static: '#b9b2a6',
  client: '#2f6db0',
  preflight: '#8a6fc4',
  bff: '#6b4f3a',
  graphql: '#6b4f3a',
  user: '#3f8f5f',
  order: '#c08321',
  product: '#b5473a',
};
const DATA_PORTS = new Set([PORTS.user, PORTS.order, PORTS.product, PORTS.bff, PORTS.graphql].map(String));

function buildRows(t, events) {
  const t0 = t.timeOrigin;
  const rows = [];
  for (const r of t.resources) {
    const u = new URL(r.name);
    const lane = DATA_PORTS.has(u.port) ? 'client' : 'static';
    rows.push({ lane, label: `${lane === 'client' ? 'browser fetch' : 'tải'} :${u.port}${stripRid(u.pathname + u.search)}`, start: r.startTime, end: r.responseEnd });
  }
  const done = new Map(events.filter((e) => e.kind === 'http-done').map((e) => [`${e.service}#${e.seq}`, e]));
  // http-out của composer, ghép FIFO với http-in ở service đích theo (target, path).
  const outQueue = new Map();
  for (const o of events.filter((x) => x.kind === 'http-out')) {
    const k = `${o.target} ${o.path}`;
    if (!outQueue.has(k)) outQueue.set(k, []);
    outQueue.get(k).push(o);
  }
  for (const e of events.filter((x) => x.kind === 'http-in')) {
    const d = done.get(`${e.service}#${e.seq}`);
    const start = e.ts - t0;
    const end = d ? d.ts - t0 : start;
    const db = events.filter((x) => x.kind === 'db' && x.service === e.service && x.ts - t0 >= start - 0.01 && x.ts - t0 <= end + 0.01).map((x) => x.ts - t0);
    const lane = e.method === 'OPTIONS' ? 'preflight' : e.service;
    const o = outQueue.get(`${e.service} ${e.path}`)?.shift();
    const outer = o && { start: o.ts - t0, end: o.ts - t0 + o.durationMs, timedOut: o.timedOut };
    const note = o?.timedOut ? '[timeout] ' : d?.aborted ? '[bị huỷ] ' : d && d.status >= 400 ? `[${d.status}] ` : '';
    rows.push({ lane, label: `${e.service} ${note}${e.method} ${stripRid(e.path)}`, start, end, db, outer });
  }
  const laneRank = (l) => (l === 'static' ? 0 : l === 'client' ? 1 : 2);
  return rows.sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || a.start - b.start);
}

function niceStep(max) {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]) if (max / s <= 10) return s;
  return 5000;
}

function renderSvg(title, subtitle, t, events) {
  const rows = buildRows(t, events);
  const LABEL_W = 380;
  const CHART_W = 720;
  const ROW_H = 18;
  const TOP = 64;
  const xMax = Math.max(t.screenComplete, ...rows.map((r) => r.end)) * 1.05;
  const x = (ms) => LABEL_W + (ms / xMax) * CHART_W;
  const height = TOP + rows.length * ROW_H + 70;
  const step = niceStep(xMax);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_W + CHART_W + 20}" height="${height}" font-family="Segoe UI, system-ui, sans-serif" font-size="11">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<text x="10" y="20" font-size="14" font-weight="600" fill="#24211d">${esc(title)}</text>`);
  parts.push(`<text x="10" y="38" fill="#6d675f">${esc(subtitle)}</text>`);
  for (let v = 0; v <= xMax; v += step) {
    parts.push(`<line x1="${x(v)}" y1="${TOP - 8}" x2="${x(v)}" y2="${TOP + rows.length * ROW_H}" stroke="#eeeae4"/>`);
    parts.push(`<text x="${x(v)}" y="${TOP - 12}" text-anchor="middle" fill="#6d675f">${v} ms</text>`);
  }
  rows.forEach((r, i) => {
    const y = TOP + i * ROW_H;
    if (i % 2) parts.push(`<rect x="0" y="${y}" width="${LABEL_W + CHART_W + 20}" height="${ROW_H}" fill="#faf9f7"/>`);
    parts.push(`<text x="10" y="${y + 13}" fill="#24211d">${esc(shorten(r.label, 62))}</text>`);
    if (r.outer) {
      const ow = Math.max(1.5, x(r.outer.end) - x(r.outer.start));
      parts.push(`<rect x="${x(r.outer.start)}" y="${y + 6}" width="${ow}" height="${ROW_H - 12}" rx="2" fill="${LANE_COLOR[r.lane]}" opacity="0.28"><title>Bên gọi chờ: ${r.outer.start.toFixed(1)} → ${r.outer.end.toFixed(1)} ms (${(r.outer.end - r.outer.start).toFixed(1)} ms)${r.outer.timedOut ? ', timeout' : ''}</title></rect>`);
    }
    const w = Math.max(1.5, x(r.end) - x(r.start));
    parts.push(`<rect x="${x(r.start)}" y="${y + 4}" width="${w}" height="${ROW_H - 8}" rx="2" fill="${LANE_COLOR[r.lane] ?? '#888'}"><title>${esc(r.label)}: ${r.start.toFixed(1)} → ${r.end.toFixed(1)} ms (${(r.end - r.start).toFixed(1)} ms)</title></rect>`);
    for (const d of r.db ?? []) parts.push(`<rect x="${x(d) - 1}" y="${y + 2}" width="2" height="${ROW_H - 4}" fill="#111"><title>DB query @ ${d.toFixed(2)} ms</title></rect>`);
  });
  const bottom = TOP + rows.length * ROW_H;
  const marker = (ms, color, label, dy) => {
    parts.push(`<line x1="${x(ms)}" y1="${TOP - 8}" x2="${x(ms)}" y2="${bottom + 6}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    const nearRight = x(ms) > LABEL_W + CHART_W * 0.75;
    parts.push(`<text x="${nearRight ? x(ms) - 3 : x(ms) + 3}" y="${bottom + 18 + dy}" text-anchor="${nearRight ? 'end' : 'start'}" fill="${color}" font-weight="600">${esc(label)} ${ms.toFixed(1)} ms</text>`);
  };
  marker(t.dataStart, '#2f6db0', 'data-start', 0);
  marker(t.screenComplete, '#b5473a', 'screen-complete', 14);
  const legend = [['static', 'tải trang'], ['client', 'browser fetch'], ['preflight', 'CORS preflight'], ['bff', 'composer'], ['user', 'User'], ['order', 'Order'], ['product', 'Product']];
  legend.forEach(([lane, label], i) => {
    const lx = 10 + i * 120;
    parts.push(`<rect x="${lx}" y="${height - 22}" width="12" height="10" fill="${LANE_COLOR[lane]}"/><text x="${lx + 16}" y="${height - 13}" fill="#24211d">${label}</text>`);
  });
  parts.push(`<rect x="${10 + legend.length * 120}" y="${height - 24}" width="2" height="14" fill="#111"/><text x="${16 + legend.length * 120}" y="${height - 13}" fill="#24211d">DB query</text>`);
  parts.push(`<text x="10" y="${height - 36}" fill="#6d675f">Trục x tính từ performance.timeOrigin. Thanh nhạt: thời gian bên gọi (composer) chờ; thanh đậm: service xử lý. ${t.images} request ảnh (sau screen-complete) không vẽ.</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------- Waterfall ----------
const COMBOS = [
  ['baseline', 'web'],
  ['bff', 'web'],
  ['bff', 'mobile'],
  ['gql-naive', 'web'],
  ['gql-naive', 'mobile'],
  ['gql-batched', 'web'],
  ['gql-batched', 'mobile'],
];
const index = ['# Waterfall (tự sinh bởi scripts/waterfall.js)', '', `Phiên đo: ${session.startedAt}. Mỗi hình là lần warm có t_data gần median nhất của nhóm.`, ''];
const scenarios = [
  { key: 'none', throttle: 'none', fault: 'none', title: 'localhost' },
  { key: 'rtt100', throttle: 'rtt100', fault: 'none', title: 'throttle RTT +100 ms' },
  { key: 'hang', throttle: 'none', fault: 'hang', title: 'Product treo (timeout 1000 ms)' },
];
for (const sc of scenarios) {
  const block = [];
  for (const [variant, client] of COMBOS) {
    const r = medianRun({ variant, client, dataset: 'small', throttle: sc.throttle, fault: sc.fault, mode: 'warm' });
    if (!r) continue;
    const t = timing.get(r.rid);
    const events = eventsByRid.get(r.rid) ?? [];
    const file = `${variant}-${client}-small-${sc.key}.svg`;
    const svg = renderSvg(
      `${variant} · ${client} · u_small · ${sc.title}`,
      `run ${r.run_id} · rid ${r.rid} · t_data ${r.t_data_ms} ms · ${r.client_requests} client req · product calls ${r.product_calls}`,
      t,
      events,
    );
    fs.writeFileSync(path.join(WF_DIR, file), svg);
    block.push(`### ${variant} · ${client}\n\n![${variant} ${client}](${file})\n`);
  }
  if (block.length) index.push(`## ${sc.title}`, '', ...block);
}
fs.writeFileSync(path.join(WF_DIR, 'README.md'), index.join('\n') + '\n');

// ---------- Trace N+1 (GraphQL) ----------
function productTrace(r) {
  const events = eventsByRid.get(r.rid) ?? [];
  const root = events.find((e) => e.kind === 'http-in' && e.service === 'graphql' && e.method === 'POST');
  const t0 = root?.ts ?? events[0]?.ts ?? 0;
  const outs = events.filter((e) => e.kind === 'http-out' && e.target === 'product');
  // Số call Product đang chạy cùng lúc nhiều nhất.
  const edges = outs.flatMap((e) => [[e.ts, 1], [e.ts + e.durationMs, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of edges) peak = Math.max(peak, (cur += d));
  const done = events.find((e) => e.kind === 'http-done' && e.service === 'graphql' && e.seq === root?.seq);
  return { events, outs, t0, peak, total: done?.durationMs };
}

const n1 = ['# Trace N+1 trước và sau khi sửa (GraphQL, web)', '', `Tự sinh bởi scripts/waterfall.js từ log \`${session.logDir}\`. Mỗi mục là lần warm có t_data gần median nhất. Thời gian tính từ lúc GraphQL nhận request.`, ''];
n1.push('| Bản | Dataset | rid | Product call | Product DB query | cache-hit | Call Product chạy song song tối đa | Thời gian xử lý ở GraphQL (ms) | t_data (ms) |', '|---|---|---|---|---|---|---|---|---|');
const traceRuns = [];
for (const variant of ['gql-naive', 'gql-batched']) {
  for (const dataset of ['small', 'large']) {
    const r = medianRun({ variant, client: 'web', dataset, throttle: 'none', fault: 'none', mode: 'warm' });
    if (!r) continue;
    const tr = productTrace(r);
    traceRuns.push({ variant, dataset, r, tr });
    const productDb = tr.events.filter((e) => e.kind === 'db' && e.service === 'product').length;
    n1.push(`| ${variant} | ${dataset} | \`${r.rid}\` | ${tr.outs.length} | ${productDb} | ${r.cache_hits} | ${tr.peak} | ${tr.total?.toFixed(1) ?? '–'} | ${r.t_data_ms} |`);
  }
}
for (const { variant, dataset, r, tr } of traceRuns) {
  n1.push('', `## ${variant} · ${dataset} (rid \`${r.rid}\`)`, '');
  const lines = tr.outs.map((e, i) => `${String(i + 1).padStart(3)}  +${(e.ts - tr.t0).toFixed(2).padStart(8)} ms  ${e.durationMs.toFixed(2).padStart(7)} ms  ${e.status ?? 'ERR'}  GET ${e.path}`);
  const body = ['  #   bắt đầu        thời lượng  status  request', ...lines].join('\n');
  n1.push(lines.length > 40 ? `<details><summary>${lines.length} call tới Product Service (bấm để mở)</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>` : `\`\`\`\n${body}\n\`\`\``);
}
fs.writeFileSync(path.join(TRACE_DIR, 'graphql-n-plus-1.md'), n1.join('\n') + '\n');

// ---------- Call graph nội bộ (BFF) ----------
const PARTICIPANT = { browser: 'Browser', bff: 'BFF', user: 'User Service', order: 'Order Service', product: 'Product Service' };
const cg = ['# Call graph nội bộ của BFF', '', `Tự sinh bởi scripts/waterfall.js từ log \`${session.logDir}\` (lần warm có t_data gần median, dataset small). Mốc thời gian tính từ lúc BFF nhận request.`, ''];
for (const client of ['web', 'mobile']) {
  const r = medianRun({ variant: 'bff', client, dataset: 'small', throttle: 'none', fault: 'none', mode: 'warm' });
  if (!r) continue;
  const events = eventsByRid.get(r.rid) ?? [];
  const root = events.find((e) => e.kind === 'http-in' && e.service === 'bff');
  const t0 = root.ts;
  const rel = (e) => (e.ts - t0).toFixed(2);
  const seqLines = ['sequenceDiagram', '  participant B as Browser', '  participant F as BFF', '  participant U as User Service', '  participant O as Order Service', '  participant P as Product Service'];
  const short = { user: 'U', order: 'O', product: 'P' };
  seqLines.push(`  B->>F: GET ${stripRid(root.path)} (+0.00 ms)`);
  const outs = events.filter((e) => e.kind === 'http-out' && e.service === 'bff');
  const call = (e, indent) => {
    const db = events.filter((x) => x.kind === 'db' && x.service === e.target && x.ts >= e.ts && x.ts <= e.ts + e.durationMs).length;
    seqLines.push(`${indent}F->>${short[e.target]}: GET ${shorten(e.path, 48)} (+${rel(e)} ms)`);
    seqLines.push(`${indent}${short[e.target]}-->>F: ${e.status ?? 'timeout'} sau ${e.durationMs.toFixed(2)} ms, ${db} DB query`);
  };
  // User và Order chạy song song (Promise.allSettled), Product chạy sau khi có danh sách đơn.
  const parallel = outs.filter((e) => e.target !== 'product');
  if (parallel.length > 1) {
    parallel.forEach((e, i) => {
      seqLines.push(`  ${i === 0 ? 'par' : 'and'} ${PARTICIPANT[e.target]}`);
      call(e, '    ');
    });
    seqLines.push('  end');
  } else parallel.forEach((e) => call(e, '  '));
  outs.filter((e) => e.target === 'product').forEach((e) => call(e, '  '));
  const done = events.find((e) => e.kind === 'http-done' && e.service === 'bff' && e.seq === root.seq);
  seqLines.push(`  F-->>B: ${done.status} (tổng ${done.durationMs.toFixed(2)} ms ở BFF)`);
  const table = events.map((e) => `| +${rel(e)} | ${e.service} | ${e.kind} | ${esc(stripRid(e.path ?? '') || shorten(e.sql ?? '', 90)).replace(/\|/g, '\\|').replace(/\n\s*/g, ' ')} | ${e.durationMs != null ? e.durationMs.toFixed(2) : ''} |`);
  cg.push(`## BFF ${client} (rid \`${r.rid}\`, t_data ${r.t_data_ms} ms)`, '', '```mermaid', ...seqLines, '```', '', '| t (ms) | service | sự kiện | chi tiết | thời lượng (ms) |', '|---|---|---|---|---|', ...table, '');
}
fs.writeFileSync(path.join(TRACE_DIR, 'bff-call-graph.md'), cg.join('\n') + '\n');

console.log('Đã ghi results/waterfall/*.svg, results/waterfall/README.md, results/traces/graphql-n-plus-1.md, results/traces/bff-call-graph.md');
