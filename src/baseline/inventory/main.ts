import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../shared/config.js';
import { reservationSchema } from '../../shared/contracts.js';
import { createLoggerOptions, registerCommonHooks } from '../../shared/http.js';
import { inventoryMetrics, openBaselineInventory, resetInventory } from '../../shared/database.js';
import type { WorkerCommand } from '../../shared/process-messages.js';

const app = Fastify({ logger: createLoggerOptions('baseline-inventory') });
const db = openBaselineInventory();
registerCommonHooks(app);

const reserve = db.transaction((sku: string, quantity: number, orderId: string) => {
  const stock = db.prepare('SELECT available_qty AS availableQty FROM stock WHERE sku = ?').get(sku) as
    | { availableQty: number }
    | undefined;
  if (!stock || stock.availableQty < quantity) return null;
  db.prepare('UPDATE stock SET available_qty = available_qty - ? WHERE sku = ?').run(quantity, sku);
  const id = randomUUID();
  db.prepare('INSERT INTO reservations(id, sku, quantity, order_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, sku, quantity, orderId, Date.now());
  return id;
});

app.get('/health', async () => ({ status: 'ok', service: 'baseline-inventory' }));
app.get('/internal/metrics', async () => inventoryMetrics(db));

app.post('/internal/reservations', async (request, reply) => {
  const parsed = reservationSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
  const reservationId = reserve(parsed.data.sku, parsed.data.quantity, parsed.data.orderId);
  if (!reservationId) return reply.code(409).send({ code: 'INSUFFICIENT_STOCK' });
  request.log.warn({ event: 'BASELINE_UNSIGNED_RESERVATION', reservationId, traceId: request.id });
  return reply.code(201).send({ reservationId });
});

process.on('message', (message: WorkerCommand) => {
  if (message.type === 'reset') {
    resetInventory(db, false);
    process.send?.({ type: 'state', service: 'baseline-inventory' });
  }
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

await app.listen({ host: config.host, port: config.ports.baselineInventory });
