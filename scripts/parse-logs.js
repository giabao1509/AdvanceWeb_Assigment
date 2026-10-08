// In số đếm và timeline của một lần tải màn hình theo rid (decisions.md mục 5.2).
//   node scripts/parse-logs.js <rid hoặc 8 ký tự đầu> [thư mục log, mặc định logs/dev]
//   node scripts/parse-logs.js --last [thư mục log]   -> rid mới nhất có http-in ở BFF/GraphQL/User
import path from 'node:path';
import { ROOT } from '../shared/config.js';
import { countEvents, readAllEvents } from './logs.js';

const [query, dir = 'logs/dev'] = process.argv.slice(2);
if (!query) {
  console.log('Dùng: node scripts/parse-logs.js <rid|prefix|--last> [logDir]');
  process.exit(1);
}

const byRid = readAllEvents(path.resolve(ROOT, dir));
let rid;
if (query === '--last') {
  const entries = [...byRid.entries()].filter(([, evs]) => evs.some((e) => e.kind === 'http-in' && e.method !== 'OPTIONS'));
  rid = entries.sort(([, a], [, b]) => b[0].ts - a[0].ts)[0]?.[0];
} else {
  const matches = [...byRid.keys()].filter((r) => r.startsWith(query));
  if (matches.length > 1) {
    console.log(`Prefix "${query}" khớp ${matches.length} rid, hãy nhập dài hơn.`);
    process.exit(1);
  }
  rid = matches[0];
}
if (!rid) {
  console.log(`Không thấy rid "${query}" trong ${dir}.`);
  process.exit(1);
}

const events = byRid.get(rid);
const t0 = events[0].ts;
console.log(`rid ${rid} · ${events.length} sự kiện · ${dir}\n`);
console.log(countEvents(events));
console.log('\n     t (ms)  service   sự kiện    chi tiết');
for (const e of events) {
  const detail =
    e.kind === 'db'
      ? e.sql.replace(/\s+/g, ' ').slice(0, 90)
      : e.kind === 'http-out'
        ? `→ ${e.target} ${e.path} ${e.status ?? (e.timedOut ? 'TIMEOUT' : 'ERR')} ${e.durationMs} ms`
        : e.kind === 'http-done'
          ? `${e.method} ${e.path} → ${e.status} ${e.durationMs} ms${e.aborted ? ' (aborted)' : ''}`
          : e.kind === 'http-in'
            ? `${e.method} ${e.path}`
            : JSON.stringify({ ...e, ts: undefined, rid: undefined, service: undefined, kind: undefined });
  console.log(`${(e.ts - t0).toFixed(2).padStart(11)}  ${e.service.padEnd(8)}  ${e.kind.padEnd(9)}  ${detail}`);
}
