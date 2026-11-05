import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../shared/db.js';
import { event } from '../shared/http.js';
import { config } from '../shared/config.js';
import type { Order, Saga, Mode, OperationStatus } from '../shared/types.js';

export function operationIds(mode: Mode, id: string, createId = `${mode}/${id}/create`) {
  return { create: createId, reserve: `${mode}/${id}/reserve`, charge: `${mode}/${id}/charge`, refund: `${mode}/${id}/refund`, release: `${mode}/${id}/release`, confirm: `${mode}/${id}/confirm`, cancel: `${mode}/${id}/cancel` };
}

export const database = openDatabase('order', `
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('baseline','saga')), f4_downtime_ms INTEGER NOT NULL DEFAULT 4000,
    sku TEXT NOT NULL, product_name TEXT NOT NULL, quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL, total INTEGER NOT NULL, scenario TEXT NOT NULL,
    status TEXT NOT NULL, step TEXT NOT NULL, reservation_id TEXT, payment_id TEXT,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'v3', checkout_mode TEXT NOT NULL DEFAULT 'automatic', wallet_id TEXT, failure_reason TEXT,
    UNIQUE(mode,request_key)
  );
  CREATE TABLE IF NOT EXISTS sagas (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), operations TEXT NOT NULL,
    decision TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, resume_blocked INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0, retry_limit INTEGER NOT NULL DEFAULT 3, retry_exhausted INTEGER NOT NULL DEFAULT 0,
    charge_uncertain INTEGER NOT NULL DEFAULT 0,last_payment_instance TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS saga_events (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), event TEXT NOT NULL,
    status TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, intent TEXT, pending TEXT NOT NULL,
    error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_operations (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), action TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS http_traces (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), service TEXT NOT NULL,
    action TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, operation_id TEXT,
    request_body TEXT, response_body TEXT, http_status INTEGER, transport_error TEXT,
    started_at TEXT NOT NULL, duration_ms INTEGER, complete INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS faults (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
`, db => {
  if (!(db.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).some(c => c.name === 'version')) db.exec("ALTER TABLE orders ADD COLUMN version TEXT NOT NULL DEFAULT 'v3'");
  const columns = (db.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).map(c=>c.name);
  if (!columns.includes('checkout_mode')) db.exec("ALTER TABLE orders ADD COLUMN checkout_mode TEXT NOT NULL DEFAULT 'automatic'");
  if (!columns.includes('wallet_id')) db.exec('ALTER TABLE orders ADD COLUMN wallet_id TEXT');
  if (!columns.includes('failure_reason')) db.exec('ALTER TABLE orders ADD COLUMN failure_reason TEXT');
  if (!columns.includes('f4_downtime_ms')) db.exec(`ALTER TABLE orders ADD COLUMN f4_downtime_ms INTEGER NOT NULL DEFAULT ${config.f4DowntimeMs}`);
  if (!(db.prepare('PRAGMA table_info(sagas)').all() as { name: string }[]).some(c => c.name === 'resume_blocked')) db.exec('ALTER TABLE sagas ADD COLUMN resume_blocked INTEGER NOT NULL DEFAULT 0');
  const sagaColumns = (db.prepare('PRAGMA table_info(sagas)').all() as { name:string }[]).map(c=>c.name);
  if (!sagaColumns.includes('retry_count')) {
    db.exec('ALTER TABLE sagas ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    // Legacy version gates no longer apply; preserve orders and their stable operation IDs.
    db.exec('UPDATE sagas SET resume_blocked=0');
  }
  if (!sagaColumns.includes('retry_limit')) db.exec(`ALTER TABLE sagas ADD COLUMN retry_limit INTEGER NOT NULL DEFAULT ${config.maxRetries}`);
  if (!sagaColumns.includes('retry_exhausted')) db.exec('ALTER TABLE sagas ADD COLUMN retry_exhausted INTEGER NOT NULL DEFAULT 0');
  if (!sagaColumns.includes('charge_uncertain')) {
    db.exec('ALTER TABLE sagas ADD COLUMN charge_uncertain INTEGER NOT NULL DEFAULT 0');
  }
  // Also normalize records imported from the old layout into a freshly created schema.
  db.exec("UPDATE sagas SET charge_uncertain=1 WHERE charge_uncertain=0 AND order_id IN (SELECT id FROM orders WHERE mode='saga' AND scenario='F4' AND step='CHARGE_PENDING') AND EXISTS(SELECT 1 FROM http_traces t WHERE t.order_id=sagas.order_id AND t.action='charge')");
  db.exec("UPDATE orders SET status='RECOVERING' WHERE scenario='F4' AND step='CHARGE_PENDING' AND id IN (SELECT order_id FROM sagas WHERE charge_uncertain=1)");
  db.exec("UPDATE orders SET status='COMPENSATING' WHERE step<>'DONE' AND status='REQUIRES_REVIEW' AND id IN (SELECT order_id FROM sagas WHERE decision='COMPENSATE')");
  if (!sagaColumns.includes('last_payment_instance')) db.exec("ALTER TABLE sagas ADD COLUMN last_payment_instance TEXT NOT NULL DEFAULT ''");
  for (const row of db.prepare('SELECT order_id,operations FROM sagas').all() as { order_id: string; operations: string }[]) {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(row.order_id) as unknown as Order;
    const ids = { ...operationIds('saga', order.id, order.request_key), ...JSON.parse(row.operations) };
    db.prepare('UPDATE sagas SET operations=? WHERE order_id=?').run(JSON.stringify(ids), order.id);
    const fingerprint = JSON.parse(order.fingerprint) as unknown[];
    if (fingerprint.length === 3) db.prepare('UPDATE orders SET fingerprint=? WHERE id=?').run(JSON.stringify([...fingerprint, 'v3']), order.id);
  }
  for(const order of db.prepare("SELECT id,fingerprint,f4_downtime_ms FROM orders WHERE scenario='F4'").all() as {id:string;fingerprint:string;f4_downtime_ms:number}[]){
    const fingerprint=JSON.parse(order.fingerprint) as unknown[];
    if(!fingerprint.includes('f4-downtime'))db.prepare('UPDATE orders SET fingerprint=? WHERE id=?').run(JSON.stringify([...fingerprint,'f4-downtime',order.f4_downtime_ms]),order.id);
  }
});

export function readOrder(db: DatabaseSync, id: string): Order {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Order | undefined;
  if (!order) throw new Error(`Order ${id} not found`);
  return order;
}

export function sagaDetails(db: DatabaseSync, id: string) {
  const saga = db.prepare('SELECT * FROM sagas WHERE order_id=?').get(id) as Saga | undefined;
  if (!saga) return null;
  const order = readOrder(db, id);
  const operations = JSON.parse(saga.operations) as ReturnType<typeof operationIds>;
  const actionByStep = { RESERVE_PENDING: 'reserve', AWAIT_PAYMENT: null, CHARGE_PENDING: 'charge', CONFIRM_PENDING: 'confirm', REFUND_PENDING: 'refund', RELEASE_PENDING: 'release', CANCEL_PENDING: 'cancel', DONE: null } as const;
  const action = actionByStep[order.step];
  const pending = saga.decision === 'COMPENSATE'
    ? order.step === 'REFUND_PENDING' ? ['refund', 'release', 'cancel'] : order.step === 'RELEASE_PENDING' ? ['release', 'cancel'] : order.step === 'CANCEL_PENDING' ? ['cancel'] : []
    : [];
  const phase = order.step === 'DONE' ? 'done' : order.step === 'AWAIT_PAYMENT' ? 'awaiting_payment' : saga.decision === 'COMPENSATE' ? 'compensate' : action || 'done';
  return { ...saga, saga_id: id, order_id: id, version: order.version, phase, intent: action ? { action, operationId: operations[action] } : null, pending, operations,
    outcome: { reservation_id: order.reservation_id, payment_id: order.payment_id },
    history: db.prepare('SELECT * FROM saga_events WHERE order_id=? ORDER BY rowid').all(id),
    localOperations: db.prepare('SELECT * FROM order_operations WHERE order_id=? ORDER BY rowid').all(id) };
}

export function recordSagaEvent(db: DatabaseSync, id: string, name: string) {
  const details = sagaDetails(db, id);
  if (!details) return;
  const order = readOrder(db, id);
  db.prepare('INSERT INTO saga_events VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, name, order.status, order.step, details.phase, details.intent ? JSON.stringify(details.intent) : null, JSON.stringify(details.pending), order.last_error, new Date().toISOString());
}

export function localOperation(db: DatabaseSync, order: Order, action: 'confirm' | 'cancel', status: OperationStatus, result: Record<string, unknown>) {
  const id = operationIds(order.mode, order.id)[action];
  db.prepare('INSERT OR IGNORE INTO order_operations VALUES (?,?,?,?,?,?)').run(id, order.id, action, status, JSON.stringify(result), new Date().toISOString());
}

export function updateOrder(db: DatabaseSync, id: string, patch: Partial<Pick<Order, 'status' | 'step' | 'reservation_id' | 'payment_id' | 'last_error' | 'wallet_id' | 'failure_reason'>>, decision?: Saga['decision'], op?: { action: 'confirm' | 'cancel'; status: OperationStatus; result: Record<string, unknown> }) {
  transaction(db, () => {
    const fields = { ...patch, updated_at: new Date().toISOString() };
    db.prepare(`UPDATE orders SET ${Object.keys(fields).map(key => `${key}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), id);
    if (patch.step && patch.step !== 'DONE') db.prepare('UPDATE sagas SET retry_count=0,next_retry_at=0,retry_exhausted=0,resume_blocked=0,charge_uncertain=0 WHERE order_id=?').run(id);
    if (decision) db.prepare('UPDATE sagas SET decision=? WHERE order_id=?').run(decision, id);
    if (op) localOperation(db, readOrder(db, id), op.action, op.status, op.result);
    recordSagaEvent(db, id, 'TRANSITION');
  });
  const order = readOrder(db, id);
  event('order', 'ORDER_TRANSITION', { mode: order.mode, version: order.version, orderId: id, status: order.status, step: order.step, decision, lastError: order.last_error });
}
