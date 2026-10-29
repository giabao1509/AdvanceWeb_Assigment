import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config, modeFromEnv, hasScope } from '../shared/config.js';
import { database, audit, events } from '../shared/db.js';
import { hash, random, equal } from '../shared/crypto.js';
import { server } from '../shared/http.js';

const c = config(modeFromEnv()), db = database(c, 'wallet'), revoked = database(c, 'revocations', true);
const app = await server(c, 'Wallet API'), jwks = createRemoteJWKSet(new URL(`${c.as}/.well-known/jwks.json`));
app.get('/internal/events', (q, r) => {
  if (!equal(String(q.headers['x-client-secret'] || ''), c.clients['taxi-web'])) return r.code(401).send({ error: 'invalid_client' });
  return events(db);
});

async function authorize(q: any, r: any, scope: string, user: boolean): Promise<JWTPayload | null> {
  let payload: JWTPayload;
  try {
    if (!q.headers.authorization?.startsWith('Bearer ')) throw new Error();
    const result = await jwtVerify(q.headers.authorization.slice(7), jwks, { issuer: c.as, audience: 'wallet-api', algorithms: ['ES256'], requiredClaims: ['sub', 'exp', 'iat', 'jti', 'client_id', 'scope', 'principal_type', 'grant_id'] });
    payload = result.payload;
    if (typeof payload.sub !== 'string' || typeof payload.scope !== 'string' || typeof payload.client_id !== 'string' || typeof payload.grant_id !== 'string' || !['user', 'client'].includes(String(payload.principal_type))) throw new Error();
  } catch {
    audit(db, 'Wallet API', `${q.method} ${q.routeOptions.url}`, 401, { error: 'invalid_token' });
    r.header('WWW-Authenticate', 'Bearer error="invalid_token"').code(401).send({ error: 'invalid_token' }); return null;
  }
  try {
    if (c.mode === 'secure' && revoked.prepare('SELECT 1 FROM revoked_grants WHERE grant_id=?').get(payload.grant_id as string)) {
      audit(db, 'Wallet API', 'Token đã bị thu hồi do replay', 401, { error: 'invalid_token' });
      r.header('WWW-Authenticate', 'Bearer error="invalid_token"').code(401).send({ error: 'invalid_token' }); return null;
    }
  } catch { r.code(503).send({ error: 'revocation_store_unavailable' }); return null; }
  if (!hasScope(payload.scope as string, scope) || (user && payload.principal_type !== 'user')) {
    audit(db, 'Wallet API', `${q.method} ${q.routeOptions.url}`, 403, { error: 'insufficient_scope', required: scope, principal_type: payload.principal_type });
    r.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`).code(403).send({ error: 'insufficient_scope', required_scope: scope, requires_user: user }); return null;
  }
  return payload;
}
app.get('/wallet/balance', async (q, r) => {
  const p = await authorize(q, r, 'wallet:read', true); if (!p) return;
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(p.sub!) as any;
  if (!wallet) return r.code(404).send({ error: 'wallet_not_found' });
  const result = { user: p.sub, balance: wallet.balance, currency: 'VND' };
  audit(db, 'Wallet API', 'Đọc số dư', 200, result); return result;
});
app.get('/wallet/charges', async (q, r) => {
  const p = await authorize(q, r, 'wallet:read', true); if (!p) return;
  const charges = db.prepare('SELECT id,amount,trip_id,at FROM charges WHERE user_id=? AND client_id=? ORDER BY at DESC').all(p.sub!, p.client_id as string);
  return { user: p.sub, charge_count: charges.length, charges };
});
app.get('/public/rates', async (q, r) => {
  const p = await authorize(q, r, 'rates:read', false); if (!p) return;
  const result = { currency: 'VND', base_fare: 15000, per_km: 12000, principal_type: p.principal_type };
  audit(db, 'Wallet API', 'M2M đọc bảng giá', 200, result); return result;
});
app.post('/wallet/charges', { schema: { body: { type: 'object', additionalProperties: false, required: ['amount', 'trip_id'], properties: { amount: { type: 'integer', minimum: 1, maximum: 10000000 }, trip_id: { type: 'string', minLength: 1, maxLength: 100 } } } } }, async (q, r) => {
  const p = await authorize(q, r, 'wallet:charge', true); if (!p) return;
  const key = q.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key)) return r.code(400).send({ error: 'invalid_idempotency_key' });
  const body = q.body as { amount: number; trip_id: string }, fingerprint = hash(JSON.stringify([body.amount, body.trip_id]));
  const result = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM charges WHERE user_id=? AND client_id=? AND idempotency_key=?').get(p.sub!, p.client_id as string, key) as any;
    if (existing) return existing.request_hash === fingerprint ? { status: 200, data: { charge_id: existing.id, amount: existing.amount, trip_id: existing.trip_id, duplicate: true } } : { status: 409, data: { error: 'idempotency_conflict' } };
    const changed = db.prepare('UPDATE wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(body.amount, p.sub!, body.amount);
    if (!changed.changes) return { status: 409, data: { error: 'insufficient_funds' } };
    const id = random();
    db.prepare('INSERT INTO charges VALUES(?,?,?,?,?,?,?,?)').run(id, p.sub!, p.client_id as string, body.amount, body.trip_id, key, fingerprint, new Date().toISOString());
    return { status: 201, data: { charge_id: id, amount: body.amount, trip_id: body.trip_id, duplicate: false } };
  }).immediate();
  const counter = (db.prepare('SELECT COUNT(*) n FROM charges').get() as any).n;
  audit(db, 'Wallet API', 'Thanh toán chuyến đi', result.status, { ...result.data, charge_count: counter });
  return r.code(result.status).send({ ...result.data, charge_count: counter });
});
await app.listen({ port: c.ports.api, host: '127.0.0.1' });
console.log(`[${c.mode}] Wallet API ${c.api}`);
let closing = false;
function shutdown() { if (closing) return; closing = true; void app.close().then(() => { db.close(); revoked.close(); process.exit(0); }); }
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
