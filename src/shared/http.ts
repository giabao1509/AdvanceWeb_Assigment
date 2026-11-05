import express from 'express';
import type { Express, ErrorRequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { Mode, Operation, Command, HttpResult } from './types.js';
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config, modes } from './config.js';
import { randomUUID } from 'node:crypto';

export function event(service: string, type: string, fields: Record<string, unknown> = {}) {
  const entry = { time: new Date().toISOString(), service, event: type, ...fields };
  mkdirSync(config.logDir, { recursive: true });
  appendFileSync(join(config.logDir, `${service}.jsonl`), `${JSON.stringify(entry)}\n`);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function createApp(service: string, database: DatabaseSync) {
  const app = express();
  app.locals.instanceId=randomUUID();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (req, res) => res.json({ service, status: 'ok', pid: process.pid, instanceId:app.locals.instanceId }));
  app.use('/api/:mode', (req, res, next) => {
    if (!modes.includes(req.params.mode as Mode)) return res.status(400).json({ error: 'INVALID_MODE' });
    req.mode = req.params.mode as Mode;
    req.db = database;
    next();
  });
  return app;
}

export function participantReads(app: Express, state: (db: DatabaseSync, orderId: string) => unknown) {
  app.get('/api/:mode/operations/:operationId', (req, res) => {
    const op = req.db.prepare('SELECT * FROM operations WHERE id=?').get(req.params.operationId) as Operation | undefined;
    if (!op) return res.status(404).json({ error: 'OPERATION_NOT_FOUND', instanceId:app.locals.instanceId });
    res.json({ operationId: op.id, status: op.status, action: op.action, httpStatus: op.http_status, result: JSON.parse(op.result), createdAt: op.created_at, instanceId:app.locals.instanceId });
  });
  app.get('/api/:mode/orders/:orderId/state', (req, res) => res.json(state(req.db, req.params.orderId)));
}

export function serve(app: Express, service: string, port: number, database: DatabaseSync, cleanup = () => {}) {
  const errors: ErrorRequestHandler = (err, req, res, next) => {
    event(service, 'REQUEST_ERROR', { message: err.message });
    res.status(err.status || 500).json({ error: err.status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR' });
  };
  app.use(errors);
  const runtimeDir = join(config.dataDir, '.runtime');
  const runtimeFile = join(runtimeDir, `${service}.json`);
  const server = app.listen(port, '127.0.0.1', (error?: Error) => {
    if (error) return;
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, port, service }));
    event(service, 'READY', { port, pid: process.pid });
  });
  server.on('error', error => { console.error(error); process.exit(1); });
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    cleanup();
    server.close(() => { database.close(); rmSync(runtimeFile, { force: true }); process.exit(0); });
    setTimeout(() => process.exit(0), 2500).unref();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('disconnect', shutdown);
  process.on('message', message => { if ((message as { type?: string })?.type === 'shutdown') shutdown(); });
  return server;
}

export async function jsonRequest(url: string, options: RequestInit = {}, timeout = config.timeout): Promise<HttpResult> {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json', ...options.headers } });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: null, body: null, error: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}

export function validCommand(value: unknown): value is Command {
  const body = value as Command | null;
  return !!body && typeof body.operationId === 'string' && body.operationId.length > 0 && body.operationId.length <= 200
    && typeof body.orderId === 'string' && body.orderId.length > 0 && body.orderId.length <= 100;
}
