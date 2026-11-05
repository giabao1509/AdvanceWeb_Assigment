import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {restartOrderDemo} from '../scripts/demo-restart-order.js';
import {refundFailureDemo} from '../scripts/demo-refund-failure.js';

for(const scenario of ['F5','F6'] as const)test(`V3 ${scenario} writes three distinct recovery checkpoints and converges exactly once`,async()=>{
 const base=resolve('.local');mkdirSync(base,{recursive:true});const output=mkdtempSync(join(base,`v3-${scenario}-`));
 await (scenario==='F5'?refundFailureDemo:restartOrderDemo)(output);
 const phases=['01-before-stop','02-after-restart','03-converged'].map(p=>JSON.parse(readFileSync(join(output,`${scenario.toLowerCase()}-${p}.json`),'utf8')));
 const [before,after,done]=phases;
 assert.notEqual(before.pids.order,after.pids.order);assert.equal(after.pids.order,done.pids.order);
 assert.equal(before.snapshot.order.status,'COMPENSATING');assert.equal(after.snapshot.order.status,'COMPENSATING');
 assert.equal(after.snapshot.order.step,'REFUND_PENDING');assert.equal(done.snapshot.order.status,'CANCELLED');
 assert.deepEqual(before.saga.operations,after.saga.operations);assert.deepEqual(before.saga.operations,done.saga.operations);
 assert.equal(done.ledger.filter((e:{kind:string})=>e.kind==='REFUND').length,1);assert.equal(done.movements.filter((m:{kind:string})=>m.kind==='RELEASE').length,1);
 assert(Date.parse(before.capturedAt)<=Date.parse(after.capturedAt) && Date.parse(after.capturedAt)<=Date.parse(done.capturedAt));
 if(scenario==='F6'){
  assert.equal(before.snapshot.payment.data.payment.status,'REFUNDED');assert.equal(after.snapshot.inventory.data.reservation.status,'HELD');
  assert(after.traces.some((t:{action:string;complete:number})=>t.action==='refund' && !t.complete));
  assert.equal(done.traces.filter((t:{action:string})=>t.action==='refund').length,1);
 }
});
