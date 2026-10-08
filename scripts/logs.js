// Đọc log JSON lines của các server và đếm theo rid (decisions.md mục 5).
import fs from 'node:fs';
import path from 'node:path';
import { SERVICES } from './stack.js';

const COMPOSERS = new Set(['bff', 'graphql']);
const TARGETS = ['user', 'order', 'product'];

// Đọc tăng dần: chỉ phần mới ghi thêm kể từ lần đọc trước.
export class LogTail {
  constructor(dir) {
    this.dir = dir;
    this.offsets = new Map();
    this.partial = new Map();
    this.byRid = new Map();
  }

  poll() {
    let added = 0;
    for (const { name } of SERVICES) {
      const file = path.join(this.dir, `${name}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      const from = this.offsets.get(file) ?? 0;
      if (size <= from) continue;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      this.offsets.set(file, size);
      const text = (this.partial.get(file) ?? '') + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial.set(file, lines.pop());
      for (const line of lines) {
        if (!line) continue;
        const ev = JSON.parse(line);
        if (!ev.rid) continue;
        if (!this.byRid.has(ev.rid)) this.byRid.set(ev.rid, []);
        this.byRid.get(ev.rid).push(ev);
        added++;
      }
    }
    return added;
  }

  // Chờ tới khi log của rid ngừng tăng (stream ghi file bất đồng bộ).
  async collect(rid, { quietMs = 120, maxMs = 5000 } = {}) {
    const deadline = Date.now() + maxMs;
    let lastCount = -1;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      this.poll();
      const count = this.byRid.get(rid)?.length ?? 0;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      } else if (count > 0 && Date.now() - stableSince >= quietMs) {
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    const events = this.byRid.get(rid) ?? [];
    this.byRid.delete(rid);
    return events.sort((a, b) => a.ts - b.ts);
  }
}

// Đọc toàn bộ log của một thư mục, gom theo rid.
export function readAllEvents(dir) {
  const tail = new LogTail(dir);
  tail.poll();
  for (const list of tail.byRid.values()) list.sort((a, b) => a.ts - b.ts);
  return tail.byRid;
}

// Đếm service call, DB query, cache-hit, preflight cho một rid (mục 5.1).
export function countEvents(events) {
  const httpIn = (svc) => events.filter((e) => e.kind === 'http-in' && e.service === svc && e.method !== 'OPTIONS').length;
  const db = (svc) => events.filter((e) => e.kind === 'db' && e.service === svc).length;
  const out = (target) => events.filter((e) => e.kind === 'http-out' && COMPOSERS.has(e.service) && e.target === target).length;

  const counts = {
    user_calls: httpIn('user'),
    order_calls: httpIn('order'),
    product_calls: httpIn('product'),
    cache_hits: events.filter((e) => e.kind === 'cache-hit').length,
    user_db: db('user'),
    order_db: db('order'),
    product_db: db('product'),
    preflight: events.filter((e) => e.kind === 'http-in' && e.method === 'OPTIONS').length,
    composer_in: httpIn('bff') + httpIn('graphql'),
    timed_out: events.filter((e) => e.kind === 'http-out' && e.timedOut).length,
  };

  // Kiểm chứng mục 5.3: http-out phía composer phải bằng http-in phía service.
  const composerUsed = counts.composer_in > 0;
  const mismatches = composerUsed ? TARGETS.filter((t) => out(t) !== counts[`${t}_calls`]) : [];
  counts.count_check = mismatches.length ? `mismatch:${mismatches.join('+')}` : 'ok';
  return counts;
}
