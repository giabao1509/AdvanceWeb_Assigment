import { randomUUID } from 'node:crypto';
import { config } from '../shared/config.js';
import { openDatabase, transaction, participantSchema, replay, remember, consumeFault } from '../shared/db.js';
import { createApp, participantReads, serve, event, validCommand } from '../shared/http.js';
import type { Payment, Wallet, Operation } from '../shared/types.js';

const database = openDatabase('payment', participantSchema + `
  CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY,name TEXT NOT NULL,balance INTEGER NOT NULL CHECK(balance>=0));
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL CHECK(amount>0),
    status TEXT NOT NULL CHECK(status IN ('CHARGED','REFUNDED')), wallet_id TEXT REFERENCES wallets(id),
    mode TEXT NOT NULL CHECK(mode IN ('baseline','saga'))
  );
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
    kind TEXT NOT NULL CHECK(kind IN ('CHARGE','REFUND')), amount INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id), created_at TEXT NOT NULL,
    UNIQUE(payment_id,kind)
  );
  CREATE TABLE IF NOT EXISTS fault_controls (order_id TEXT PRIMARY KEY, released INTEGER NOT NULL DEFAULT 0);
`, db => {
  if (!(db.prepare('PRAGMA table_info(payments)').all() as { name:string }[]).some(c=>c.name==='wallet_id')) db.exec('ALTER TABLE payments ADD COLUMN wallet_id TEXT REFERENCES wallets(id)');
  db.prepare('INSERT OR IGNORE INTO wallets VALUES (?,?,?)').run('main','Ví chính',10000000);
  db.prepare('INSERT OR IGNORE INTO wallets VALUES (?,?,?)').run('limited','Ví phụ',100000);
  // Normalize the default wallet in old fingerprints without inventing a debit for legacy payments.
  for (const op of db.prepare("SELECT * FROM operations WHERE action='charge'").all() as unknown as Operation[]) {
    let fingerprint:unknown;
    try {fingerprint=JSON.parse(op.fingerprint);} catch {continue;}
    if (Array.isArray(fingerprint) && fingerprint.length===3) db.prepare('UPDATE operations SET fingerprint=? WHERE id=?').run(JSON.stringify([...fingerprint,'main']),op.id);
  }
});
const app = createApp('payment', database);
app.get('/api/:mode/wallets', (req,res)=>res.json(req.db.prepare('SELECT * FROM wallets ORDER BY rowid').all()));
app.get('/api/:mode/ledger', (req, res) => {
  const id = typeof req.query.orderId === 'string' ? req.query.orderId : null;
  const sql = 'SELECT l.*,p.order_id,p.wallet_id,p.mode FROM ledger_entries l JOIN payments p ON p.id=l.payment_id';
  res.json(id ? req.db.prepare(`${sql} WHERE p.order_id=? ORDER BY l.rowid`).all(id) : req.db.prepare(`${sql} ORDER BY l.created_at DESC,l.rowid DESC`).all());
});
app.post('/api/:mode/faults/:orderId/restore', (req, res) => {
  if (!config.faults) return res.status(403).json({ error: 'FAULTS_DISABLED' });
  req.db.prepare('INSERT INTO fault_controls VALUES (?,1) ON CONFLICT(order_id) DO UPDATE SET released=1').run(req.params.orderId);
  event('payment', 'REFUND_FAULT_RESTORED', { mode: req.mode, orderId: req.params.orderId });
  res.json({ restored: true, order_id: req.params.orderId });
});

app.post('/api/:mode/payments', (req, res) => {
  const b = req.body;
  if (!validCommand(b) || typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount <= 0) return res.status(400).json({ error: 'INVALID_PAYMENT' });
  if(b.downtimeMs!==undefined && (!Number.isSafeInteger(b.downtimeMs) || b.downtimeMs<0 || b.downtimeMs>60000))return res.status(400).json({error:'INVALID_F4_DOWNTIME'});
  const amount = b.amount;
  const walletId = b.walletId || 'main';
  if (typeof walletId !== 'string' || walletId.length>100) return res.status(400).json({error:'INVALID_WALLET'});
  const fingerprint = JSON.stringify([b.orderId, b.amount, b.scenario || 'H', walletId]);
  const result = transaction(req.db, () => {
    const cached = replay(req.db, b.operationId, fingerprint);
    if (cached) return cached;
    if (req.db.prepare('SELECT id FROM payments WHERE order_id=?').get(b.orderId)) return { status: 409, body: { error: 'ORDER_ALREADY_CHARGED' } };
    if (config.faults && b.scenario === 'F2') return remember(req.db, b.operationId, fingerprint, 'charge', b.orderId, 402, { error: 'PAYMENT_DECLINED' });
    const wallet=req.db.prepare('SELECT * FROM wallets WHERE id=?').get(walletId) as Wallet | undefined;
    if (!wallet) return remember(req.db,b.operationId,fingerprint,'charge',b.orderId,402,{error:'PAYMENT_DECLINED',reason:'WALLET_NOT_FOUND'});
    if (wallet.balance<amount) return remember(req.db,b.operationId,fingerprint,'charge',b.orderId,402,{error:'INSUFFICIENT_FUNDS',balance:wallet.balance,required:amount});
    const payment: Payment = { id: randomUUID(), order_id: b.orderId, mode:req.mode,amount, status: 'CHARGED', wallet_id:walletId };
    req.db.prepare('UPDATE wallets SET balance=balance-? WHERE id=?').run(amount,walletId);
    req.db.prepare('INSERT INTO payments (id,order_id,amount,status,wallet_id,mode) VALUES (?,?,?,?,?,?)').run(payment.id, b.orderId, amount, 'CHARGED',walletId,req.mode);
    const result = remember(req.db, b.operationId, fingerprint, 'charge', b.orderId, 201, { payment });
    req.db.prepare('INSERT INTO ledger_entries VALUES (?,?,?,?,?,?)').run(randomUUID(), payment.id, 'CHARGE', amount, b.operationId, new Date().toISOString());
    return result;
  });
  // Commit is finished before the marker and before any HTTP response. Marker is one-shot across restart.
  if (result.status === 201 && config.faults && b.scenario === 'F4'
      && transaction(req.db, () => consumeFault(req.db, `${b.orderId}:pause-charge`))) {
    event('payment', 'PAYMENT_CHARGE_COMMITTED_BEFORE_RESPONSE', { mode: req.mode, orderId: b.orderId, operationId: b.operationId, pid: process.pid, downtimeMs:b.downtimeMs ?? config.f4DowntimeMs });
    return; // Intentional lab pause: the runner kills this real process before restarting it.
  }
  res.status(result.status).json(result.body);
});

app.post('/api/:mode/payments/:id/refund', (req, res) => {
  const b = req.body;
  if (!validCommand(b)) return res.status(400).json({ error: 'INVALID_COMMAND' });
  const fingerprint = JSON.stringify([b.orderId, req.params.id, b.scenario || 'H']);
  const result = transaction(req.db, () => {
    const cached = replay(req.db, b.operationId, fingerprint);
    if (cached) return cached;
    const payment = req.db.prepare('SELECT * FROM payments WHERE id=? AND order_id=?').get(req.params.id, b.orderId) as Payment | undefined;
    if (!payment) return { status: 404, body: { error: 'PAYMENT_NOT_FOUND' } };
    if (config.faults && b.scenario === 'F5' && !(req.db.prepare('SELECT released FROM fault_controls WHERE order_id=?').get(b.orderId) as { released: number } | undefined)?.released) return { status: 503, body: { error: 'REFUND_TEMPORARILY_UNAVAILABLE' } };
    const result = remember(req.db, b.operationId, fingerprint, 'refund', b.orderId, 200, { payment: { ...payment, status: 'REFUNDED' } });
    if (payment.status === 'CHARGED') {
      req.db.prepare("UPDATE payments SET status='REFUNDED' WHERE id=?").run(payment.id);
      if (payment.wallet_id) req.db.prepare('UPDATE wallets SET balance=balance+? WHERE id=?').run(payment.amount,payment.wallet_id);
      req.db.prepare('INSERT INTO ledger_entries VALUES (?,?,?,?,?,?)').run(randomUUID(), payment.id, 'REFUND', payment.amount, b.operationId, new Date().toISOString());
    }
    return result;
  });
  res.status(result.status).json(result.body);
});

participantReads(app, (db, orderId) => {
  const payment = db.prepare('SELECT * FROM payments WHERE order_id=?').get(orderId) as Payment | undefined;
  return { payment: payment || null, ledger: payment ? db.prepare('SELECT * FROM ledger_entries WHERE payment_id=? ORDER BY rowid').all(payment.id) : [] };
});
serve(app, 'payment', config.paymentPort, database);
