import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type Database from 'better-sqlite3';
import { now, type Config } from './config.js';
import { hash, random, equal } from './crypto.js';

export async function server(c: Config, service: string) {
  const app = Fastify({ logger: { level: 'warn' }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16384,
    routerOptions: { querystringParser: raw => parseParams(raw) } });
  await app.register(cookie);
  await app.register(formbody, { parser: raw => parseParams(raw) });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'", ...(service === 'Wallet AS' ? [c.taxi] : [])], upgradeInsecureRequests: null } }, referrerPolicy: { policy: 'same-origin' } });
  await app.register(rateLimit, { global: false, max: 60, timeWindow: '1 minute' });
  app.get('/health', () => ({ ok: true, service, mode: c.mode }));
  app.setErrorHandler((error, _request, reply) => {
    const code = (error as { statusCode?: number }).statusCode;
    const status = code && code < 500 ? code : 500;
    reply.code(status).send({ error: status < 500 ? 'invalid_request' : 'server_error', message: status < 500 ? 'Request không hợp lệ.' : 'Không xử lý được yêu cầu. Kiểm tra server và thử lại.' });
  });
  return app;
}
export function parseParams(raw: string) {
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw)) {
    const old = result[key]; result[key] = old === undefined ? value : [...(Array.isArray(old) ? old : [old]), value];
  }
  return result;
}
export function params(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (Object.values(result).some(v => typeof v !== 'string')) return null;
  return result as Record<string, string>;
}
export function oauthError(reply: FastifyReply, error: string, status = 400) {
  if (error === 'invalid_client') reply.header('WWW-Authenticate', 'Basic realm="wallet-as"');
  return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').code(status).send({ error });
}
export const escape = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
export type Session = { csrf: string; user?: string; attempt?: string; [key: string]: unknown };
export function sessions(app: FastifyInstance, db: Database.Database, c: Config, service: string) {
  const name = `${c.mode}_${service}_sid`;
  const cookieOptions = { httpOnly: true, secure: false, sameSite: 'lax' as const, path: '/' };
  function create(reply: FastifyReply, data: Session) {
    const sid = random();
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(sid), JSON.stringify(data), now() + 3600);
    reply.setCookie(name, sid, { ...cookieOptions, maxAge: 3600 });
    return data;
  }
  function get(request: FastifyRequest, reply: FastifyReply): Session {
    const sid = request.cookies[name];
    const row = sid ? db.prepare('SELECT data FROM sessions WHERE id=? AND expires_at>?').get(hash(sid), now()) as any : undefined;
    return row ? JSON.parse(row.data) : create(reply, { csrf: random() });
  }
  function save(request: FastifyRequest, data: Session) {
    const sid = request.cookies[name];
    if (sid) db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(data), hash(sid));
  }
  function destroy(request: FastifyRequest, reply: FastifyReply) {
    if (request.cookies[name]) db.prepare('DELETE FROM sessions WHERE id=?').run(hash(request.cookies[name]));
    reply.clearCookie(name, cookieOptions);
  }
  function rotate(request: FastifyRequest, reply: FastifyReply, data: Session) { destroy(request, reply); return create(reply, { ...data, csrf: random() }); }
  function csrf(request: FastifyRequest, data: Session, supplied: unknown, origin: string) {
    return typeof supplied === 'string' && equal(supplied, data.csrf) && (!request.headers.origin || request.headers.origin === origin);
  }
  return { get, save, destroy, rotate, csrf };
}
