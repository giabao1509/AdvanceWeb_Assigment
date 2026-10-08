// Correlation id theo request (AsyncLocalStorage) và log JSON lines (D16).
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

export const als = new AsyncLocalStorage();

let stream = null;
let serviceName = 'unknown';

export function initLogger(name) {
  serviceName = name;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  stream = fs.createWriteStream(path.join(LOG_DIR, `${name}.jsonl`), { flags: 'a' });
}

// Epoch ms có phần thập phân, cùng gốc thời gian với performance.timeOrigin của browser.
export const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;

export const currentRid = () => als.getStore()?.rid ?? null;

export function log({ ts, rid, ...rest }) {
  if (!stream) return;
  const record = { ts: ts ?? now(), rid: rid ?? currentRid(), service: serviceName, ...rest };
  stream.write(JSON.stringify(record) + '\n');
}
