import { test,beforeEach,afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isolatedLab,waitFor,type Lab,type Snapshot } from '../scripts/lab.js';
import type { Mode,Order,Wallet } from '../src/shared/types.js';
let lab:Lab;
beforeEach(async()=>{lab=await isolatedLab('manual');await lab.startAll();});
afterEach(async()=>{await lab?.close();});
async function create(mode:Mode){
 const r=await lab.request<{order:Order}>(mode,'/orders',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:JSON.stringify({sku:'LAMP-01',quantity:1,checkout_mode:'manual'})});
 assert.equal(r.status,202);
 await waitFor(async()=> (await lab.request<{order:Order}>(mode,`/orders/${r.body.order.id}`)).body.order.status==='AWAITING_PAYMENT');
 return r.body.order.id;
}
for(const mode of ['baseline','saga'] as const){
 test(`manual ${mode}: reserve first, pay explicitly, debit once`,async()=>{
  const id=await create(mode);
  const before=(await lab.request<Snapshot>(mode,`/orders/${id}/snapshot`)).body;
  assert.equal(before.order.step,'AWAIT_PAYMENT');assert.equal(before.inventory.data!.reservation!.status,'HELD');assert.equal(before.payment.data!.payment,null);
  const wallets=(await lab.request<Wallet[]>(mode,'/wallets',{},'payment')).body;assert.equal(wallets[0].balance,10000000);
  const paid=await Promise.all(Array.from({length:4},()=>lab.request<{order:Order}>(mode,`/orders/${id}/pay`,{method:'POST',body:JSON.stringify({walletId:'main',amount:1})})));
  assert(paid.every(r=>r.status===202));
  const final=await lab.settled(mode,id);assert.equal(final.order.status,'CONFIRMED');assert.equal(final.payment.data!.payment!.amount,450000);assert.equal(final.payment.data!.ledger.length,1);
  assert.equal((await lab.request<Wallet[]>(mode,'/wallets',{},'payment')).body[0].balance,9550000);
  assert.equal((await lab.request(mode,`/orders/${id}/pay`,{method:'POST',body:JSON.stringify({walletId:'limited'})})).status,409);
  assert.equal((await lab.request(mode,`/orders/${id}/cancel`,{method:'POST',body:'{}'})).status,409);
 });
 test(`manual ${mode}: insufficient funds is a real DB decision`,async()=>{
  const id=await create(mode);
  assert.equal((await lab.request(mode,`/orders/${id}/pay`,{method:'POST',body:JSON.stringify({walletId:'limited'})})).status,202);
  const final=await lab.settled(mode,id);
  assert.equal(final.order.status,mode==='baseline'?'FAILED':'CANCELLED');assert.equal(final.order.failure_reason,'INSUFFICIENT_FUNDS');
  assert.equal(final.inventory.data!.reservation!.status,mode==='baseline'?'HELD':'RELEASED');assert.equal(final.payment.data!.payment,null);assert.deepEqual(final.payment.data!.ledger,[]);
  assert.equal((await lab.request<Wallet[]>(mode,'/wallets',{},'payment')).body.find(w=>w.id==='limited')!.balance,100000);
 });
}
test('manual cancel before payment releases inventory and never debits a wallet',async()=>{
 const id=await create('saga');
 const results=await Promise.all([1,2].map(()=>lab.request('saga',`/orders/${id}/cancel`,{method:'POST',body:'{}'})));assert(results.every(r=>r.status===202));
 const s=await lab.settled('saga',id);assert.equal(s.order.status,'CANCELLED');assert.equal(s.order.failure_reason,'USER_CANCELLED');assert.equal(s.inventory.data!.reservation!.status,'RELEASED');assert.equal(s.payment.data!.payment,null);
 assert.equal((await lab.request('saga',`/orders/${id}/pay`,{method:'POST',body:'{}'})).status,409);
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,10000000);
});
test('manual waiting state survives restart without automatically charging',async()=>{
 const id=await create('saga');await lab.stop('order');await lab.start('order');
 const s=(await lab.request<Snapshot>('saga',`/orders/${id}/snapshot`)).body;assert.equal(s.order.status,'AWAITING_PAYMENT');assert.equal(s.payment.data!.payment,null);
 assert.equal((await lab.request('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'})).status,409);
 await lab.request('saga',`/orders/${id}/pay`,{method:'POST',body:'{}'});assert.equal((await lab.settled('saga',id)).order.status,'CONFIRMED');
});
test('manual checkout rejects preset faults and fingerprint distinguishes automatic requests',async()=>{
 const key=randomUUID();const body={sku:'LAMP-01',quantity:1,checkout_mode:'manual',version:'v3'};
 assert.equal((await lab.request('saga','/orders',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({...body,scenario:'F3'})})).status,422);
 const r=await lab.request<{order:Order}>('saga','/orders',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});assert.equal(r.status,202);
 assert.equal((await lab.request('saga','/orders',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({...body,checkout_mode:'automatic'})})).status,409);
});

test('refund credits the wallet exactly once while preserving charge and refund ledger',async()=>{
 const r=await lab.create('saga','F3');const s=await lab.settled('saga',r.body.order.id);
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,10000000);
 const replay=await lab.request('saga',`/payments/${s.order.payment_id}/refund`,{method:'POST',body:JSON.stringify({orderId:s.order.id,operationId:`saga/${s.order.id}/refund`,scenario:'F3'})},'payment');assert.equal(replay.status,200);
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,10000000);
 assert.equal((await lab.request<Snapshot>('saga',`/orders/${s.order.id}/snapshot`)).body.payment.data!.ledger.length,2);
});
test('concurrent charges cannot spend a wallet below zero',async()=>{
 const results=await Promise.all(['one','two'].map(id=>lab.request('saga','/payments',{method:'POST',body:JSON.stringify({orderId:id,operationId:`charge-${id}`,amount:7000000,walletId:'main'})},'payment')));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,402]);
 assert.equal((await lab.request<Wallet[]>('saga','/wallets',{},'payment')).body[0].balance,3000000);
});
