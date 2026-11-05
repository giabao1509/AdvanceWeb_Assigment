import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import { isolatedLab, waitFor, type Lab, type Snapshot } from '../scripts/lab.js';
import type { Order, Saga, Wallet } from '../src/shared/types.js';

let lab:Lab;
beforeEach(async()=>{lab=await isolatedLab('retry',{RECOVERY_INTERVAL_MS:'80',SAGA_MAX_RETRIES:'3'});await lab.startAll();});
afterEach(async()=>{await lab.close();});
interface Trace {action:string;operation_id:string;http_status:number|null}
const saga=(id:string)=>lab.request<Saga>('saga',`/sagas/${id}`).then(r=>r.body);
const traces=(id:string)=>lab.request<Trace[]>('saga',`/orders/${id}/traces`).then(r=>r.body);
async function exhausted(id:string){
 await waitFor(async()=>!!(await saga(id)).retry_exhausted,12000,'retry limit');
 return (await lab.request<Snapshot>('saga',`/orders/${id}/snapshot`)).body;
}

test('three retries means four calls; exhausted compensation survives restart and explicit resume is idempotent',async()=>{
 const r=await lab.create('saga','F5');const id=r.body.order.id;
 const s=await exhausted(id);const state=await saga(id);
 assert.equal(s.order.status,'COMPENSATING');assert.equal(s.order.step,'REFUND_PENDING');
 assert.equal(state.retry_count,3);assert.equal(state.retry_limit,3);assert.equal(state.attempts,4);assert.equal(state.resume_blocked,1);
 assert.equal(s.payment.data!.payment!.status,'CHARGED');assert.equal(s.inventory.data!.reservation!.status,'HELD');
 assert.equal(s.payment.data!.ledger.length,1);
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,9550000);
 const before=await traces(id);const refunds=before.filter(t=>t.action==='refund');
 assert.equal(refunds.length,4);assert(refunds.every(t=>t.http_status===503));assert.equal(new Set(refunds.map(t=>t.operation_id)).size,1);
 assert(!before.some(t=>t.action==='release'));
 await lab.stop('order');
 const legacy=new DatabaseSync(join(lab.env.DATA_DIR!,'order.sqlite'));
 try{legacy.prepare("UPDATE orders SET status='REQUIRES_REVIEW' WHERE id=?").run(id);}finally{legacy.close();}
 await lab.start('order');
 assert.equal((await lab.request<{order:Order}>('saga',`/orders/${id}`)).body.order.status,'COMPENSATING');
 // Observe several worker periods: exhaustion must not silently restart the workflow.
 await delay(350);assert.equal((await traces(id)).length,before.length);assert.equal((await saga(id)).retry_count,3);
 await lab.request('saga',`/faults/${id}/restore`,{method:'POST',body:'{}'},'payment');
 const resume=await Promise.all(Array.from({length:5},()=>lab.request('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'})));
 assert(resume.every(r=>r.status===202));
 const done=await lab.settled('saga',id);assert.equal(done.order.status,'CANCELLED');assert.equal(done.payment.data!.ledger.length,2);assert.equal(done.inventory.data!.reservation!.status,'RELEASED');
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,10000000);
 const history=(await lab.request<{history:{event:string}[]}>('saga',`/sagas/${id}`)).body.history;
 assert.equal(history.filter(e=>e.event==='RESUME_REQUESTED').length,1);
 assert.deepEqual((await saga(id)).operations,state.operations);
});

test('zero retries permits the first call only',async()=>{
 await lab.close();lab=await isolatedLab('retry-zero',{SAGA_MAX_RETRIES:'0',RECOVERY_INTERVAL_MS:'80'});await lab.startAll();
 const r=await lab.create('saga','F5');await exhausted(r.body.order.id);
 assert.equal((await saga(r.body.order.id)).retry_count,0);assert.equal((await traces(r.body.order.id)).filter(t=>t.action==='refund').length,1);
});

test('each new step has its own budget; restoring a service alone does not bypass an exhausted budget',async()=>{
 await lab.stop('inventory');await lab.stop('payment');
 const r=await lab.create('saga');const id=r.body.order.id;
 assert.equal((await exhausted(id)).order.step,'RESERVE_PENDING');
 assert.equal((await saga(id)).retry_count,3);
 await lab.start('inventory');
 await lab.request('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'});
 await waitFor(async()=>{const s=await lab.request<{order:Order}>('saga',`/orders/${id}`);return s.body.order.step==='CHARGE_PENDING' && !!(await saga(id)).retry_exhausted;});
 const state=await saga(id);assert.equal(state.retry_count,3);assert.equal(state.attempts,8);
 await lab.start('payment');const before=(await traces(id)).length;
 await delay(350);assert.equal((await traces(id)).length,before);
 await lab.request('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'});
 const final=await lab.settled('saga',id);assert.equal(final.order.status,'CONFIRMED');assert.equal(final.payment.data!.ledger.length,1);
});

test('restart during retry retains the remaining budget',async()=>{
 const r=await lab.create('saga','F5');const id=r.body.order.id;
 await waitFor(async()=> (await saga(id)).retry_count>=1);
 await lab.stop('order');await lab.start('order');await exhausted(id);
 assert.equal((await saga(id)).retry_count,3);
 assert((await traces(id)).filter(t=>t.action==='refund').length<=4);
});

test('resume while running cannot refresh the retry budget',async()=>{
 const r=await lab.create('saga','F5');const id=r.body.order.id;
 await waitFor(async()=> (await saga(id)).retry_count>=1);
 const res=await lab.request<{already_running:boolean}>('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'});
 assert.equal(res.body.already_running,true);
 await exhausted(id);assert.equal((await traces(id)).filter(t=>t.action==='refund').length,4);
});

test('Baseline never schedules a retry',async()=>{
 await lab.stop('payment');const r=await lab.create('baseline');
 const done=await lab.settled('baseline',r.body.order.id);assert.equal(done.order.status,'REQUIRES_REVIEW');
 const before=await lab.request<Trace[]>('baseline',`/orders/${r.body.order.id}/traces`);
 await delay(350);const after=await lab.request<Trace[]>('baseline',`/orders/${r.body.order.id}/traces`);
 assert.equal(before.body.filter(t=>t.action==='charge').length,1);assert.equal(after.body.length,before.body.length);
});
