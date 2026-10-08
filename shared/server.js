// Khung Express dùng chung: CORS, no-store, rid và log http-in/http-done (D09, D16).
import crypto from 'node:crypto';
import express from 'express';
import { CLIENT_ORIGIN, PORTS } from './config.js';
import { als, initLogger, log, now } from './context.js';

let seq = 0;

export function createApp(name) {
  initLogger(name);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': CLIENT_ORIGIN,
      'Access-Control-Expose-Headers': 'X-Partial-Response, X-Request-Id',
      'Timing-Allow-Origin': CLIENT_ORIGIN,
      Vary: 'Origin',
    });

    const rid = req.get('x-request-id') || (typeof req.query.rid === 'string' && req.query.rid) || crypto.randomUUID();
    res.set('X-Request-Id', rid);

    // /health và /__* là endpoint điều khiển, không tính vào số đo.
    const internal = req.path === '/health' || req.path.startsWith('/__');
    const id = ++seq;
    const start = now();

    als.run({ rid }, () => {
      if (!internal) {
        log({ kind: 'http-in', seq: id, method: req.method, path: req.originalUrl });
        res.on('close', () => {
          log({
            rid,
            kind: 'http-done',
            seq: id,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: Math.round((now() - start) * 1000) / 1000,
            aborted: !res.writableFinished,
          });
        });
      }

      if (req.method === 'OPTIONS') {
        res.set({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        });
        res.status(204).end();
        return;
      }
      next();
    });
  });

  app.get('/health', (req, res) => res.json({ ok: true, service: name, pid: process.pid }));
  return app;
}

export function sendError(res, httpStatus, code, message) {
  res.status(httpStatus).json({ error: { code, message } });
}

export function listen(app, name) {
  app.use((req, res) => sendError(res, 404, 'NOT_FOUND', `Không có route ${req.method} ${req.path}`));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    sendError(res, 500, 'INTERNAL', err.message);
  });
  const port = PORTS[name];
  const server = app.listen(port, (err) => {
    if (err) {
      console.error(`[${name}] không mở được cổng ${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`[${name}] listening on http://localhost:${port} (pid ${process.pid})`);
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
