import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config, url } from '../../shared/config.js';
import { loginSchema, orderSchema, unauthorized } from '../../shared/contracts.js';
import { createLoggerOptions, jsonFetch, registerCommonHooks } from '../../shared/http.js';
import { openSecureOrder, resetSecureOrder } from '../../shared/database.js';
import {
  createSignature,
  loadPrivateKey,
  signatureHeaders,
  type SigningAlgorithm,
} from '../../shared/signing.js';
import type { WorkerCommand } from '../../shared/process-messages.js';

interface UserRow { id: string; username: string; passwordHash: string }
interface RefreshRow {
  id: string;
  tokenHash: string;
  familyId: string;
  userId: string;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

const app = Fastify({ logger: createLoggerOptions('secure-order') });
const db = openSecureOrder();
await app.register(cookie);
registerCommonHooks(app);

const jwtKey = config.jwtSecret();
const hmacKey = config.hmacSecret();
const privateKeys = new Map<string, KeyObject>([
  ['ed-1', loadPrivateKey(config.privateKeyPath('ed-1'))],
  ['ed-2', loadPrivateKey(config.privateKeyPath('ed-2'))],
]);
let activeAlgorithm: SigningAlgorithm = 'hmac-sha256';
let activeSigningKid: 'ed-1' | 'ed-2' = 'ed-1';
const dummyPasswordHash = bcrypt.hashSync('not-the-password', config.bcryptCost);

const state = () => ({
  type: 'state' as const,
  service: 'secure-order',
  activeAlgorithm,
  activeSigningKid: activeAlgorithm === 'ed25519' ? activeSigningKid : 'hmac-lab-1',
});

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

const issueAccessToken = async (user: UserRow, ttl = config.accessTtl): Promise<string> =>
  new SignJWT({ username: user.username })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(jwtKey);

const verifyAccessToken = async (request: FastifyRequest): Promise<{ sub: string; username: string } | null> => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  try {
    const result = await jwtVerify(authorization.slice(7), jwtKey, {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
    });
    if (!result.payload.sub || typeof result.payload.username !== 'string') return null;
    return { sub: result.payload.sub, username: result.payload.username };
  } catch (error) {
    request.log.warn({ event: 'ACCESS_JWT_REJECTED', reason: error instanceof Error ? error.name : 'INVALID_JWT' });
    return null;
  }
};

const setRefreshCookie = (reply: FastifyReply, token: string) => {
  reply.setCookie('refresh_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/auth',
    secure: process.env.NODE_ENV === 'production',
    maxAge: config.refreshTtl,
  });
};

const clearRefreshCookie = (reply: FastifyReply) => {
  reply.clearCookie('refresh_token', { path: '/auth' });
};

const originAllowed = (request: FastifyRequest): boolean => {
  const origin = request.headers.origin;
  return !origin || (typeof origin === 'string' && config.origins.includes(origin));
};

const createRefreshFamily = (userId: string): string => {
  const raw = newRefreshToken();
  const now = Date.now();
  db.prepare(`INSERT INTO refresh_tokens
    (id, token_hash, family_id, user_id, expires_at, consumed_at, revoked_at, replaced_by, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
    .run(randomUUID(), tokenHash(raw), randomUUID(), userId, now + config.refreshTtl * 1000, now);
  return raw;
};

const rotateRefresh = db.transaction((rawToken: string) => {
  const now = Date.now();
  const row = db.prepare(`SELECT id, token_hash AS tokenHash, family_id AS familyId, user_id AS userId,
    expires_at AS expiresAt, consumed_at AS consumedAt, revoked_at AS revokedAt
    FROM refresh_tokens WHERE token_hash = ?`).get(tokenHash(rawToken)) as RefreshRow | undefined;
  if (!row) return { status: 'invalid' as const };
  if (row.consumedAt !== null) {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now, row.familyId);
    return { status: 'reuse' as const };
  }
  if (row.revokedAt !== null || row.expiresAt <= now) return { status: 'invalid' as const };
  const nextRaw = newRefreshToken();
  const nextId = randomUUID();
  db.prepare(`INSERT INTO refresh_tokens
    (id, token_hash, family_id, user_id, expires_at, consumed_at, revoked_at, replaced_by, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
    .run(nextId, tokenHash(nextRaw), row.familyId, row.userId, now + config.refreshTtl * 1000, now);
  db.prepare('UPDATE refresh_tokens SET consumed_at = ?, replaced_by = ? WHERE id = ? AND consumed_at IS NULL')
    .run(now, nextId, row.id);
  return { status: 'ok' as const, raw: nextRaw, userId: row.userId, familyId: row.familyId };
});

app.get('/health', async () => ({ status: 'ok', ...state() }));

app.post('/auth/login', async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(401).send(unauthorized);
  const user = db.prepare('SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?')
    .get(parsed.data.username) as UserRow | undefined;
  const matches = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? dummyPasswordHash);
  if (!user || !matches) return reply.code(401).send(unauthorized);
  const refreshToken = createRefreshFamily(user.id);
  setRefreshCookie(reply, refreshToken);
  return { accessToken: await issueAccessToken(user), tokenType: 'Bearer', expiresIn: config.accessTtl };
});

app.post('/auth/refresh', async (request, reply) => {
  if (!originAllowed(request)) return reply.code(403).send({ code: 'FORBIDDEN' });
  const raw = request.cookies.refresh_token;
  if (!raw) return reply.code(401).send(unauthorized);
  const rotated = rotateRefresh(raw);
  if (rotated.status !== 'ok') {
    clearRefreshCookie(reply);
    request.log.warn({ event: 'REFRESH_REJECTED', reason: rotated.status === 'reuse' ? 'TOKEN_REUSE' : 'INVALID_TOKEN' });
    return reply.code(401).send(unauthorized);
  }
  const user = db.prepare('SELECT id, username, password_hash AS passwordHash FROM users WHERE id = ?')
    .get(rotated.userId) as UserRow;
  setRefreshCookie(reply, rotated.raw);
  return { accessToken: await issueAccessToken(user), tokenType: 'Bearer', expiresIn: config.accessTtl };
});

app.post('/auth/logout', async (request, reply) => {
  if (!originAllowed(request)) return reply.code(403).send({ code: 'FORBIDDEN' });
  const raw = request.cookies.refresh_token;
  if (raw) {
    const row = db.prepare('SELECT family_id AS familyId FROM refresh_tokens WHERE token_hash = ?')
      .get(tokenHash(raw)) as { familyId: string } | undefined;
    if (row) db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(Date.now(), row.familyId);
  }
  clearRefreshCookie(reply);
  return reply.code(204).send();
});

app.get('/auth/me', async (request, reply) => {
  const identity = await verifyAccessToken(request);
  if (!identity) return reply.code(401).send(unauthorized);
  return identity;
});

app.post('/orders', async (request, reply) => {
  const identity = await verifyAccessToken(request);
  if (!identity) return reply.code(401).send(unauthorized);
  const parsed = orderSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
  const orderId = randomUUID();
  const reservationBody = { ...parsed.data, orderId };
  const kid = activeAlgorithm === 'hmac-sha256' ? 'hmac-lab-1' : activeSigningKid;
  const key = activeAlgorithm === 'hmac-sha256' ? hmacKey : privateKeys.get(activeSigningKid)!;
  const signature = createSignature(reservationBody, activeAlgorithm, kid, key);
  const inventory = await jsonFetch<{ reservationId?: string; code?: string }>(
    url(config.ports.secureInventory, '/internal/reservations'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-trace-id': request.id,
        ...signatureHeaders(signature),
      },
      body: JSON.stringify(reservationBody),
    },
  );
  process.send?.({
    type: 'http-exchange', traceId: request.id,
    request: {
      method: 'POST', url: url(config.ports.secureInventory, '/internal/reservations'),
      headers: {
        'content-type': 'application/json', 'x-trace-id': request.id,
        'x-signature-alg': signature.algorithm, 'x-key-id': signature.kid,
        'x-timestamp': signature.timestamp, 'x-nonce': signature.nonce, 'x-signature': '[REDACTED]',
      },
      body: reservationBody,
    },
    response: { status: inventory.status, body: inventory.body },
  });
  if (inventory.status !== 201 || !inventory.body.reservationId) {
    return reply.code(inventory.status === 409 ? 409 : inventory.status === 401 ? 502 : 502)
      .send(inventory.status === 409 ? inventory.body : { code: 'INVENTORY_AUTH_FAILED' });
  }
  db.prepare('INSERT INTO orders(id, user_id, sku, quantity, reservation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orderId, identity.sub, parsed.data.sku, parsed.data.quantity, inventory.body.reservationId, Date.now());
  return reply.code(201).send({ orderId, reservationId: inventory.body.reservationId });
});

process.on('message', (message: WorkerCommand) => {
  if (message.type === 'reset') resetSecureOrder(db);
  if (message.type === 'set-signing') {
    activeAlgorithm = message.algorithm;
    if (message.kid) activeSigningKid = message.kid;
  }
  process.send?.(state());
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(0), 2_000);
  void app.close().finally(() => {
    try { db.close(); } catch { /* process is exiting */ }
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.ports.secureOrder });
process.send?.(state());
