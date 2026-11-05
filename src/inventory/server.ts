import { randomUUID } from 'node:crypto';
import { config, catalog } from '../shared/config.js';
import { openDatabase, transaction, participantSchema, replay, remember } from '../shared/db.js';
import { createApp, participantReads, serve, validCommand } from '../shared/http.js';
import type { Reservation, Operation } from '../shared/types.js';

const database = openDatabase('inventory', participantSchema + `
  CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, available INTEGER NOT NULL CHECK(available>=0));
  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, sku TEXT NOT NULL REFERENCES stock(sku),
    quantity INTEGER NOT NULL CHECK(quantity>0), status TEXT NOT NULL CHECK(status IN ('HELD','RELEASED')),
    mode TEXT NOT NULL CHECK(mode IN ('baseline','saga'))
  );
  CREATE TABLE IF NOT EXISTS movements (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, reservation_id TEXT NOT NULL REFERENCES reservations(id),
    kind TEXT NOT NULL, quantity INTEGER NOT NULL, delta INTEGER NOT NULL, available_after INTEGER,
    operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id), created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'LIVE', UNIQUE(reservation_id,kind)
  );
`, db => {
  for (const p of catalog) db.prepare('INSERT OR IGNORE INTO stock VALUES (?,?)').run(p.sku, p.stock);
  // Preserve old data. Imported movements come from real durable operation results, never invented balances.
  for (const op of db.prepare("SELECT * FROM operations WHERE action IN ('reserve','release') AND http_status BETWEEN 200 AND 299 ORDER BY created_at").all() as unknown as Operation[]) {
    const r = JSON.parse(op.result).reservation as Reservation | undefined;
    if (r) db.prepare('INSERT OR IGNORE INTO movements VALUES (?,?,?,?,?,?,?,?,?,?)').run(`import:${op.id}`, op.order_id, r.id, op.action === 'reserve' ? 'RESERVE' : 'RELEASE', r.quantity, op.action === 'reserve' ? -r.quantity : r.quantity, null, op.id, op.created_at, 'IMPORTED_OPERATION');
  }
});
const app = createApp('inventory', database);
app.get('/api/:mode/stock', (req, res) => res.json(req.db.prepare('SELECT * FROM stock').all()));
app.get('/api/:mode/items', (req, res) => res.json(catalog.map(p => ({ ...p,
  ...req.db.prepare('SELECT available FROM stock WHERE sku=?').get(p.sku),
  held: (req.db.prepare("SELECT COALESCE(SUM(quantity),0) AS held FROM reservations WHERE sku=? AND status='HELD'").get(p.sku) as {held:number}).held,
}))));
app.get('/api/:mode/movements', (req, res) => {
  const id = typeof req.query.orderId === 'string' ? req.query.orderId : null;
  const sku = typeof req.query.sku === 'string' ? req.query.sku : null;
  const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
  if (kind && !['RESERVE','RELEASE'].includes(kind)) return res.status(400).json({error:'INVALID_MOVEMENT_KIND'});
  const conditions:string[]=[];const values:string[]=[];
  for (const [column,value] of [['order_id',id],['sku',sku],['kind',kind]]) if(value){conditions.push(`${column==='sku'?'r':'m'}.${column}=?`);values.push(value);}
  res.json(req.db.prepare(`SELECT m.*,r.sku,r.mode FROM movements m JOIN reservations r ON r.id=m.reservation_id ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY m.created_at ${id?'ASC':'DESC'},m.rowid ${id?'ASC':'DESC'}`).all(...values));
});

app.post('/api/:mode/reservations', (req, res) => {
  const b = req.body;
  if (!validCommand(b) || typeof b.quantity !== 'number' || !Number.isSafeInteger(b.quantity) || b.quantity < 1 || !catalog.some(p => p.sku === b.sku)) return res.status(400).json({ error: 'INVALID_RESERVATION' });
  const { quantity, sku } = b as typeof b & { quantity: number; sku: string };
  const fingerprint = JSON.stringify([b.orderId, b.sku, b.quantity, b.scenario || 'H']);
  const result = transaction(req.db, () => {
    const cached = replay(req.db, b.operationId, fingerprint);
    if (cached) return cached;
    const existing = req.db.prepare('SELECT * FROM reservations WHERE order_id=?').get(b.orderId);
    if (existing) return { status: 409, body: { error: 'ORDER_ALREADY_RESERVED' } };
    const stock = req.db.prepare('SELECT available FROM stock WHERE sku=?').get(sku) as { available: number } | undefined;
    if (!stock) throw new Error('Seeded SKU missing');
    if ((config.faults && b.scenario === 'F1') || stock.available < quantity) return remember(req.db, b.operationId, fingerprint, 'reserve', b.orderId, 409, { error: 'OUT_OF_STOCK' });
    const reservation: Reservation = { id: randomUUID(), order_id: b.orderId, mode:req.mode,sku, quantity, status: 'HELD' };
    req.db.prepare('UPDATE stock SET available=available-? WHERE sku=?').run(quantity, sku);
    req.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?)').run(reservation.id, b.orderId, sku, quantity, 'HELD',req.mode);
    const saved = remember(req.db, b.operationId, fingerprint, 'reserve', b.orderId, 201, { reservation });
    req.db.prepare('INSERT INTO movements VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), b.orderId, reservation.id, 'RESERVE', quantity, -quantity, stock.available - quantity, b.operationId, new Date().toISOString(), 'LIVE');
    return saved;
  });
  res.status(result.status).json(result.body);
});

app.post('/api/:mode/reservations/:id/release', (req, res) => {
  const b = req.body;
  if (!validCommand(b)) return res.status(400).json({ error: 'INVALID_COMMAND' });
  const fingerprint = JSON.stringify([b.orderId, req.params.id]);
  const result = transaction(req.db, () => {
    const cached = replay(req.db, b.operationId, fingerprint);
    if (cached) return cached;
    const reservation = req.db.prepare('SELECT * FROM reservations WHERE id=? AND order_id=?').get(req.params.id, b.orderId) as Reservation | undefined;
    if (!reservation) return { status: 404, body: { error: 'RESERVATION_NOT_FOUND' } };
    if (reservation.status === 'HELD') {
      req.db.prepare("UPDATE reservations SET status='RELEASED' WHERE id=?").run(reservation.id);
      req.db.prepare('UPDATE stock SET available=available+? WHERE sku=?').run(reservation.quantity, reservation.sku);
    }
    const saved = remember(req.db, b.operationId, fingerprint, 'release', b.orderId, 200, { reservation: { ...reservation, status: 'RELEASED' } });
    if (reservation.status === 'HELD') {
      const stock = req.db.prepare('SELECT available FROM stock WHERE sku=?').get(reservation.sku) as { available: number };
      req.db.prepare('INSERT INTO movements VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), b.orderId, reservation.id, 'RELEASE', reservation.quantity, reservation.quantity, stock.available, b.operationId, new Date().toISOString(), 'LIVE');
    }
    return saved;
  });
  res.status(result.status).json(result.body);
});

participantReads(app, (db, orderId) => ({
  reservation: db.prepare('SELECT * FROM reservations WHERE order_id=?').get(orderId) || null,
  stock: db.prepare('SELECT * FROM stock').all(),
  movements: db.prepare('SELECT * FROM movements WHERE order_id=? ORDER BY rowid').all(orderId),
}));
serve(app, 'inventory', config.inventoryPort, database);
