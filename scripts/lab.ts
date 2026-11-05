import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Mode, Order, Reservation, Payment, LedgerEntry, Stock } from '../src/shared/types.js';
import { buildUI } from './build-ui.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export type Service = 'order' | 'inventory' | 'payment';
export interface LabEvent { time: string; service: string; event: string; orderId?: string; mode?: Mode; operationId?: string; pid?: number; [key: string]: unknown }
export interface Snapshot {
  order: Order;
  inventory: { available: boolean; data: { reservation: Reservation | null; stock: Stock[] } | null; error: string | null };
  payment: { available: boolean; data: { payment: Payment | null; ledger: LedgerEntry[] } | null; error: string | null };
  capturedAt: string;
}

export async function waitFor<T>(fn: () => Promise<T | false> | T | false, timeout = 15000, label = 'condition'): Promise<T> {
  const end = Date.now() + timeout;
  let lastError: unknown;
  do {
    try { const value = await fn(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(80);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

export class Lab {
  children = new Map<Service, ChildProcess>();
  events: LabEvent[] = [];
  stderr: string[] = [];
  env: NodeJS.ProcessEnv;
  listeners = new Set<(event: LabEvent) => void>();
  closeUI?: () => Promise<void>;
  constructor(public directory: string, public ports: Record<Service | 'ui', number>, options: NodeJS.ProcessEnv = {}, public echo = false) {
    this.env = { ...process.env, ORDER_PORT: String(ports.order), INVENTORY_PORT: String(ports.inventory), PAYMENT_PORT: String(ports.payment),
      INVENTORY_URL: `http://127.0.0.1:${ports.inventory}`, PAYMENT_URL: `http://127.0.0.1:${ports.payment}`,
      UI_PORT: String(ports.ui), DATA_DIR: join(directory, 'data'), LOG_DIR: join(directory, 'logs'), HTTP_TIMEOUT_MS: '700', RECOVERY_INTERVAL_MS: '250', SAGA_MAX_RETRIES:'3', F4_DOWNTIME_MS:'4000',ENABLE_FAULTS: 'true', AUTO_KILL_MARKERS: 'false', ...options };
  }
  publish(entry: LabEvent) { this.events.push(entry); for (const listener of this.listeners) listener(entry); }
  url(service: Service | 'ui' = 'ui') { return `http://127.0.0.1:${this.ports[service]}`; }
  async start(service: Service) {
    const existing = this.children.get(service);
    if (existing && existing.exitCode === null && existing.signalCode === null) return existing;
    const child = spawn(process.execPath, ['--import', 'tsx', `src/${service}/server.ts`], { cwd: root, env: this.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    this.children.set(service, child);
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      if (this.echo) process.stdout.write(chunk);
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop()!;
      for (const line of lines) { try { this.publish(JSON.parse(line) as LabEvent); } catch {} }
    });
    child.stderr!.on('data', (chunk: Buffer) => { this.stderr.push(chunk.toString()); if (this.echo) process.stderr.write(chunk); });
    child.on('error', error => this.stderr.push(String(error)));
    child.once('exit', (code, signal) => this.publish({ time: new Date().toISOString(), service, event: 'PROCESS_EXITED', pid: child.pid, code, signal }));
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`${service} exited ${child.exitCode}: ${this.stderr.join('')}`);
      const r = await fetch(`${this.url(service)}/health`, { signal: AbortSignal.timeout(500) });
      const health = await r.json() as { pid: number };
      return r.ok && health.pid === child.pid;
    }, 15000, `${service} readiness`);
    return child;
  }
  async startAll() {
    await this.start('inventory'); await this.start('payment'); await this.start('order');
    buildUI();
    const { startUI } = await import('./ui-server.js');
    this.closeUI = await startUI(this);
    return this;
  }
  async stop(service: Service, force = true) {
    const child = this.children.get(service);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    if (!force && child.connected) child.send({ type: 'shutdown' }); else child.kill('SIGKILL');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2500);
    await exited;
    clearTimeout(deadline);
    this.publish({ time: new Date().toISOString(), service, event: force ? 'PROCESS_KILLED' : 'PROCESS_STOPPED', pid: child.pid });
  }
  async close() { await this.closeUI?.(); this.closeUI = undefined; for (const service of ['order', 'payment', 'inventory'] as const) await this.stop(service, false); }
  async request<T>(mode: Mode, path: string, options: RequestInit = {}, service: Service = 'order'): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.url(service)}/api/${mode}${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(6000) });
    return { status: response.status, body: await response.json() as T };
  }
  async create(mode: Mode, scenario = 'H', key: string = crypto.randomUUID(), quantity = 1) {
    return this.request<{ order: Order; replayed: boolean; saga_id: string }>(mode, '/orders', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ sku: 'LAMP-01', quantity, scenario }) });
  }
  async settled(mode: Mode, id: string, timeout = 15000): Promise<Snapshot> {
    await waitFor(async () => { const { body } = await this.request<{ order: Order }>(mode, `/orders/${id}`); return body.order.step === 'DONE'; }, timeout, `order ${id} terminal`);
    return (await this.request<Snapshot>(mode, `/orders/${id}/snapshot`)).body;
  }
  async marker(type: string, id: string) { return waitFor(() => this.events.find(e => e.event === type && e.orderId === id) || false, 15000, type); }
  continueRecovery(){
    const child=this.children.get('order');
    if(!child?.connected)throw new Error('Order IPC is not connected');
    child.send({type:'continue-recovery'});
  }
}

export async function isolatedLab(prefix = 'test', options: NodeJS.ProcessEnv = {}): Promise<Lab> {
  const base = resolve(root, '.local');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, `${prefix}-`));
  const chosen = new Set<number>();
  while (chosen.size < 4) chosen.add(await freePort());
  const [order, inventory, payment, ui] = [...chosen];
  return new Lab(directory, { order, inventory, payment, ui }, options);
}
