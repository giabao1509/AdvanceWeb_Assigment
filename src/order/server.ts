import { randomUUID } from 'node:crypto';
import { config, catalog } from '../shared/config.js';
import { transaction } from '../shared/db.js';
import { createApp, serve, jsonRequest, event } from '../shared/http.js';
import type { Order, Scenario } from '../shared/types.js';
import { database, operationIds, sagaDetails, recordSagaEvent, updateOrder } from './store.js';
import { runOrder, tick } from './engine.js';

const app = createApp('order', database);
// Baseline never resumes an interrupted workflow or assumes remote effects were undone.
database.prepare("UPDATE orders SET status='REQUIRES_REVIEW',step='DONE',last_error='COORDINATOR_RESTARTED',updated_at=? WHERE mode='baseline' AND step NOT IN ('DONE','AWAIT_PAYMENT')").run(new Date().toISOString());
// URLs retain the mode segment for compatibility. Existing orders always use their stored policy.
app.param('id',(req,res,next,id)=>{
  const order=database.prepare('SELECT mode FROM orders WHERE id=?').get(id) as Pick<Order,'mode'>|undefined;
  if(order)req.mode=order.mode;
  next();
});
app.get('/api/:mode/config', (req, res) => res.json({ mode: req.mode, faultsEnabled: config.faults, recoveryIntervalMs: config.interval, maxRetries: config.maxRetries, f4DowntimeMs:config.f4DowntimeMs }));
app.get('/api/:mode/products', async (req, res) => {
  const stock = await jsonRequest(`${config.inventoryUrl}/api/${req.mode}/stock`);
  const rows = stock.status === 200 ? stock.body as unknown as { sku: string; available: number }[] : null;
  res.json({ products: catalog.map(p => ({ ...p, available: rows?.find(s => s.sku === p.sku)?.available ?? null })), inventoryAvailable: !!rows });
});
app.get('/api/:mode/orders', (req, res) => {
  res.json(req.db.prepare('SELECT * FROM orders ORDER BY created_at DESC,rowid DESC').all());
});
app.post('/api/:mode/orders', (req, res) => {
  const body = req.body as { sku?: string; quantity?: number; scenario?: string; create_op_id?: string; checkout_mode?:string; f4_downtime_ms?:number } | undefined;
  const product = catalog.find(p => p.sku === body?.sku);
  const key = req.get('Idempotency-Key') || body?.create_op_id;
  if (req.get('Idempotency-Key') && body?.create_op_id && req.get('Idempotency-Key') !== body.create_op_id) return res.status(409).json({ error: 'CREATE_ID_MISMATCH' });
  const scenario = body?.scenario === 'H0' ? 'H' : body?.scenario || 'H';
  const checkoutMode=body?.checkout_mode || 'automatic';
  if (!['manual','automatic'].includes(checkoutMode)) return res.status(400).json({error:'INVALID_CHECKOUT_MODE'});
  if (checkoutMode==='manual' && scenario!=='H') return res.status(422).json({error:'MANUAL_DOES_NOT_USE_PRESET_FAULTS'});
  if (!product || typeof body?.quantity !== 'number' || !Number.isSafeInteger(body.quantity) || body.quantity < 1 || body.quantity > 99 || typeof key !== 'string' || !key || key.length > 150) return res.status(400).json({ error: 'INVALID_ORDER', message: 'Cần SKU hợp lệ, số lượng 1–99 và Idempotency-Key.' });
  if (!['H', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'].includes(scenario)) return res.status(400).json({ error: 'INVALID_SCENARIO' });
  if (scenario !== 'H' && !config.faults) return res.status(403).json({ error: 'FAULTS_DISABLED' });
  const existing = req.db.prepare('SELECT * FROM orders WHERE mode=? AND request_key=?').get(req.mode,key) as Order | undefined;
  const downtime=body.f4_downtime_ms ?? existing?.f4_downtime_ms ?? config.f4DowntimeMs;
  if(!Number.isSafeInteger(downtime) || downtime<0 || downtime>60000)return res.status(400).json({error:'INVALID_F4_DOWNTIME'});
  // Preserve legacy fingerprints and IDs without retaining separate execution policies.
  const version = existing?.version || 'v3';
  const fingerprint = JSON.stringify([product.sku, body.quantity, scenario, ...(req.mode === 'saga' ? [version] : []), ...(checkoutMode==='manual'?['manual']:[]),...(scenario==='F4'?['f4-downtime',downtime]:[])]);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return res.status(409).json({ error: 'IDEMPOTENCY_CONFLICT' });
    return res.status(202).json({ order: existing, order_id: existing.id, saga_id: req.mode === 'saga' ? existing.id : null, create_op_id: key, location: `/api/${req.mode}/orders/${existing.id}`, replayed: true });
  }
  const id = randomUUID();
  const time = new Date().toISOString();
  transaction(req.db, () => {
    req.db.prepare('INSERT INTO orders (id,request_key,fingerprint,mode,sku,product_name,quantity,unit_price,total,scenario,status,step,reservation_id,payment_id,last_error,created_at,updated_at,version,checkout_mode,f4_downtime_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, key, fingerprint, req.mode,product.sku, product.name, body.quantity!, product.price, product.price * body.quantity!, scenario, 'PROCESSING', 'RESERVE_PENDING', null, null, null, time, time, version, checkoutMode,downtime);
    if (req.mode === 'saga') {
      req.db.prepare('INSERT INTO sagas (order_id,operations,decision,retry_limit) VALUES (?,?,?,?)').run(id, JSON.stringify(operationIds(req.mode, id, key)), 'FORWARD',config.maxRetries);
      recordSagaEvent(req.db, id, 'CREATED');
    }
  });
  const order = req.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as unknown as Order;
  res.status(202).location(`/api/${req.mode}/orders/${id}`).json({ order, order_id: id, saga_id: req.mode === 'saga' ? id : null, create_op_id: key, location: `/api/${req.mode}/orders/${id}`, replayed: false });
  event('order', 'ORDER_CREATED', { mode: req.mode, orderId: id, scenario: scenario as Scenario });
  setImmediate(() => { void runOrder(req.mode, id); });
});
app.post('/api/:mode/orders/:id/pay', (req,res)=>{
  const order=req.db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id) as Order | undefined;
  if (!order) return res.status(404).json({error:'ORDER_NOT_FOUND'});
  if (order.checkout_mode!=='manual') return res.status(409).json({error:'AUTOMATIC_CHECKOUT'});
  const walletId=req.body?.walletId ?? 'main';
  if (typeof walletId!=='string' || !['main','limited'].includes(walletId)) return res.status(400).json({error:'INVALID_WALLET'});
  if (order.wallet_id) {
    if (order.wallet_id!==walletId) return res.status(409).json({error:'PAYMENT_WALLET_ALREADY_SELECTED'});
    return res.status(202).json({order,replayed:true,payment_op_id:operationIds(req.mode,order.id).charge});
  }
  if (order.step!=='AWAIT_PAYMENT') return res.status(409).json({error:'ORDER_NOT_AWAITING_PAYMENT',status:order.status});
  updateOrder(req.db,order.id,{wallet_id:walletId,step:'CHARGE_PENDING',status:'PROCESSING',last_error:null});
  req.db.prepare('UPDATE sagas SET resume_blocked=0,next_retry_at=0 WHERE order_id=?').run(order.id);
  res.status(202).json({order:req.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id),payment_op_id:operationIds(req.mode,order.id).charge,replayed:false});
  setImmediate(()=>{void runOrder(req.mode,order.id);});
});
app.post('/api/:mode/orders/:id/cancel', (req,res)=>{
  const order=req.db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id) as Order | undefined;
  if (!order) return res.status(404).json({error:'ORDER_NOT_FOUND'});
  if (order.status==='CANCELLED' || order.failure_reason==='USER_CANCELLED') return res.status(202).json({order,replayed:true});
  if (order.checkout_mode!=='manual' || order.step!=='AWAIT_PAYMENT') return res.status(409).json({error:'CANNOT_CANCEL_AFTER_PAYMENT_STARTED',status:order.status});
  updateOrder(req.db,order.id,{step:'RELEASE_PENDING',status:'COMPENSATING',failure_reason:'USER_CANCELLED'},'COMPENSATE');
  req.db.prepare('UPDATE sagas SET resume_blocked=0,next_retry_at=0 WHERE order_id=?').run(order.id);
  res.status(202).json({order:req.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id),replayed:false});
  setImmediate(()=>{void runOrder(req.mode,order.id);});
});
app.get('/api/:mode/orders/:id', (req, res) => {
  const order = req.db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
  res.json({ order, order_id: req.params.id, saga_id: req.mode === 'saga' ? req.params.id : null, saga: sagaDetails(req.db, req.params.id) });
});
app.get(['/api/:mode/orders/:id/saga', '/api/:mode/sagas/:id'], (req, res) => {
  const saga = sagaDetails(req.db, String(req.params.id));
  if (!saga) return res.status(404).json({ error: 'SAGA_NOT_FOUND' });
  res.json(saga);
});
app.post('/api/:mode/sagas/:id/resume', (req, res) => {
  const saga = sagaDetails(req.db, req.params.id);
  if (!saga) return res.status(404).json({ error: 'SAGA_NOT_FOUND' });
  if (saga.phase==='awaiting_payment') return res.status(409).json({error:'WAITING_FOR_CUSTOMER_PAYMENT'});
  if (saga.phase==='done' || !saga.resume_blocked) return res.status(202).json({saga_id:req.params.id,accepted:true,already_running:saga.phase!=='done'});
  transaction(req.db, () => {
    req.db.prepare('UPDATE sagas SET next_retry_at=0,resume_blocked=0,retry_count=0,retry_exhausted=0,retry_limit=? WHERE order_id=?').run(config.maxRetries,req.params.id);
    req.db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(saga.charge_uncertain?'RECOVERING':saga.decision==='COMPENSATE'?'COMPENSATING':'PROCESSING',new Date().toISOString(),req.params.id);
    recordSagaEvent(req.db, req.params.id, 'RESUME_REQUESTED');
  });
  res.status(202).json({ saga_id: req.params.id, accepted: true, maxRetries:config.maxRetries });
  setImmediate(() => { void runOrder(req.mode, req.params.id); });
});
app.get('/api/:mode/orders/:id/traces', (req, res) => {
  if (!req.db.prepare('SELECT id FROM orders WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
  res.json(req.db.prepare('SELECT * FROM http_traces WHERE order_id=? ORDER BY rowid').all(req.params.id));
});
app.get('/api/:mode/orders/:id/snapshot', async (req, res) => {
  const order = req.db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
  const results = await Promise.all([config.inventoryUrl, config.paymentUrl].map(base => jsonRequest(`${base}/api/${req.mode}/orders/${req.params.id}/state`)));
  const [inventory, payment] = results.map(r => ({ available: r.status === 200, data: r.status === 200 ? r.body : null, error: r.error || (r.status !== 200 ? `HTTP_${r.status}` : null) }));
  res.json({ order, inventory, payment, capturedAt: new Date().toISOString() });
});

// Evidence fixtures may hold recovery at an explicit IPC checkpoint. Normal app startup never pauses here.
let recoveryPaused=config.faults && process.env.PAUSE_RECOVERY_ON_START==='true' && !!process.send;
const recover=()=>{if(!recoveryPaused)void tick().catch(error=>event('order','WORKER_ERROR',{message:String(error)}));};
process.on('message',message=>{
  if(recoveryPaused && (message as {type?:string})?.type==='continue-recovery'){
    recoveryPaused=false;event('order','RECOVERY_CHECKPOINT_RELEASED',{pid:process.pid});recover();
  }
});
const interval = setInterval(recover, config.interval);
serve(app, 'order', config.orderPort, database, () => clearInterval(interval));
transaction(database,()=>{
  const rows=database.prepare("SELECT o.id,s.resume_blocked FROM orders o JOIN sagas s ON s.order_id=o.id WHERE o.step NOT IN ('DONE','AWAIT_PAYMENT')").all() as {id:string;resume_blocked:number}[];
  for(const row of rows)recordSagaEvent(database,row.id,row.resume_blocked?'RECOVERY_BLOCKED':'RECOVERY_STARTED');
});
if(recoveryPaused)event('order','RECOVERY_CHECKPOINT_PAUSED',{pid:process.pid});
else recover();
