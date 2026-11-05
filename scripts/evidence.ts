import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
import { isolatedLab, root, waitFor, type Snapshot } from './lab.js';
import { killPaymentDemo } from './demo-kill-payment.js';
import { restartOrderDemo } from './demo-restart-order.js';
import {refundFailureDemo} from './demo-refund-failure.js';
import { uiSmoke } from './ui-smoke.js';
import type { Order, Mode } from '../src/shared/types.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('evidence', stamp);
mkdirSync(output, { recursive: true });
async function run(name: string, args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  writeFileSync(join(output, `${name}.txt`), stdout + stderr);
  assert.equal(code, 0, `${name} failed; inspect ${output}`);
  console.log(`${name}: PASS`);
  return stdout;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
function hash(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

try {
  await run('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
  const httpOutput = await run('http-tests', ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/http.test.ts']);
  const httpTests = Number(httpOutput.match(/^# tests (\d+)/m)?.[1]);
  const matrix: { mode: string; scenario: string; snapshot: Snapshot; pending?: Snapshot; pendingSaga?: unknown; saga?: unknown }[] = [];
  for (const mode of ['baseline','saga'] as Mode[]) {
      for (const scenario of [...['H', 'F1', 'F2', 'F3'], ...(mode === 'saga' ? ['F5'] : [])]) {
        const lab = await isolatedLab(`matrix-${mode}-${scenario}`);
        try {
        await lab.startAll();
        const created = await lab.create(mode, scenario, crypto.randomUUID(), 1);
        assert.equal(created.status, 202);
        const id = created.body.order.id;
        let pending: Snapshot | undefined;
        let pendingSaga: unknown;
        if (mode === 'saga' && scenario === 'F5') {
          await waitFor(async () => (await lab.request<{ order: Order }>(mode, `/orders/${id}`)).body.order.last_error === 'REFUND_TEMPORARILY_UNAVAILABLE', 10000, 'F5 pending');
          pending = (await lab.request<Snapshot>(mode, `/orders/${id}/snapshot`)).body;
          assert.equal(pending.order.status, 'COMPENSATING');
          pendingSaga = (await lab.request(mode, `/sagas/${id}`)).body;
          await lab.request(mode, `/faults/${id}/restore`, { method:'POST',body:'{}' }, 'payment');
          await lab.request(mode, `/sagas/${id}/resume`, { method:'POST',body:'{}' });
        }
        const snapshot = await lab.settled(mode, id);
        assert(snapshot.inventory.available && snapshot.payment.available);
        assert.equal(snapshot.order.status, scenario === 'H' ? 'CONFIRMED' : mode === 'saga' ? 'CANCELLED' : 'FAILED');
        if (scenario === 'F1') {
          assert.equal(snapshot.inventory.data!.reservation, null); assert.equal(snapshot.payment.data!.payment, null);
        } else if (scenario === 'F2') {
          assert.equal(snapshot.inventory.data!.reservation!.status, mode === 'saga' ? 'RELEASED' : 'HELD'); assert.equal(snapshot.payment.data!.payment, null);
        } else if (scenario !== 'H') {
          assert.equal(snapshot.inventory.data!.reservation!.status, mode === 'saga' ? 'RELEASED' : 'HELD');
          assert.equal(snapshot.payment.data!.payment!.status, mode === 'saga' ? 'REFUNDED' : 'CHARGED');
        }
        const saga = mode === 'saga' ? (await lab.request(mode, `/sagas/${id}`)).body : null;
        matrix.push({ mode, scenario, snapshot, saga, ...(pending ? { pending, pendingSaga } : {}) });
        cpSync(join(lab.directory, 'logs'), join(output, 'matrix-logs', `${mode}-${scenario}`), { recursive: true });
        } finally { await lab.close(); }
      }
    }
    writeFileSync(join(output, 'matrix.json'), JSON.stringify(matrix, null, 2));
  console.log('matrix: PASS');
  await killPaymentDemo(output);
  await refundFailureDemo(output);
  await restartOrderDemo(output);
  const ui = await uiSmoke(output);
  const artifactFiles = files(output);
  const sourceFiles = ['package.json', 'package-lock.json', 'tsconfig.json', ...files(join(root, 'src')), ...files(join(root, 'scripts')), ...files(join(root, 'tests')), ...files(join(root, 'public')).filter(path => !path.endsWith('app.js'))];
  const manifest = {
    passed: true, capturedAt: new Date().toISOString(), node: process.version,
    httpTests, matrixCases: matrix.length, killPaymentModes: 2, coordinatorRestart: true, uiCases: ui.cases.length, videos: ui.videos, modes: ['baseline','saga'], freshFixturePerCase: true,
    artifacts: artifactFiles.map(path => ({ file: relative(output, path).replaceAll('\\', '/'), sha256: hash(path) })),
    sources: sourceFiles.map(path => ({ file: relative(root, resolve(path)).replaceAll('\\', '/'), sha256: hash(path) })),
  };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve('evidence/latest-run.json'), JSON.stringify({ directory: relative(root, output).replaceAll('\\', '/'), passed: true, capturedAt: manifest.capturedAt }, null, 2));
  console.log(`Evidence PASS: ${output}`);
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ passed: false, error: String(error), capturedAt: new Date().toISOString() }, null, 2));
  console.error(error); process.exitCode = 1;
}
