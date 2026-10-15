import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config, url } from '../shared/config.js';
import type { WorkerCommand, WorkerHttpExchange, WorkerMessage, WorkerState } from '../shared/process-messages.js';

type WorkerName = 'baseline-order' | 'baseline-inventory' | 'secure-order' | 'secure-inventory';

interface WorkerDefinition { name: WorkerName; relativePath: string; port: number }
interface WorkerRuntime {
  definition: WorkerDefinition;
  process: ChildProcess;
  state?: WorkerState;
  startedAt: string;
}

const definitions: WorkerDefinition[] = [
  { name: 'baseline-inventory', relativePath: '../baseline/inventory/main', port: config.ports.baselineInventory },
  { name: 'baseline-order', relativePath: '../baseline/order/main', port: config.ports.baselineOrder },
  { name: 'secure-inventory', relativePath: '../secure/inventory/main', port: config.ports.secureInventory },
  { name: 'secure-order', relativePath: '../secure/order/main', port: config.ports.secureOrder },
];

export class ProcessManager {
  private readonly workers = new Map<WorkerName, WorkerRuntime>();
  private readonly logs: Array<{ at: string; process: string; stream: string; line: string }> = [];
  private readonly listeners = new Set<(entry: ProcessManager['logs'][number]) => void>();
  private readonly httpExchangeWaiters = new Map<string, Array<(exchange: WorkerHttpExchange) => void>>();
  private readonly logFile: string;
  private stopping = false;

  constructor() {
    const logDir = join(config.evidenceDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    this.logFile = join(logDir, 'runtime.jsonl');
  }

  private emit(processName: string, stream: string, chunk: Buffer | string) {
    for (const rawLine of String(chunk).split(/\r?\n/).filter(Boolean)) {
      const line = rawLine
        .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
        .replace(/refresh_token=[^;\s"']+/gi, 'refresh_token=[REDACTED]');
      const entry = { at: new Date().toISOString(), process: processName, stream, line };
      this.logs.push(entry);
      appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
      if (this.logs.length > 1000) this.logs.shift();
      for (const listener of this.listeners) listener(entry);
    }
  }

  private spawnWorker(definition: WorkerDefinition): WorkerRuntime {
    const currentFile = fileURLToPath(import.meta.url);
    const isTypeScript = currentFile.endsWith('.ts');
    const workerPath = resolve(dirname(currentFile), `${definition.relativePath}.${isTypeScript ? 'ts' : 'js'}`);
    const child = fork(workerPath, [], {
      silent: true,
      execArgv: isTypeScript ? ['--import', 'tsx'] : [],
      env: { ...process.env, WORKER_NAME: definition.name },
    });
    const runtime: WorkerRuntime = { definition, process: child, startedAt: new Date().toISOString() };
    child.stdout?.on('data', (chunk) => this.emit(definition.name, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => this.emit(definition.name, 'stderr', chunk));
    child.on('message', (message: WorkerMessage) => {
      if (message?.type === 'state') runtime.state = message as WorkerState;
      if (message?.type === 'http-exchange') {
        const waiters = this.httpExchangeWaiters.get(message.traceId);
        const waiter = waiters?.shift();
        if (waiter) {
          if (!waiters?.length) this.httpExchangeWaiters.delete(message.traceId);
          waiter(message);
        }
      }
    });
    child.on('exit', (code, signal) => {
      this.emit(definition.name, 'supervisor', `exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.workers.delete(definition.name);
      if (!this.stopping) {
        const replacement = this.spawnWorker(definition);
        this.workers.set(definition.name, replacement);
      }
    });
    return runtime;
  }

  async startAll(): Promise<void> {
    for (const definition of definitions) this.workers.set(definition.name, this.spawnWorker(definition));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const states = await Promise.all(definitions.map(async (definition) => {
        try { return (await fetch(url(definition.port, '/health'))).ok; } catch { return false; }
      }));
      if (states.every(Boolean)) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    throw new Error('Workers did not become healthy within 15 seconds');
  }

  send(name: WorkerName, command: WorkerCommand): void {
    this.workers.get(name)?.process.send?.(command);
  }

  sendAll(command: WorkerCommand): void {
    for (const runtime of this.workers.values()) runtime.process.send?.(command);
  }

  async statuses() {
    return Promise.all(definitions.map(async (definition) => {
      const runtime = this.workers.get(definition.name);
      let health: unknown = { status: 'down' };
      try { health = await (await fetch(url(definition.port, '/health'))).json(); } catch { /* reported as down */ }
      return {
        name: definition.name,
        pid: runtime?.process.pid ?? null,
        port: definition.port,
        startedAt: runtime?.startedAt,
        state: runtime?.state,
        health,
      };
    }));
  }

  recentLogs() { return [...this.logs]; }

  subscribe(listener: (entry: ProcessManager['logs'][number]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForHttpExchange(traceId: string, timeoutMs = 5_000): Promise<WorkerHttpExchange> {
    return new Promise((resolvePromise, rejectPromise) => {
      const waiters = this.httpExchangeWaiters.get(traceId) ?? [];
      const onExchange = (exchange: WorkerHttpExchange) => {
        clearTimeout(timer);
        resolvePromise(exchange);
      };
      const timer = setTimeout(() => {
        const current = this.httpExchangeWaiters.get(traceId) ?? [];
        const index = current.indexOf(onExchange);
        if (index >= 0) current.splice(index, 1);
        if (!current.length) this.httpExchangeWaiters.delete(traceId);
        rejectPromise(new Error(`Timed out waiting for internal HTTP exchange ${traceId}`));
      }, timeoutMs);
      waiters.push(onExchange);
      this.httpExchangeWaiters.set(traceId, waiters);
    });
  }

  async waitForWorkerState(name: WorkerName, matches: (state: WorkerState | undefined) => boolean, timeoutMs = 3_000): Promise<WorkerState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.workers.get(name)?.state;
      if (matches(state) && state) return state;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error(`Timed out waiting for ${name} state update`);
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    const exits = [...this.workers.values()].map((runtime) => new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => { runtime.process.kill('SIGKILL'); resolvePromise(); }, 3000);
      runtime.process.once('exit', () => { clearTimeout(timer); resolvePromise(); });
      runtime.process.kill('SIGTERM');
    }));
    await Promise.all(exits);
  }
}
