import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedLab } from './lab.js';
import {captureCompensation,type PhaseObserver} from './compensation-capture.js';

export async function restartOrderDemo(output = resolve('evidence',`v3-f6-${new Date().toISOString().replace(/[:.]/g,'-')}`),observe?:PhaseObserver) {
  const lab = await isolatedLab('restart-order');
  try {
    await lab.startAll();
    const created = await lab.create('saga', 'F6');
    const id = created.body.order.id;
    const marker = await lab.marker('COORDINATOR_BEFORE_REFUND_OUTCOME', id);
    const before=await captureCompensation(lab,id,'F6','01-before-stop',output,observe);
    assert.equal(before.snapshot.order.status,'COMPENSATING');assert.equal(before.snapshot.order.step,'REFUND_PENDING');
    assert.equal(before.saga.intent!.operationId,`saga/${id}/refund`);
    assert.equal(before.snapshot.payment.data!.payment!.status,'REFUNDED');
    assert.equal(before.snapshot.inventory.data!.reservation!.status,'HELD');
    assert(before.traces.some(t=>t.action==='refund' && t.complete===0));
    const oldPid = lab.children.get('order')!.pid;
    await lab.stop('order');
    lab.env.PAUSE_RECOVERY_ON_START='true';
    await lab.start('order');
    const afterRestart=await captureCompensation(lab,id,'F6','02-after-restart',output,observe);
    assert.notEqual(afterRestart.pids.order,oldPid);
    assert.equal(afterRestart.snapshot.order.step,'REFUND_PENDING');
    assert.deepEqual(afterRestart.saga.operations,before.saga.operations);
    assert.equal(afterRestart.movements.filter(m=>m.kind==='RELEASE').length,0);
    lab.continueRecovery();
    const final = await lab.settled('saga', id);
    const converged=await captureCompensation(lab,id,'F6','03-converged',output,observe);
    assert.deepEqual(converged.saga.operations,before.saga.operations);
    assert.equal(final.order.status, 'CANCELLED');
    assert.equal(final.inventory.data!.reservation!.status, 'RELEASED');
    assert.equal(final.payment.data!.payment!.status, 'REFUNDED');
    assert.deepEqual(converged.ledger.map(e=>e.kind),['CHARGE','REFUND']);
    assert.equal(converged.movements.filter(m=>m.kind==='RELEASE').length,1);
    assert.equal(converged.wallets.find(w=>w.id==='main')!.balance,10000000);
    mkdirSync(output, { recursive: true });
    const traces=converged.traces;
    const query=traces.findIndex(t=>t.action==='refund.query' && t.http_status===200),release=traces.findIndex(t=>t.action==='release');
    assert(query>=0 && release>query);
    assert.equal(traces.filter(t=>t.action==='refund').length,1);assert.equal(traces.filter(t=>t.action==='release').length,1);
    writeFileSync(join(output, 'restart-order.json'), JSON.stringify({ passed: true, capturedAt: new Date().toISOString(), marker, phases:{before,afterRestart,converged},oldPid,newPid:lab.children.get('order')!.pid,final,traces,processEvents:lab.events }, null, 2));
    cpSync(join(lab.directory, 'logs'), join(output, 'restart-order-logs'), { recursive: true });
    console.log('F6 saga: restart after refund commit, CANCELLED, exactly one refund and release; three checkpoints saved');
    return final;
  } finally { await lab.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await restartOrderDemo();
