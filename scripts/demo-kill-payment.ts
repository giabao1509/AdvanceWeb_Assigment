import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedLab, waitFor, type Snapshot } from './lab.js';
import type { Order } from '../src/shared/types.js';

export async function killPaymentDemo(output = resolve('evidence/latest')) {
  const lab = await isolatedLab('kill-payment', { HTTP_TIMEOUT_MS: '1000', RECOVERY_INTERVAL_MS: '1000' });
  const results: Record<string, unknown>[] = [];
  try {
    await lab.startAll();
    for (const mode of ['baseline', 'saga'] as const) {
      const created = await lab.create(mode, 'F4', crypto.randomUUID(), 1);
      assert.equal(created.status, 202);
      const id = created.body.order.id;
      const marker = await lab.marker('PAYMENT_CHARGE_COMMITTED_BEFORE_RESPONSE', id);
      const killedPid = lab.children.get('payment')!.pid;
      await lab.stop('payment');
      const killedAt = new Date().toISOString();
      const interrupted = await waitFor(async () => {
        const { body } = await lab.request<{ order: Order }>(mode, `/orders/${id}`);
        return body.order.status === (mode === 'saga' ? 'RECOVERING' : 'REQUIRES_REVIEW') && body.order;
      }, 15000, `${mode} unknown payment outcome`);
      const unavailable = (await lab.request<Snapshot>(mode, `/orders/${id}/snapshot`)).body;
      assert.equal(unavailable.payment.available, false);
      assert.equal(unavailable.inventory.available, true);
      await lab.start('payment');
      const restoredAt = Date.now();
      const operationId = `${mode}/${id}/charge`;
      const outcome = await lab.request<{ httpStatus: number; result: { payment: { status: string } } }>(mode, `/operations/${encodeURIComponent(operationId)}`, {}, 'payment');
      assert.equal(outcome.body.httpStatus, 201);
      assert.equal(outcome.body.result.payment.status, 'CHARGED');
      const final = await lab.settled(mode, id);
      const recoveryMs = Date.now() - restoredAt;
      assert.equal(final.order.status, mode === 'saga' ? 'CONFIRMED' : 'REQUIRES_REVIEW');
      assert.equal(final.inventory.data!.reservation!.status, 'HELD');
      assert.equal(final.payment.data!.payment!.status, 'CHARGED');
      assert.equal(final.payment.data!.ledger.filter(e => e.kind === 'CHARGE').length, 1);
      if (mode === 'saga') assert(recoveryMs < 15000);
      const traces = (await lab.request<Record<string, unknown>[]>(mode, `/orders/${id}/traces`)).body;
      if (mode === 'saga') assert(traces.some(t => t.action === 'charge.query' && t.http_status === 200));
      results.push({ mode, marker, killedPid, killedAt, paymentWasUnavailable: !unavailable.payment.available, interrupted, restoredAt: new Date(restoredAt).toISOString(), restartedPid: lab.children.get('payment')!.pid, outcome, recoveryMs, final, traces });
      console.log(`F4 ${mode}: ${final.order.status}, charge count=1, recovery=${recoveryMs}ms`);
    }
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'kill-payment.json'), JSON.stringify({ passed: true, capturedAt: new Date().toISOString(), results, processEvents: lab.events }, null, 2));
    cpSync(join(lab.directory, 'logs'), join(output, 'kill-payment-logs'), { recursive: true });
    return results;
  } finally { await lab.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await killPaymentDemo();
