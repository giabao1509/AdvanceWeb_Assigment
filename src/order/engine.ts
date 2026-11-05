import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../shared/config.js';
import { consumeFault, transaction } from '../shared/db.js';
import { event, jsonRequest } from '../shared/http.js';
import type { Mode, Order, HttpResult, ResultBody, Saga } from '../shared/types.js';
import { database, readOrder, updateOrder, operationIds, recordSagaEvent } from './store.js';

const active = new Set<string>();
let ticking = false;

async function call(db: DatabaseSync, order: Order, mode: Mode, service: 'inventory' | 'payment', action: string, path: string, body?: Record<string, unknown>): Promise<HttpResult> {
  const id = randomUUID();
  const start = Date.now();
  const method = body ? 'POST' : 'GET';
  const operationId = body?.operationId as string || (action.endsWith('.query') ? decodeURIComponent(path.slice('/operations/'.length)) : null);
  db.prepare('INSERT INTO http_traces (id,order_id,service,action,method,path,operation_id,request_body,started_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, order.id, service, action, method, path, operationId, body ? JSON.stringify(body) : null, new Date(start).toISOString());
  const base = service === 'inventory' ? config.inventoryUrl : config.paymentUrl;
  const result = await jsonRequest(`${base}/api/${mode}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  // F6: refund committed remotely, before Order saves its response or advances the compensation intent.
  if (mode === 'saga' && config.faults && order.scenario === 'F6' && action === 'refund' && result.status === 200
      && transaction(db, () => consumeFault(db, `${order.id}:pause-before-refund-outcome`))) {
    event('order', 'COORDINATOR_BEFORE_REFUND_OUTCOME', { mode, version: order.version, orderId: order.id, operationId, step: order.step, orderStatus:order.status,decision:'COMPENSATE',pending:['refund','release','cancel'],paymentIdSaved: order.payment_id, pid: process.pid });
    await new Promise<never>(() => {}); // The lab controller/script kills this process at the marker.
  }
  const duration = Date.now() - start;
  db.prepare('UPDATE http_traces SET response_body=?,http_status=?,transport_error=?,duration_ms=?,complete=1 WHERE id=?')
    .run(result.body ? JSON.stringify(result.body) : null, result.status, result.error || null, duration, id);
  event('order', 'HTTP', { mode, orderId: order.id, serviceTarget: service, action, method, path, operationId, status: result.status, error: result.error, durationMs: duration, request: body, response: result.body });
  return result;
}

async function command(db: DatabaseSync, order: Order, mode: Mode, service: 'inventory' | 'payment', action: 'reserve' | 'charge' | 'release' | 'refund', path: string, extra: Record<string, unknown> = {}): Promise<HttpResult> {
  const ids = mode === 'saga'
    ? JSON.parse((db.prepare('SELECT operations FROM sagas WHERE order_id=?').get(order.id) as { operations: string }).operations) as ReturnType<typeof operationIds>
    : operationIds(mode, order.id);
  const operationId = ids[action];
  // Query first on every Saga attempt, including after a crash between remote commit and local save.
  if (mode === 'saga') {
    const query = await call(db, order, mode, service, `${action}.query`, `/operations/${encodeURIComponent(operationId)}`);
    if(order.scenario==='F4' && action==='charge'){
      const saga=db.prepare('SELECT charge_uncertain FROM sagas WHERE order_id=?').get(order.id) as {charge_uncertain:number};
      if(typeof query.body?.instanceId==='string')db.prepare('UPDATE sagas SET last_payment_instance=? WHERE order_id=?').run(query.body.instanceId,order.id);
      if(query.status===404 && saga.charge_uncertain)return {status:404,body:{error:'CHARGE_OUTCOME_UNKNOWN'}};
    }
    if (query.status === 200) {
      transaction(db,()=>recordSagaEvent(db,order.id,'OPERATION_RECONCILED'));
      const stored = query.body as unknown as { httpStatus: number; result: ResultBody };
      return { status: stored.httpStatus, body: stored.result };
    }
    if (query.status !== 404) return query;
  }
  return call(db, order, mode, service, action, path, { operationId, orderId: order.id, scenario: order.scenario, ...extra });
}

function pending(db: DatabaseSync, order: Order, mode: Mode, result: HttpResult) {
  const reason = result.error || result.body?.error || `HTTP_${result.status}`;
  if (mode === 'baseline') {
    updateOrder(db, order.id, { status: result.status !== null && result.status < 500 ? 'FAILED' : 'REQUIRES_REVIEW', step: 'DONE', last_error: reason });
    return;
  }
  const saga = db.prepare('SELECT * FROM sagas WHERE order_id=?').get(order.id) as unknown as Saga;
  const exhausted = saga.retry_count >= saga.retry_limit;
  const uncertain=order.scenario==='F4' && order.step==='CHARGE_PENDING' && !!db.prepare("SELECT 1 FROM http_traces WHERE order_id=? AND action='charge'").get(order.id);
  transaction(db, () => {
    db.prepare('UPDATE orders SET status=?,last_error=?,updated_at=? WHERE id=?').run(uncertain?'RECOVERING':saga.decision === 'COMPENSATE'?'COMPENSATING':exhausted?'REQUIRES_REVIEW':'RECOVERING', reason, new Date().toISOString(), order.id);
    if(uncertain)db.prepare('UPDATE sagas SET charge_uncertain=1 WHERE order_id=?').run(order.id);
    db.prepare('UPDATE sagas SET attempts=attempts+1,next_retry_at=?,last_error=?,resume_blocked=?,retry_exhausted=? WHERE order_id=?').run(exhausted ? 0 : Date.now()+config.interval, reason, Number(exhausted), Number(exhausted), order.id);
    recordSagaEvent(db, order.id, exhausted && uncertain?'PAYMENT_RECOVERY_WAIT':exhausted && saga.decision==='COMPENSATE'?'COMPENSATION_PAUSED':exhausted ? 'RETRY_LIMIT_REACHED' : 'RETRY_PENDING');
  });
  event('order', exhausted && uncertain?'PAYMENT_RECOVERY_WAIT':exhausted && saga.decision==='COMPENSATE'?'COMPENSATION_PAUSED':exhausted ? 'RETRY_LIMIT_REACHED' : 'RETRY_PENDING', { mode, orderId: order.id, step: order.step, reason, retries: saga.retry_count, limit: saga.retry_limit });
}

function cancel(db: DatabaseSync, id: string) {
  updateOrder(db, id, { status: 'CANCELLED', step: 'DONE', last_error: null }, undefined, { action: 'cancel', status: 'SUCCEEDED', result: { status: 'CANCELLED' } });
}

export async function runOrder(mode: Mode, id: string): Promise<void> {
  mode=readOrder(database,id).mode;
  const key = id;
  if (active.has(key)) return;
  active.add(key);
  const db = database;
  try {
    if (mode === 'saga') {
      const saga = db.prepare('SELECT * FROM sagas WHERE order_id=?').get(id) as unknown as Saga;
      if (saga.resume_blocked) return;
      if (saga.next_retry_at > 0) {
        if (saga.retry_count >= saga.retry_limit) {
          // A crash may have interrupted the final retry after its budget was persisted.
          transaction(db, () => {
            db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(saga.charge_uncertain?'RECOVERING':saga.decision==='COMPENSATE'?'COMPENSATING':'REQUIRES_REVIEW',new Date().toISOString(),id);
            db.prepare('UPDATE sagas SET resume_blocked=1,retry_exhausted=1,next_retry_at=0 WHERE order_id=?').run(id);
            recordSagaEvent(db,id,saga.charge_uncertain?'PAYMENT_RECOVERY_WAIT':saga.decision==='COMPENSATE'?'COMPENSATION_PAUSED':'RETRY_LIMIT_REACHED');
          });
          return;
        }
        transaction(db,()=>{
          db.prepare('UPDATE sagas SET retry_count=retry_count+1 WHERE order_id=?').run(id);
          recordSagaEvent(db,id,'RETRY_STARTED');
        });
        event('order','RETRY_STARTED',{mode,orderId:id,retry:saga.retry_count+1,limit:saga.retry_limit});
      }
    }
    for (let step = 0; step < 10; step++) {
      const order = readOrder(db, id);
      if (order.step === 'DONE' || order.step === 'AWAIT_PAYMENT') return;
      if (order.step === 'RESERVE_PENDING') {
        const r = await command(db, order, mode, 'inventory', 'reserve', '/reservations', { sku: order.sku, quantity: order.quantity });
        if (r.status === 201 && r.body?.reservation) {
          updateOrder(db, id, { reservation_id: r.body.reservation.id, step: order.checkout_mode === 'manual' ? 'AWAIT_PAYMENT' : 'CHARGE_PENDING', status: order.checkout_mode === 'manual' ? 'AWAITING_PAYMENT' : 'PROCESSING', last_error: null });
          continue;
        }
        if (mode === 'saga' && r.body?.error === 'OUT_OF_STOCK' && r.status === 409) { updateOrder(db, id, { step: 'CANCEL_PENDING', failure_reason: 'OUT_OF_STOCK' }, 'COMPENSATE'); continue; }
        pending(db, order, mode, r); return;
      }
      if (order.step === 'CHARGE_PENDING') {
        const r = await command(db, order, mode, 'payment', 'charge', '/payments', { amount: order.total, walletId: order.wallet_id || 'main',...(order.scenario==='F4'?{downtimeMs:order.f4_downtime_ms}:{}) });
        if (r.status === 201 && r.body?.payment) {
          updateOrder(db, id, { payment_id: r.body.payment.id, step: 'CONFIRM_PENDING', status: 'PROCESSING', last_error: null });
          continue;
        }
        if (r.status === 402 && ['PAYMENT_DECLINED','INSUFFICIENT_FUNDS'].includes(r.body?.error || '')) {
          if (mode === 'baseline') { updateOrder(db, id, { status:'FAILED',step:'DONE',last_error:r.body!.error!,failure_reason:r.body!.error! }); return; }
          updateOrder(db, id, { status: 'COMPENSATING', step: 'RELEASE_PENDING', last_error: r.body!.error!, failure_reason: r.body!.error! }, 'COMPENSATE');
          continue;
        }
        pending(db, order, mode, r); return;
      }
      if (order.step === 'CONFIRM_PENDING') {
        if (config.faults && ['F3', 'F5','F6'].includes(order.scenario)) {
          if (mode === 'baseline') { updateOrder(db, id, { status: 'FAILED', step: 'DONE', last_error: 'CONFIRM_REJECTED' }); return; }
          updateOrder(db, id, { status: 'COMPENSATING', step: 'REFUND_PENDING', last_error: 'CONFIRM_REJECTED', failure_reason:'CONFIRM_REJECTED' }, 'COMPENSATE', { action: 'confirm', status: 'FAILED', result: { error: 'CONFIRM_REJECTED' } });
          continue;
        }
        updateOrder(db, id, { status: 'CONFIRMED', step: 'DONE', last_error: null }, undefined, { action: 'confirm', status: 'SUCCEEDED', result: { status: 'CONFIRMED' } });
        event('order', 'ORDER_CONFIRMED', { mode, orderId: id });
        return;
      }
      if (order.step === 'REFUND_PENDING') {
        const r = await command(db, order, mode, 'payment', 'refund', `/payments/${order.payment_id}/refund`);
        if (r.status === 200 && r.body?.payment?.status === 'REFUNDED') {
          updateOrder(db, id, { step: 'RELEASE_PENDING', last_error: null }); continue;
        }
        pending(db, order, mode, r); return;
      }
      if (order.step === 'RELEASE_PENDING') {
        const r = await command(db, order, mode, 'inventory', 'release', `/reservations/${order.reservation_id}/release`);
        if (r.status === 200 && r.body?.reservation?.status === 'RELEASED') {
          updateOrder(db, id, { step: 'CANCEL_PENDING' }); continue;
        }
        pending(db, order, mode, r); return;
      }
      if (order.step === 'CANCEL_PENDING') {
        cancel(db, id);
        event('order', 'ORDER_CANCELLED_AFTER_COMPENSATION', { mode, orderId: id });
        return;
      }
    }
  } catch (error) {
    event('order', 'ENGINE_ERROR', { mode, orderId: id, error: error instanceof Error ? error.message : String(error) });
    pending(db, readOrder(db, id), mode, { status: null, body: null, error: 'ENGINE_ERROR' });
  } finally { active.delete(key); }
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await wakePaymentRecovery();
    const rows = database.prepare("SELECT o.id FROM orders o JOIN sagas s ON s.order_id=o.id WHERE o.step NOT IN ('DONE','AWAIT_PAYMENT') AND s.resume_blocked=0 AND s.next_retry_at<=? ORDER BY o.created_at").all(Date.now()) as { id: string }[];
    for (const row of rows) await runOrder('saga', row.id);
  } finally { ticking = false; }
}

async function wakePaymentRecovery(){
  const waiting=database.prepare("SELECT s.order_id,s.last_payment_instance FROM sagas s JOIN orders o ON o.id=s.order_id WHERE s.resume_blocked=1 AND s.charge_uncertain=1 AND o.mode='saga' AND o.scenario='F4' AND o.step='CHARGE_PENDING'").all() as {order_id:string;last_payment_instance:string}[];
  if(!waiting.length)return;
  // Availability probes do not replay business commands. Each new Payment instance grants one bounded query round.
  const health=await jsonRequest(`${config.paymentUrl}/health`,{},Math.min(500,config.timeout));
  const instance=health.status===200 && health.body?.service==='payment' && health.body?.status==='ok'?health.body.instanceId:null;
  if(typeof instance!=='string' || !instance)return;
  for(const row of waiting){
    if(row.last_payment_instance===instance)continue;
    transaction(database,()=>{
      const updated=database.prepare('UPDATE sagas SET last_payment_instance=?,retry_count=0,retry_exhausted=0,resume_blocked=0,next_retry_at=0 WHERE order_id=? AND resume_blocked=1 AND charge_uncertain=1 AND last_payment_instance<>?').run(instance,row.order_id,instance);
      if(!updated.changes)return;
      database.prepare("UPDATE orders SET status='RECOVERING',updated_at=? WHERE id=?").run(new Date().toISOString(),row.order_id);
      recordSagaEvent(database,row.order_id,'PAYMENT_RECOVERY_DETECTED');
    });
  }
}
