// Khởi động / dừng / restart 5 server và client tĩnh dưới dạng child process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PORTS, ROOT } from '../shared/config.js';

export const SERVICES = [
  { name: 'user', script: 'services/user/server.js' },
  { name: 'order', script: 'services/order/server.js' },
  { name: 'product', script: 'services/product/server.js' },
  { name: 'bff', script: 'bff/server.js' },
  { name: 'graphql', script: 'graphql/server.js' },
];
const CLIENT = { name: 'client', script: 'client/server.js' };

const healthUrl = (name) => `http://localhost:${PORTS[name]}/health`;

async function isUp(name) {
  try {
    const res = await fetch(healthUrl(name), { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Hết thời gian chờ: ${label}`);
}

function spawnServer({ name, script }, env, logDir, inherit) {
  fs.mkdirSync(logDir, { recursive: true });
  const out = inherit ? 'inherit' : fs.openSync(path.join(logDir, `${name}.out.log`), 'a');
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
  child.exitPromise = new Promise((resolve) => child.once('exit', resolve));
  return child;
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await child.exitPromise;
}

export class Stack {
  constructor({ productLoader = 'batched', enableFault = true, logDir = 'logs/dev', inherit = false } = {}) {
    this.opts = { productLoader, enableFault, logDir: path.resolve(ROOT, logDir), inherit };
    this.children = [];
  }

  async start(overrides = {}) {
    Object.assign(this.opts, overrides);
    const { productLoader, enableFault, logDir, inherit } = this.opts;
    for (const s of SERVICES) {
      if (await isUp(s.name)) throw new Error(`Cổng ${PORTS[s.name]} (${s.name}) đang bận. Hãy tắt npm start trước.`);
    }
    const env = { PRODUCT_LOADER: productLoader, ENABLE_FAULT: enableFault ? '1' : '0', LOG_DIR: logDir };
    this.children = SERVICES.map((s) => spawnServer(s, env, logDir, inherit));
    try {
      // Lần khởi động đầu tiên trên Windows có thể chậm (antivirus quét node_modules), nên chờ tới 30 s.
      await Promise.all(SERVICES.map((s) => waitUntil(() => isUp(s.name), 30_000, `${s.name} /health`)));
    } catch (err) {
      await Promise.all(this.children.map(killChild));
      this.children = [];
      throw err;
    }
  }

  async stop() {
    await Promise.all(this.children.map(killChild));
    this.children = [];
    await Promise.all(SERVICES.map((s) => waitUntil(async () => !(await isUp(s.name)), 5_000, `${s.name} dừng`)));
  }

  async restart(overrides = {}) {
    await this.stop();
    await this.start(overrides);
  }
}

// Client tĩnh :5173 không thuộc phép đo cold/warm nên chỉ khởi động một lần.
export async function ensureClient({ logDir = 'logs/dev', inherit = false } = {}) {
  if (await isUp('client')) return null;
  const child = spawnServer(CLIENT, {}, path.resolve(ROOT, logDir), inherit);
  await waitUntil(() => isUp('client'), 10_000, 'client /health');
  return { stop: () => killChild(child) };
}

export async function setFault(mode, delayMs = 0) {
  const res = await fetch(`http://localhost:${PORTS.product}/__fault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, delayMs }),
  });
  if (!res.ok) throw new Error(`Không đặt được fault: ${res.status}`);
}
