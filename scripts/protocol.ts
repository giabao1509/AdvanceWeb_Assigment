import assert from 'node:assert/strict';
import type { Config } from '../shared/config.js';
import { authorizeFixture, exchangeFixture, rawToken } from '../shared/fixtures.js';
import { database } from '../shared/db.js';
import { random } from '../shared/crypto.js';

// Three focused race checks, not a broad unit-test suite. No credential values leave this function.
export async function concurrency(c: Config) {
  const code = await authorizeFixture(c);
  const request = { grant_type: 'authorization_code', code: code.code, code_verifier: code.verifier, redirect_uri: `${c.taxi}/oauth/callback` };
  const exchanged = await Promise.all([rawToken(c, request), rawToken(c, request)]);
  assert.deepEqual(exchanged.map(x => x.status).sort(), [200, 400]);
  const issued = exchanged.find(x => x.status === 200)!;
  const replayRevoked = await fetch(`${c.api}/wallet/balance`, { headers: { authorization: `Bearer ${issued.body.access_token}` } });
  assert.equal(replayRevoked.status, 401);
  const fixture = await exchangeFixture(c);
  const refresh = { grant_type: 'refresh_token', refresh_token: fixture.tokens.body.refresh_token };
  const rotated = await Promise.all([rawToken(c, refresh), rawToken(c, refresh)]);
  assert.deepEqual(rotated.map(x => x.status).sort(), [200, 400]);
  const next = rotated.find(x => x.status === 200)!;
  const invalidated = await rawToken(c, { grant_type: 'refresh_token', refresh_token: next.body.refresh_token });
  assert.equal(invalidated.body.error, 'invalid_grant');
  const chargeFixture = await exchangeFixture(c), key = random(), trip = `race_${random().slice(0, 12)}`;
  const counter = async () => { const db = database(c, 'wallet', true); try { return (db.prepare('SELECT COUNT(*) n FROM charges').get() as any).n; } finally { db.close(); } };
  const before = await counter();
  const charge = () => fetch(`${c.api}/wallet/charges`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${chargeFixture.tokens.body.access_token}`, 'idempotency-key': key }, body: JSON.stringify({ amount: 1000, trip_id: trip }) });
  const charged = await Promise.all([charge(), charge()]);
  assert.deepEqual(charged.map(x => x.status).sort(), [200, 201]);
  const after = await counter(); assert.equal(after, before + 1);
  return { code_exchange: exchanged.map(x => ({ status: x.status, error: x.body.error || null })), access_token_after_code_replay: replayRevoked.status,
    refresh: rotated.map(x => ({ status: x.status, error: x.body.error || null })), rotated_token_after_reuse: invalidated.body.error,
    charge_statuses: charged.map(x => x.status), charge_count_before: before, charge_count_after: after,
    limit: 'Parallel HTTP against one AS/API process, not cross-process SQLite crash verification.' };
}
