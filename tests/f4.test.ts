import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {Lab,isolatedLab,waitFor} from '../scripts/lab.js';
import {F4Recovery} from '../scripts/f4-recovery.js';
import type {Order,Saga,Wallet} from '../src/shared/types.js';
import type {Trace,WorkflowEvent} from '../public/log-format.js';
let lab:Lab;
beforeEach(async()=>{lab=await isolatedLab('f4',{AUTO_KILL_MARKERS:'true',SAGA_MAX_RETRIES:'1',RECOVERY_INTERVAL_MS:'80',F4_DOWNTIME_MS:'1200'});await lab.startAll();});
afterEach(async()=>{await lab.close();});
const saga=(id:string)=>lab.request<Saga & {history:WorkflowEvent[]}>('saga',`/sagas/${id}`).then(r=>r.body);
const traces=(id:string)=>lab.request<Trace[]>('saga',`/orders/${id}/traces`).then(r=>r.body);
async function f4(mode:'baseline'|'saga'='saga',duration=1200,key=crypto.randomUUID()){
 const r=await lab.request<{order:Order}>(mode,'/orders',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({sku:'LAMP-01',quantity:1,scenario:'F4',f4_downtime_ms:duration})});assert.equal(r.status,202);return r.body.order.id;
}
async function waiting(id:string){
 await waitFor(async()=>!!(await saga(id)).retry_exhausted);const state=await saga(id);
 assert.equal(state.charge_uncertain,1);assert.equal(state.resume_blocked,1);
 const order=(await lab.request<{order:Order}>('saga',`/orders/${id}`)).body.order;assert.equal(order.status,'RECOVERING');assert.equal(order.step,'CHARGE_PENDING');return state;
}
async function exactlyOnce(id:string){
 const final=await lab.settled('saga',id);assert.equal(final.order.status,'CONFIRMED');assert.equal(final.inventory.data!.reservation!.status,'HELD');
 assert.deepEqual(final.payment.data!.ledger.map(e=>e.kind),['CHARGE']);
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,9550000);
 const calls=await traces(id);assert.equal(calls.filter(t=>t.action==='charge').length,1);assert(calls.some(t=>t.action==='charge.query' && t.http_status===200));
 assert.equal(new Set(calls.filter(t=>t.action.startsWith('charge')).map(t=>t.operation_id)).size,1);
 return final;
}

test('F4 retains RECOVERING after capped retries, pauses calls, then automatically reconciles the old charge',async()=>{
 const id=await f4();await lab.marker('F4_OUTAGE_STARTED',id);const state=await waiting(id);
 assert.equal(state.retry_count,1);
 const db=new DatabaseSync(join(lab.env.DATA_DIR!,'payment.sqlite'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get()!.n,1);assert.equal(db.prepare("SELECT balance FROM wallets WHERE id='main'").get()!.balance,9550000);}finally{db.close();}
 const count=(await traces(id)).length;await delay(250);assert.equal((await traces(id)).length,count);
 await exactlyOnce(id);const history=(await saga(id)).history;
 assert(history.some(e=>e.event==='PAYMENT_RECOVERY_WAIT'));assert.equal(history.filter(e=>e.event==='PAYMENT_RECOVERY_DETECTED').length,1);
 assert(!history.some(e=>['REQUIRES_REVIEW','CANCELLED'].includes(e.status)));assert(!history.some(e=>e.event==='RESUME_REQUESTED'));
});

test('F4 recovery before exhaustion completes through the original retry budget',async()=>{
 await lab.close();lab=await isolatedLab('f4-short',{AUTO_KILL_MARKERS:'true',SAGA_MAX_RETRIES:'3',RECOVERY_INTERVAL_MS:'1500'});await lab.startAll();
 const id=await f4('saga',100);await exactlyOnce(id);
 assert(!(await saga(id)).history.some(e=>e.event==='PAYMENT_RECOVERY_WAIT'));
});

test('Baseline remains REQUIRES_REVIEW even though Payment automatically comes back',async()=>{
 const id=await f4('baseline',100);await lab.marker('F4_RESTORE_COMPLETED',id);
 const final=await lab.settled('baseline',id);assert.equal(final.order.status,'REQUIRES_REVIEW');
 assert.equal(final.payment.data!.ledger.length,1);assert.equal((await lab.request<Trace[]>('baseline',`/orders/${id}/traces`)).body.filter(t=>t.action==='charge.query').length,0);
});

test('manual early restore cancels the timer without another restart or new charge',async()=>{
 const id=await f4('saga',1500);const marker=await lab.marker('F4_OUTAGE_STARTED',id);await waiting(id);
 const r=await fetch(`${lab.url()}/lab/services/payment/start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderId:id,mode:'saga'})});assert.equal(r.status,200);
 await exactlyOnce(id);const pid=lab.children.get('payment')!.pid;
 await delay(Math.max(0,Number(marker.restoreAt)-Date.now())+250);
 assert.equal(lab.children.get('payment')!.pid,pid);assert.equal(lab.events.filter(e=>e.event==='F4_RESTORE_COMPLETED').length,1);
 assert.equal((await fetch(`${lab.url()}/lab/health`).then(r=>r.json()) as {f4Recovery:unknown}).f4Recovery,null);
});

test('upgrade and restart of Order/launcher preserves the unknown charge and resumes without manual action',async()=>{
 const id=await f4('saga',60000);await waiting(id);
 await lab.stop('order');
 const old=new DatabaseSync(join(lab.env.DATA_DIR!,'order.sqlite'));
 try{old.prepare('UPDATE sagas SET charge_uncertain=0 WHERE order_id=?').run(id);old.prepare("UPDATE orders SET status='REQUIRES_REVIEW' WHERE id=?").run(id);}finally{old.close();}
 await lab.start('order');await waiting(id);
 const directory=lab.directory,ports=lab.ports,env=lab.env;await lab.close();lab=new Lab(directory,ports,env);await lab.startAll();
 await exactlyOnce(id);assert(!(await saga(id)).history.some(e=>e.event==='RESUME_REQUESTED'));
});

test('a healthy instance returning NOT_FOUND cannot trigger a fresh charge or unlimited query rounds',async()=>{
 const id=await f4('saga',60000);await waiting(id);let writes=0;
 const fake=createServer((req,res)=>{if(req.method!=='GET')writes++;res.setHeader('content-type','application/json');if(req.url==='/health')res.end(JSON.stringify({service:'payment',status:'ok',instanceId:'healthy-but-missing-operation'}));else{res.statusCode=404;res.end(JSON.stringify({error:'OPERATION_NOT_FOUND',instanceId:'healthy-but-missing-operation'}));}});
 await new Promise<void>(resolve=>fake.listen(lab.ports.payment,'127.0.0.1',resolve));
 try{
  await waitFor(async()=> (await saga(id)).last_payment_instance==='healthy-but-missing-operation' && !!(await saga(id)).retry_exhausted);
  await waiting(id);const count=(await traces(id)).length;await delay(300);assert.equal((await traces(id)).length,count);
  assert.equal(writes,0);assert.equal((await traces(id)).filter(t=>t.action==='charge').length,1);
 }finally{await new Promise<void>(resolve=>fake.close(()=>resolve()));}
});

test('launcher readiness failure remains visible and durable without announcing recovery or retrying indefinitely',async()=>{
 let starts=0;
 const controller=new F4Recovery(lab,async(service,action)=>{if(action==='start'){starts++;throw new Error('Payment readiness failed');}});
 try{
  await controller.interrupt({time:new Date().toISOString(),service:'payment',event:'PAYMENT_CHARGE_COMMITTED_BEFORE_RESPONSE',orderId:'readiness-failure',mode:'saga',downtimeMs:0});
  await waitFor(()=>controller.state?.status==='failed');
  assert(lab.events.some(e=>e.event==='F4_RESTORE_FAILED'));assert(!lab.events.some(e=>e.event==='F4_RESTORE_COMPLETED'));
  assert.equal(JSON.parse(readFileSync(join(lab.env.DATA_DIR!,'f4-recovery.json'),'utf8')).status,'failed');
  await delay(150);assert.equal(starts,1);
 }finally{await controller.close();}
});
