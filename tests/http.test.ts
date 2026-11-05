import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedLab, waitFor, type Lab, type Snapshot } from '../scripts/lab.js';
import type { Mode, Order, Movement, ResultBody } from '../src/shared/types.js';

let lab: Lab;
beforeEach(async () => { lab = await isolatedLab('http'); await lab.startAll(); });
afterEach(async () => { await lab?.close(); });

interface SagaView { saga_id: string; phase: string; intent: { action: string; operationId: string } | null; pending: string[]; operations: Record<string, string>; history: { step: string }[]; localOperations: { action: string; status: string }[] }
interface Trace { action: string; http_status: number | null; transport_error: string | null; complete: number }

for (const mode of ['baseline','saga'] as const) {
  for (const scenario of ['H', 'F1', 'F2', 'F3']) {
    test(`${mode} ${scenario}: three stores, forbidden calls and compensation order`, async () => {
      const created = await lab.create(mode, scenario, randomUUID(), 1);
      assert.equal(created.status, 202);
      const id = created.body.order.id;
      assert.equal(created.body.saga_id, mode === 'saga' ? id : null);
      const s = await lab.settled(mode, id);
      assert(s.inventory.available && s.payment.available);
      const reservation = s.inventory.data!.reservation;
      const payment = s.payment.data!.payment;
      const ledger = s.payment.data!.ledger;
      const traces = (await lab.request<Trace[]>(mode, `/orders/${id}/traces`)).body;
      const movements = (await lab.request<Movement[]>(mode, `/movements?orderId=${id}`, {}, 'inventory')).body;
      if (scenario === 'H') {
        assert.equal(s.order.status, 'CONFIRMED'); assert.equal(reservation?.status, 'HELD'); assert.equal(payment?.status, 'CHARGED');
        assert.equal(ledger.length, 1); assert.equal(ledger[0].kind, 'CHARGE'); assert.equal(payment.amount, s.order.total);
        assert.deepEqual(movements.map(m => m.kind), ['RESERVE']);
      } else if (scenario === 'F1') {
        assert.equal(s.order.status, mode === 'saga' ? 'CANCELLED' : 'FAILED');
        assert.equal(reservation, null); assert.equal(payment, null); assert.deepEqual(ledger, []); assert.deepEqual(movements, []);
        assert(!traces.some(t => t.action.startsWith('charge')), 'charge must never be called after reserve reject');
      } else if (scenario === 'F2') {
        assert.equal(s.order.status, mode === 'saga' ? 'CANCELLED' : 'FAILED');
        assert.equal(reservation?.status, mode === 'saga' ? 'RELEASED' : 'HELD'); assert.equal(payment, null); assert.deepEqual(ledger, []);
        assert(!traces.some(t => t.action.startsWith('refund')), 'do not refund a rejected charge');
        assert.deepEqual(movements.map(m => m.kind), mode === 'saga' ? ['RESERVE','RELEASE'] : ['RESERVE']);
        const op = (await lab.request<{ status: string; httpStatus: number }>(mode, `/operations/${encodeURIComponent(`${mode}/${id}/charge`)}`, {}, 'payment')).body;
        assert.equal(op.status, 'FAILED'); assert.equal(op.httpStatus, 402);
      } else {
        assert.equal(s.order.status, mode === 'saga' ? 'CANCELLED' : 'FAILED');
        assert.equal(reservation?.status, mode === 'saga' ? 'RELEASED' : 'HELD');
        assert.equal(payment?.status, mode === 'saga' ? 'REFUNDED' : 'CHARGED');
        const charges = ledger.filter(e => e.kind === 'CHARGE'); const refunds = ledger.filter(e => e.kind === 'REFUND');
        assert.equal(charges.length, 1); assert.equal(refunds.length, mode === 'saga' ? 1 : 0);
        if (mode === 'saga') {
          assert.notEqual(charges[0].id, refunds[0].id); assert.notEqual(charges[0].operation_id, refunds[0].operation_id);
          assert.equal(charges[0].payment_id, refunds[0].payment_id); assert.equal(charges[0].amount, refunds[0].amount);
          const refundIndex = traces.findIndex(t => t.action === 'refund' && t.http_status === 200);
          const releaseIndex = traces.findIndex(t => t.action === 'release' && t.http_status === 200);
          assert(refundIndex >= 0 && releaseIndex > refundIndex, 'refund must finish before release');
          assert.deepEqual(movements.map(m => m.kind), ['RESERVE','RELEASE']);
        }
      }
      if (mode === 'saga') {
        const saga = (await lab.request<SagaView>(mode, `/orders/${id}/saga`)).body;
        assert.equal(saga.saga_id, id); assert.equal(saga.phase, 'done'); assert.equal(saga.intent, null); assert.deepEqual(saga.pending, []);
        assert(saga.history.length >= 3); assert(saga.operations.confirm); assert(saga.operations.cancel);
        assert(saga.localOperations.some(op => op.action === (scenario === 'H' ? 'confirm' : 'cancel') && op.status === 'SUCCEEDED'));
      }
    });
  }
}

test('only baseline and saga policies; create replay remains idempotent', async () => {
  const key = randomUUID();
  const attempts = await Promise.all(Array.from({ length: 5 }, () => lab.create('saga', 'H', key)));
  assert(attempts.every(r => r.status === 202)); assert.equal(new Set(attempts.map(r => r.body.order.id)).size, 1);
  assert.equal((await lab.create('saga', 'H', key, 2)).status, 409);
  const s = await lab.settled('saga', attempts[0].body.order.id); assert.equal(s.payment.data!.ledger.length, 1);
  const list = (await lab.request<Order[]>('saga', '/orders')).body; assert.equal(list.length, 1);
  const config = (await lab.request<Record<string,unknown>>('saga','/config')).body;
  assert.equal(config.maxRetries,3); assert.equal(config.capabilities,undefined);
  assert.equal((await lab.create('saga','H',key)).body.order.id,s.order.id);
});

test('participant replay cannot repeat stock movement, charge, refund, or release', async () => {
  const r = await lab.create('saga', 'F3'); const s = await lab.settled('saga', r.body.order.id);
  for (const [service, path, action, extra] of [
    ['inventory','/reservations','reserve',{ sku: s.order.sku, quantity: 1 }],
    ['payment','/payments','charge',{ amount: s.order.total }],
    ['payment',`/payments/${s.order.payment_id}/refund`,'refund',{}],
    ['inventory',`/reservations/${s.order.reservation_id}/release`,'release',{}],
  ] as const) {
    for (let i=0;i<2;i++) {
      const replay = await lab.request<ResultBody>('saga', path, { method: 'POST', body: JSON.stringify({ operationId: `saga/${s.order.id}/${action}`, orderId: s.order.id, scenario: 'F3', ...extra }) }, service);
      assert(replay.status === 200 || replay.status === 201);
    }
  }
  const after = (await lab.request<Snapshot>('saga', `/orders/${s.order.id}/snapshot`)).body;
  assert.equal(after.payment.data!.ledger.length, 2); assert.equal(after.inventory.data!.reservation!.status, 'RELEASED');
  assert.equal(after.inventory.data!.stock.find(p => p.sku === 'LAMP-01')!.available, 20);
  assert.equal((await lab.request<Movement[]>('saga', `/movements?orderId=${s.order.id}`, {}, 'inventory')).body.length, 2);
  assert.equal((await lab.request('saga','/payments',{ method:'POST',body:JSON.stringify({operationId:`saga/${s.order.id}/charge`,orderId:s.order.id,scenario:'F3',amount:1})},'payment')).status,409);
});

test('F5 persists pending refund/release until explicit restore and resume by saga_id', async () => {
  const r = await lab.create('saga','F5'); const id = r.body.saga_id;
  await waitFor(async () => (await lab.request<{ order: Order }>('saga',`/orders/${id}`)).body.order.last_error === 'REFUND_TEMPORARILY_UNAVAILABLE');
  const pending = (await lab.request<Snapshot>('saga',`/orders/${id}/snapshot`)).body;
  assert.equal(pending.order.status,'COMPENSATING'); assert.equal(pending.payment.data!.payment!.status,'CHARGED'); assert.equal(pending.inventory.data!.reservation!.status,'HELD');
  const saga = (await lab.request<SagaView>('saga',`/sagas/${id}`)).body;
  assert.deepEqual(saga.pending,['refund','release','cancel']); assert.equal(saga.intent!.action,'refund');
  assert.equal((await lab.request('saga',`/faults/${id}/restore`,{method:'POST',body:'{}'},'payment')).status,200);
  assert.equal((await lab.request('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'})).status,202);
  const done = await lab.settled('saga',id);
  assert.equal(done.order.status,'CANCELLED'); assert.equal(done.payment.data!.ledger.length,2); assert.equal(done.inventory.data!.reservation!.status,'RELEASED');
});

test('Saga reconciles a real response timeout with the same charge ID', async () => {
  const r = await lab.create('saga','F4',randomUUID(),1);
  await lab.marker('PAYMENT_CHARGE_COMMITTED_BEFORE_RESPONSE',r.body.order.id);
  const s = await lab.settled('saga',r.body.order.id); assert.equal(s.order.status,'CONFIRMED'); assert.equal(s.payment.data!.ledger.length,1);
  const traces = (await lab.request<Trace[]>('saga',`/orders/${s.order.id}/traces`)).body;
  assert(traces.some(t=>t.action==='charge' && t.transport_error==='TIMEOUT')); assert(traces.some(t=>t.action==='charge.query' && t.http_status===200)); assert.equal(traces.filter(t=>t.action==='charge').length,1);
});

test('Saga F6 crashes after refund commit and resumes compensation with the old ID', async () => {
  const r = await lab.create('saga','F6'); const id = r.body.saga_id;
  await lab.marker('COORDINATOR_BEFORE_REFUND_OUTCOME',id);
  const before = (await lab.request<{ order: Order; saga: SagaView }>('saga',`/orders/${id}`)).body;
  assert.equal(before.order.status,'COMPENSATING');assert.equal(before.order.step,'REFUND_PENDING');assert(before.order.payment_id); assert.equal(before.saga.intent!.operationId,`saga/${id}/refund`);
  const beforeState = (await lab.request<Snapshot>('saga',`/orders/${id}/snapshot`)).body;
  assert.equal(beforeState.payment.data!.payment!.status,'REFUNDED');assert.equal(beforeState.inventory.data!.reservation!.status,'HELD');
  const traceBefore = (await lab.request<Trace[]>('saga',`/orders/${id}/traces`)).body;
  assert(traceBefore.some(t=>t.action==='refund' && t.complete===0 && t.http_status===null));assert(!traceBefore.some(t=>t.action.startsWith('release')));
  await lab.stop('order'); await lab.start('order');
  const final = await lab.settled('saga',id); assert.equal(final.order.status,'CANCELLED'); assert.equal(final.payment.data!.ledger.length,2);assert.equal(final.inventory.data!.reservation!.status,'RELEASED');
  const after = (await lab.request<SagaView>('saga',`/sagas/${id}`)).body;
  assert.equal(after.operations.refund,before.saga.operations.refund);
  const traces = (await lab.request<Trace[]>('saga',`/orders/${id}/traces`)).body;
  assert(traces.some(t=>t.action==='refund.query' && t.http_status===200)); assert.equal(traces.filter(t=>t.action==='refund').length,1);assert.equal(traces.filter(t=>t.action==='release').length,1);
});

test('UI launcher survives Order crash and independently reads Payment and Inventory', async () => {
  const r = await lab.create('saga','H'); await lab.settled('saga',r.body.order.id); await lab.stop('order');
  const health = await fetch(`${lab.url()}/lab/health`).then(r=>r.json()) as {services:{service:string;available:boolean}[]};
  assert.equal(health.services.find(s=>s.service==='order')!.available,false);
  assert.equal(health.services.find(s=>s.service==='inventory')!.available,true);
  assert.equal((await fetch(`${lab.url()}/api/saga/payments/ledger?orderId=${r.body.order.id}`).then(r=>r.json()) as unknown[]).length,1);
  assert.equal((await fetch(`${lab.url()}/api/saga/inventory/movements?orderId=${r.body.order.id}`).then(r=>r.json()) as unknown[]).length,1);
  assert.equal((await fetch(lab.url())).status,200);
});

test('Saga recovers an interrupted step after Order restart', async () => {
  await lab.stop('payment');
  const r=await lab.create('saga','H');
  await waitFor(async()=> (await lab.request<{order:Order}>('saga',`/orders/${r.body.order.id}`)).body.order.status==='RECOVERING');
  await lab.stop('order'); await lab.start('payment'); await lab.start('order');
  const s=await lab.settled('saga',r.body.order.id);assert.equal(s.order.status,'CONFIRMED');assert.equal(s.payment.data!.ledger.length,1);
});

test('input validation, server prices, shared state and natural stock rejection', async () => {
  for (const quantity of [0,-1,1.5,'1',100]) assert.equal((await lab.request('saga','/orders',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:JSON.stringify({sku:'LAMP-01',quantity})})).status,400);
  assert.equal((await lab.request('saga','/payments',{method:'POST',body:'null'},'payment')).status,400);
  const r = await lab.request<{order:Order}>('saga','/orders',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:JSON.stringify({sku:'LAMP-01',quantity:1,total:1})});
  const s=await lab.settled('saga',r.body.order.id); assert.equal(s.payment.data!.payment!.amount,450000);
  assert.equal((await lab.request('baseline',`/orders/${s.order.id}`)).status,200);
  const stock=(await lab.request<{sku:string;available:number}[]>('baseline','/stock',{},'inventory')).body;assert.equal(stock[0].available,19);
  const reject=await lab.create('saga','H',randomUUID(),99);const cancelled=await lab.settled('saga',reject.body.order.id);
  assert.equal(cancelled.order.status,'CANCELLED');assert.equal(cancelled.inventory.data!.reservation,null);assert.equal(cancelled.payment.data!.payment,null);
});

test('legacy six-DB schema migrates without losing orders, stock, ledger or create idempotency', async () => {
  await lab.close();
  lab = await isolatedLab('migration');
  const directory = join(lab.env.DATA_DIR!, 'saga'); mkdirSync(directory, { recursive: true });
  const id = 'legacy-order'; const key = 'legacy-create'; const time = new Date().toISOString();
  const reservation = { id:'legacy-reservation',order_id:id,sku:'LAMP-01',quantity:1,status:'HELD' };
  const payment = { id:'legacy-payment',order_id:id,amount:450000,status:'CHARGED' };
  const ids = {reserve:`saga/${id}/reserve`,charge:`saga/${id}/charge`,refund:`saga/${id}/refund`,release:`saga/${id}/release`};
  const oldOps = 'CREATE TABLE operations (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,action TEXT NOT NULL,order_id TEXT NOT NULL,http_status INTEGER NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);';
  const orderDb = new DatabaseSync(join(directory,'order.sqlite'));
  orderDb.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,sku TEXT NOT NULL,product_name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,total INTEGER NOT NULL,scenario TEXT NOT NULL,status TEXT NOT NULL,step TEXT NOT NULL,reservation_id TEXT,payment_id TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE sagas(order_id TEXT PRIMARY KEY,operations TEXT NOT NULL,decision TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);`);
  orderDb.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,key,JSON.stringify(['LAMP-01',1,'H']),'LAMP-01','Legacy lamp',1,450000,450000,'H','CONFIRMED','DONE',reservation.id,payment.id,null,time,time);
  orderDb.prepare('INSERT INTO sagas(order_id,operations,decision) VALUES (?,?,?)').run(id,JSON.stringify(ids),'FORWARD'); orderDb.close();
  const inventoryDb = new DatabaseSync(join(directory,'inventory.sqlite')); inventoryDb.exec(oldOps);
  inventoryDb.exec("CREATE TABLE stock(sku TEXT PRIMARY KEY,available INTEGER NOT NULL); INSERT INTO stock VALUES ('LAMP-01',19); CREATE TABLE reservations(id TEXT PRIMARY KEY,order_id TEXT UNIQUE,sku TEXT,quantity INTEGER,status TEXT);");
  inventoryDb.prepare('INSERT INTO reservations VALUES (?,?,?,?,?)').run(reservation.id,id,'LAMP-01',1,'HELD');
  inventoryDb.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run(ids.reserve,'legacy-reserve','reserve',id,201,JSON.stringify({reservation}),time); inventoryDb.close();
  const paymentDb = new DatabaseSync(join(directory,'payment.sqlite')); paymentDb.exec(oldOps);
  paymentDb.exec('CREATE TABLE payments(id TEXT PRIMARY KEY,order_id TEXT UNIQUE,amount INTEGER,status TEXT); CREATE TABLE ledger_entries(id TEXT PRIMARY KEY,payment_id TEXT,kind TEXT,amount INTEGER,operation_id TEXT UNIQUE,created_at TEXT);');
  paymentDb.prepare('INSERT INTO payments VALUES (?,?,?,?)').run(payment.id,id,450000,'CHARGED');
  paymentDb.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run(ids.charge,'legacy-charge','charge',id,201,JSON.stringify({payment}),time);
  paymentDb.prepare('INSERT INTO ledger_entries VALUES (?,?,?,?,?,?)').run('legacy-ledger',payment.id,'CHARGE',450000,ids.charge,time); paymentDb.close();
  await lab.startAll();
  const replay=await lab.create('saga','H',key,1);assert.equal(replay.status,202);assert.equal(replay.body.order.id,id);assert.equal(replay.body.replayed,true);assert.equal(replay.body.order.version,'v3');
  const s=await lab.settled('saga',id);assert.equal(s.payment.data!.ledger.length,1);assert.equal(s.inventory.data!.stock.find(p=>p.sku==='LAMP-01')!.available,19);
  const movements=(await lab.request<Movement[]>('saga',`/movements?orderId=${id}`,{},'inventory')).body;
  assert.equal(movements.length,1);assert.equal(movements[0].source,'IMPORTED_OPERATION');assert.equal(movements[0].available_after,null);
  const saga=(await lab.request<SagaView>('saga',`/sagas/${id}`)).body;assert.equal(saga.operations.charge,ids.charge);assert(saga.operations.confirm);
});
