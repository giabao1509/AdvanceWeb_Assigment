import { test,beforeEach,afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Lab,isolatedLab,waitFor } from '../scripts/lab.js';
import type { Order,Movement,LedgerEntry,Reservation,Payment } from '../src/shared/types.js';
import { buildLogEntries,type Trace,type WorkflowEvent,type ProcessEvent } from '../public/log-format.js';
let lab:Lab;
beforeEach(async()=>{lab=await isolatedLab('observability',{SAGA_MAX_RETRIES:'0'});await lab.startAll();});
afterEach(async()=>{await lab.close();});
interface Item {sku:string;available:number;held:number}
test('inventory overview and filtered movement history reflect reservations shared by both policies',async()=>{
 const ids:string[]=[];
 for(const [sku,quantity] of [['LAMP-01',2],['CUP-01',3]] as const){
  const r=await lab.request<{order:Order}>('saga','/orders',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({sku,quantity,checkout_mode:'manual'})});
  ids.push(r.body.order.id);await waitFor(async()=> (await lab.request<{order:Order}>('saga',`/orders/${r.body.order.id}`)).body.order.status==='AWAITING_PAYMENT');
 }
 let items=(await lab.request<Item[]>('saga','/items',{},'inventory')).body;
 assert.deepEqual(items.map(i=>[i.sku,i.available,i.held]),[['LAMP-01',18,2],['CUP-01',27,3],['BAG-01',15,0]]);
 await lab.request('saga',`/orders/${ids[0]}/cancel`,{method:'POST',body:'{}'});await lab.settled('saga',ids[0]);
 items=(await lab.request<Item[]>('saga','/items',{},'inventory')).body;assert.equal(items[0].available,20);assert.equal(items[0].held,0);
 const rows=(await lab.request<Movement[]>('saga','/movements?sku=LAMP-01&kind=RELEASE',{},'inventory')).body;
 assert.equal(rows.length,1);assert.equal(rows[0].sku,'LAMP-01');assert.equal(rows[0].delta,2);assert.equal(rows[0].order_id,ids[0]);
 assert.equal((await lab.request('saga','/movements?kind=BOGUS',{},'inventory')).status,400);
 const orderRows=(await lab.request<Movement[]>('saga',`/movements?orderId=${ids[0]}`,{},'inventory')).body;assert.deepEqual(orderRows.map(m=>m.kind),['RESERVE','RELEASE']);
 assert.equal((await lab.request<Movement[]>('baseline','/movements',{},'inventory')).body.length,3);
 await lab.stop('order');assert.equal((await fetch(`${lab.url()}/api/saga/inventory/items`)).status,200);
});

test('restore/resume HTTP and service control are correlated, durable and visible after launcher restart',async()=>{
 const create=await fetch(`${lab.url()}/api/saga/orders`,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'observe-create'},body:JSON.stringify({sku:'LAMP-01',quantity:1,scenario:'F5'})});
 const id=((await create.json()) as {order_id:string}).order_id;
 await waitFor(async()=> (await lab.request<{retry_exhausted:number}>('saga',`/sagas/${id}`)).body.retry_exhausted===1);
 for(const path of [`/api/saga/payments/faults/${id}/restore`,`/api/saga/sagas/${id}/resume`])assert.equal((await fetch(lab.url()+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,path.endsWith('resume')?202:200);
 await lab.settled('saga',id);
 for(const action of ['stop','start'])assert.equal((await fetch(`${lab.url()}/lab/services/payment/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderId:id,mode:'saga'})})).status,200);
 const getEvents=async()=>fetch(`${lab.url()}/lab/events?orderId=${id}&mode=saga`).then(r=>r.json()) as Promise<ProcessEvent[]>;
 let events=await getEvents();
 assert(events.some(e=>e.event==='CLIENT_HTTP' && e.orderId===id && e.path?.endsWith('/restore') && e.status===200));
 assert(events.some(e=>e.event==='CLIENT_HTTP' && e.orderId===id && e.path?.endsWith('/resume') && e.status===202));
 assert(events.some(e=>e.event==='SERVICE_CONTROL_SUCCEEDED' && e.orderId===id && e.action==='start'));
 const directory=lab.directory;const ports=lab.ports;await lab.close();lab=new Lab(directory,ports,{SAGA_MAX_RETRIES:'0'});await lab.startAll();events=await getEvents();
 assert(events.some(e=>e.event==='CLIENT_HTTP' && e.orderId===id && e.path?.endsWith('/restore')));
 assert(events.some(e=>e.event==='SERVICE_CONTROL_SUCCEEDED' && e.orderId===id && e.action==='start'));
});

test('global inventory and ledger histories include records beyond 200 through both mode URLs',async()=>{
 for(let i=0;i<103;i++){
  const orderId=`history-${i}`;
  const [reserve,charge]=await Promise.all([
   lab.request<{reservation:Reservation}>('saga','/reservations',{method:'POST',body:JSON.stringify({orderId,operationId:`${orderId}/reserve`,sku:'LAMP-01',quantity:1})},'inventory'),
   lab.request<{payment:Payment}>('saga','/payments',{method:'POST',body:JSON.stringify({orderId,operationId:`${orderId}/charge`,amount:1000})},'payment'),
  ]);
  assert.equal(reserve.status,201);assert.equal(charge.status,201);
  const results=await Promise.all([
   lab.request('saga',`/reservations/${reserve.body.reservation.id}/release`,{method:'POST',body:JSON.stringify({orderId,operationId:`${orderId}/release`})},'inventory'),
   lab.request('saga',`/payments/${charge.body.payment.id}/refund`,{method:'POST',body:JSON.stringify({orderId,operationId:`${orderId}/refund`})},'payment'),
  ]);
  assert(results.every(r=>r.status===200));
 }
 const movements=(await lab.request<Movement[]>('saga','/movements',{},'inventory')).body;
 const ledger=(await lab.request<LedgerEntry[]>('saga','/ledger',{},'payment')).body;
 assert.equal(movements.length,206);assert.equal(ledger.length,206);
 assert.equal(movements[0].order_id,'history-102');assert.equal(movements.at(-1)!.order_id,'history-0');
 assert.equal(ledger[0].kind,'REFUND');assert.equal(ledger.at(-1)!.order_id,'history-0');assert.equal(ledger[0].wallet_id,'main');
 assert.equal((await lab.request<Movement[]>('saga','/movements?kind=RELEASE',{},'inventory')).body.length,103);
 assert.equal((await lab.request<LedgerEntry[]>('baseline','/ledger',{},'payment')).body.length,206);
 assert.equal((await lab.request<Movement[]>('baseline','/movements',{},'inventory')).body.length,206);
 const orderLedger=(await lab.request<LedgerEntry[]>('saga','/ledger?orderId=history-0',{},'payment')).body;
 assert.deepEqual(orderLedger.map(e=>e.kind),['CHARGE','REFUND']);
 await lab.stop('order');
 assert.equal((await fetch(`${lab.url()}/api/saga/payments/ledger`).then(r=>r.json()) as LedgerEntry[]).length,206);
});

test('F6 keeps the incomplete original trace and links the later HTTP query and local recovery events',async()=>{
 const r=await lab.create('saga','F6');const id=r.body.saga_id;await lab.marker('COORDINATOR_BEFORE_REFUND_OUTCOME',id);
 await lab.stop('order');await lab.start('order');const final=await lab.settled('saga',id);assert.equal(final.payment.data!.ledger.length,2);
 const traces=(await lab.request<Trace[]>('saga',`/orders/${id}/traces`)).body;
 const saga=(await lab.request<{history:WorkflowEvent[]}>('saga',`/sagas/${id}`)).body;
 const entries=buildLogEntries(traces,saga.history,[]);const original=entries.find(e=>e.trace?.action==='refund')!;
 assert.equal(original.trace!.complete,0);assert.equal(original.trace!.http_status,null);
 assert(original.reconciledBy);assert.equal(original.reconciledBy.http_status,200);assert(original.message.includes('đối soát'));
 assert(saga.history.some(e=>e.event==='RECOVERY_STARTED'));assert(saga.history.some(e=>e.event==='OPERATION_RECONCILED'));
 assert(entries.some(e=>e.kind==='workflow' && e.title==='Đã hoàn tất hủy đơn'));
 assert(!traces.some(t=>t.action==='confirm'));
 const firstQuery=entries.find(e=>e.trace?.action==='reserve.query')!;assert.equal(firstQuery.trace!.http_status,404);assert.equal(firstQuery.tone,'normal');
});
