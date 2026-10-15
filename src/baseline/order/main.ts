import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config, url } from '../../shared/config.js';
import { orderSchema } from '../../shared/contracts.js';
import { createLoggerOptions, jsonFetch, registerCommonHooks } from '../../shared/http.js';
import { openBaselineOrder, resetBaselineOrder } from '../../shared/database.js';
import type { WorkerCommand } from '../../shared/process-messages.js';

const app = Fastify({ logger: createLoggerOptions('baseline-order') });
const db = openBaselineOrder();
registerCommonHooks(app);

app.get('/health', async () => ({ status: 'ok', service: 'baseline-order' }));

app.post('/orders', async (request, reply) => {
  const parsed = orderSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
  const orderId = randomUUID();
  const inventory = await jsonFetch<{ reservationId?: string; code?: string }>(
    url(config.ports.baselineInventory, '/internal/reservations'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace-id': request.id },
      body: JSON.stringify({ ...parsed.data, orderId }),
    },
  );
  process.send?.({
    type: 'http-exchange', traceId: request.id,
    request: {
      method: 'POST', url: url(config.ports.baselineInventory, '/internal/reservations'),
      headers: { 'content-type': 'application/json', 'x-trace-id': request.id },
      body: { ...parsed.data, orderId },
    },
    response: { status: inventory.status, body: inventory.body },
  });
  if (inventory.status !== 201 || !inventory.body.reservationId) {
    return reply.code(inventory.status === 409 ? 409 : 502).send(inventory.body);
  }
  db.prepare('INSERT INTO orders(id, user_id, sku, quantity, reservation_id, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
    .run(orderId, parsed.data.sku, parsed.data.quantity, inventory.body.reservationId, Date.now());
  return reply.code(201).send({ orderId, reservationId: inventory.body.reservationId });
});

process.on('message', (message: WorkerCommand) => {
  if (message.type === 'reset') resetBaselineOrder(db);
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

await app.listen({ host: config.host, port: config.ports.baselineOrder });
