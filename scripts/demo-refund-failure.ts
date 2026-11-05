import assert from 'node:assert/strict';
import {writeFileSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolatedLab,waitFor} from './lab.js';
import {captureCompensation,type PhaseObserver} from './compensation-capture.js';
export async function refundFailureDemo(output=resolve('evidence',`v3-f5-${new Date().toISOString().replace(/[:.]/g,'-')}`),observe?:PhaseObserver){
 const lab=await isolatedLab('refund-failure',{SAGA_MAX_RETRIES:'1',RECOVERY_INTERVAL_MS:'100'});
 try{
  await lab.startAll();const id=(await lab.create('saga','F5')).body.order.id;
  await waitFor(async()=>!!(await lab.request<{retry_exhausted:number}>('saga',`/sagas/${id}`)).body.retry_exhausted);
  const before=await captureCompensation(lab,id,'F5','01-before-stop',output,observe);
  assert.equal(before.snapshot.order.status,'COMPENSATING');assert.equal(before.snapshot.order.step,'REFUND_PENDING');
  assert.deepEqual(before.saga.pending,['refund','release','cancel']);assert.equal(before.saga.retry_count,1);
  assert.equal(before.snapshot.payment.data!.payment!.status,'CHARGED');assert.equal(before.snapshot.inventory.data!.reservation!.status,'HELD');
  await lab.stop('order');lab.env.PAUSE_RECOVERY_ON_START='true';await lab.start('order');
  const afterRestart=await captureCompensation(lab,id,'F5','02-after-restart',output,observe);
  assert.notEqual(afterRestart.pids.order,before.pids.order);assert.equal(afterRestart.snapshot.order.status,'COMPENSATING');
  assert.deepEqual(afterRestart.saga.operations,before.saga.operations);assert.deepEqual(afterRestart.saga.pending,before.saga.pending);
  assert.equal(afterRestart.saga.retry_count,1);assert.equal(afterRestart.saga.retry_exhausted,1);
  assert.equal(afterRestart.traces.length,before.traces.length);
  lab.continueRecovery();
  await lab.request('saga',`/faults/${id}/restore`,{method:'POST',body:'{}'},'payment');
  await lab.request('saga',`/sagas/${id}/resume`,{method:'POST',body:'{}'});
  const final=await lab.settled('saga',id);const converged=await captureCompensation(lab,id,'F5','03-converged',output,observe);
  assert.equal(final.order.status,'CANCELLED');assert.deepEqual(converged.ledger.map(e=>e.kind),['CHARGE','REFUND']);
  assert.equal(converged.movements.filter(m=>m.kind==='RELEASE').length,1);assert.equal(converged.wallets.find(w=>w.id==='main')!.balance,10000000);
  const refund=converged.traces.findIndex(t=>t.action==='refund' && t.http_status===200),release=converged.traces.findIndex(t=>t.action==='release');assert(refund>=0 && release>refund);
  writeFileSync(join(output,'refund-failure.json'),JSON.stringify({passed:true,phases:{before,afterRestart,converged},final,processEvents:lab.events},null,2));
  cpSync(join(lab.directory,'logs'),join(output,'refund-failure-logs'),{recursive:true});
  console.log('F5 saga: bounded compensation survives restart, refund then release once; three checkpoints saved');
  return final;
 }finally{await lab.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await refundFailureDemo();
