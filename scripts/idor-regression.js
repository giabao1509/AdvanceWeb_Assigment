import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { withLab } from './lab-fixture.js';

const selected = process.argv.find(arg => arg.startsWith('--version='))?.split('=')[1] || 'v1';
if (!['starter', 'v1', 'v2', 'v3', 'v4'].includes(selected)) throw new Error('Use --version=starter|v1|v2|v3|v4');
// The evidence generator also runs the same oracle against executable reconstructed snapshots.
const appFactory = process.env.LAB_EVIDENCE_APP
  ? (await import(pathToFileURL(resolve(process.env.LAB_EVIDENCE_APP)).href)).createApp
  : undefined;
let baseUrl, release, finished;
before(async () => {
  let ready;
  const started = new Promise(resolveReady => { ready = resolveReady; });
  finished = withLab(async lab => {
    baseUrl = lab.baseUrl;
    ready();
    await new Promise(resolveDone => { release = resolveDone; });
  }, appFactory);
  await Promise.race([started, finished]);
});
after(async () => { release?.(); await finished; });

async function read(user, id) {
  const response = await fetch(`${baseUrl}/api/${selected}/tasks/${id}`, { headers: { Authorization: `Bearer demo-${user}` } });
  return { status: response.status, body: await response.json() };
}

test(`${selected}: Alice must not read Beta task B1`, async () => {
  const result = await read('alice', 'B1');
  assert.equal(result.status, 403, 'Object authorization must reject Alice/B1');
  assert.equal(result.body.data, null);
  assert.doesNotMatch(JSON.stringify(result.body), /Private Beta|roadmap|charlie/);
});
test(`${selected}: Alice can still read Alpha task A1`, async () => {
  const result = await read('alice', 'A1');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.id, 'A1');
});
test(`${selected}: Charlie can still read Beta task B1`, async () => {
  const result = await read('charlie', 'B1');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.id, 'B1');
});
