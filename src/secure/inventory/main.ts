import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID, type KeyObject } from 'node:crypto';
import { config } from '../../shared/config.js';
import { reservationSchema, unauthorized, type ReservationInput } from '../../shared/contracts.js';
import { duplicateHeader, createLoggerOptions, registerCommonHooks } from '../../shared/http.js';
import { inventoryMetrics, openSecureInventory, resetInventory } from '../../shared/database.js';
import {
  canonicalRequest,
  loadPublicKey,
  verifyEd25519,
  verifyHmac,
  type SignatureParts,
  type SigningAlgorithm,
} from '../../shared/signing.js';
import type { WorkerCommand } from '../../shared/process-messages.js';

const app = Fastify({ logger: createLoggerOptions('secure-inventory') });
const db = openSecureInventory();
registerCommonHooks(app);

let activeAlgorithm: SigningAlgorithm = 'hmac-sha256';
const trustedKeys = new Map<string, KeyObject>([['ed-1', loadPublicKey(config.publicKeyPath('ed-1'))]]);
const securityHeaders = [
  'x-auth-version',
  'x-signature-alg',
  'x-key-id',
  'x-timestamp',
  'x-nonce',
  'x-signature',
] as const;

const reject = (request: FastifyRequest, reason: string) => {
  request.log.warn({ event: 'INTERNAL_AUTH_REJECTED', reason, traceId: request.id });
  return reason;
};

const authenticate = (request: FastifyRequest, body: ReservationInput): { parts?: SignatureParts; reason?: string } => {
  if (securityHeaders.some((name) => duplicateHeader(request, name))) {
    return { reason: reject(request, 'DUPLICATE_SECURITY_HEADER') };
  }
  const version = request.headers['x-auth-version'];
  const algorithm = request.headers['x-signature-alg'];
  const kid = request.headers['x-key-id'];
  const timestamp = request.headers['x-timestamp'];
  const nonce = request.headers['x-nonce'];
  const signature = request.headers['x-signature'];
  if ([version, algorithm, kid, timestamp, nonce, signature].some((value) => typeof value !== 'string' || value.length === 0)) {
    return { reason: reject(request, 'MISSING_SIGNATURE') };
  }
  if (version !== 'v1' || (algorithm !== 'hmac-sha256' && algorithm !== 'ed25519')) {
    return { reason: reject(request, 'UNSUPPORTED_AUTH_SCHEME') };
  }
  if (algorithm !== activeAlgorithm) return { reason: reject(request, 'ALGORITHM_NOT_ALLOWED') };
  const timestampNumber = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestampNumber) || Math.abs(now - timestampNumber) > 60) {
    return { reason: reject(request, 'TIMESTAMP_OUT_OF_WINDOW') };
  }
  if (!/^[0-9a-f-]{36}$/i.test(nonce as string)) return { reason: reject(request, 'MALFORMED_NONCE') };

  const parts: SignatureParts = {
    algorithm: algorithm as SigningAlgorithm,
    kid: kid as string,
    timestamp: timestamp as string,
    nonce: nonce as string,
    signature: signature as string,
  };
  const canonical = canonicalRequest(body, parts);
  if (algorithm === 'hmac-sha256') {
    if (kid !== 'hmac-lab-1') return { reason: reject(request, 'UNKNOWN_KID') };
    if (!verifyHmac(canonical, signature as string, config.hmacSecret())) {
      return { reason: reject(request, 'BAD_SIGNATURE') };
    }
  } else {
    const publicKey = trustedKeys.get(kid as string);
    if (!publicKey) return { reason: reject(request, 'UNKNOWN_KID') };
    if (!verifyEd25519(canonical, signature as string, publicKey)) {
      return { reason: reject(request, 'BAD_SIGNATURE') };
    }
  }
  return { parts };
};

const reserveAuthenticated = db.transaction((body: ReservationInput, nonce: string) => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM used_nonces WHERE expires_at < ?').run(nowSeconds);
  try {
    db.prepare('INSERT INTO used_nonces(nonce, seen_at, expires_at) VALUES (?, ?, ?)')
      .run(nonce, nowSeconds, nowSeconds + 120);
  } catch {
    return { status: 401, code: 'REPLAY_NONCE' } as const;
  }
  const stock = db.prepare('SELECT available_qty AS availableQty FROM stock WHERE sku = ?').get(body.sku) as
    | { availableQty: number }
    | undefined;
  if (!stock || stock.availableQty < body.quantity) return { status: 409, code: 'INSUFFICIENT_STOCK' } as const;
  db.prepare('UPDATE stock SET available_qty = available_qty - ? WHERE sku = ?').run(body.quantity, body.sku);
  const reservationId = randomUUID();
  db.prepare('INSERT INTO reservations(id, sku, quantity, order_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(reservationId, body.sku, body.quantity, body.orderId, Date.now());
  return { status: 201, reservationId } as const;
});

const state = () => ({
  type: 'state' as const,
  service: 'secure-inventory',
  activeAlgorithm,
  trustedKids: [...trustedKeys.keys()].sort(),
});

app.get('/health', async () => ({ status: 'ok', ...state() }));
app.get('/internal/metrics', async () => inventoryMetrics(db));

app.post('/internal/reservations', async (request, reply) => {
  const parsed = reservationSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
  const auth = authenticate(request, parsed.data);
  if (!auth.parts) return reply.code(401).send(unauthorized);
  const outcome = reserveAuthenticated(parsed.data, auth.parts.nonce);
  if (outcome.status === 401) {
    reject(request, outcome.code);
    return reply.code(401).send(unauthorized);
  }
  if (outcome.status === 409) return reply.code(409).send({ code: outcome.code });
  request.log.info({ event: 'RESERVATION_CREATED', reservationId: outcome.reservationId, kid: auth.parts.kid });
  return reply.code(201).send({ reservationId: outcome.reservationId });
});

process.on('message', (message: WorkerCommand) => {
  if (message.type === 'reset') resetInventory(db, true);
  if (message.type === 'set-verifier-mode') activeAlgorithm = message.algorithm;
  if (message.type === 'add-trusted-key') trustedKeys.set(message.kid, loadPublicKey(config.publicKeyPath(message.kid)));
  if (message.type === 'remove-trusted-key') trustedKeys.delete(message.kid);
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

await app.listen({ host: config.host, port: config.ports.secureInventory });
process.send?.(state());
