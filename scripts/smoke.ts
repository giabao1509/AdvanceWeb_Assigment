import assert from 'node:assert/strict';
import { config, type Config, type Mode } from '../shared/config.js';
import { BrowserSession, field } from '../shared/fixtures.js';
import { runCase } from '../shared/cases.js';
import { database } from '../shared/db.js';

// Actions exercise public application endpoints. Read-only SQLite observations verify persisted effects independently.
export class ApiDriver {
  browser = new BrowserSession();
  lastIntent = ''; lastJob = '';
  constructor(public c: Config, public user = 'alice') {}
  async state(): Promise<any> { return (await this.browser.fetch(`${this.c.taxi}/api/state`)).json(); }
  async observe(): Promise<any> {
    const state = await this.state(), taxi = database(this.c, 'taxi', true), wallet = database(this.c, 'wallet', true);
    try { return { ...state, jobs: (taxi.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY rowid DESC').all(this.user) as any[]).map(j => ({ ...j, detail: JSON.parse(j.detail) })),
      wallet: { wallets: wallet.prepare('SELECT user_id,balance FROM wallets').all(), charge_count: (wallet.prepare('SELECT COUNT(*) n FROM charges').get() as any).n }, booking_count: (taxi.prepare('SELECT COUNT(*) n FROM bookings WHERE user_id=?').get(this.user) as any).n }; }
    finally { taxi.close(); wallet.close(); }
  }
  async post(path: string, body: Record<string, string> = {}) {
    const state = await this.state();
    return this.browser.fetch(`${this.c.taxi}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.c.taxi }, body: new URLSearchParams({ csrf: state.csrf, ...body }) });
  }
  async login(password = `Taxi-${this.user}-2026!`) {
    await this.browser.fetch(`${this.c.taxi}/login`);
    return this.post('/login', { username: this.user, password });
  }
  async authorize(url: string, decision = 'allow') {
    let response = await this.browser.fetch(url);
    if (response.status === 200) {
      const html = await response.text();
      response = await this.browser.fetch(`${this.c.as}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.c.as }, body: new URLSearchParams({ username: this.user, password: this.user === 'alice' ? this.c.alicePassword : this.c.bobPassword, csrf: field(html, 'csrf'), request: field(html, 'request') }) });
    }
    assert.equal(response.status, 302);
    response = await this.browser.fetch(new URL(response.headers.get('location')!, this.c.as).href);
    const html = await response.text();
    response = await this.browser.fetch(`${this.c.as}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.c.as }, body: new URLSearchParams({ csrf: field(html, 'csrf'), request: field(html, 'request'), decision }) });
    const callback = response.headers.get('location')!;
    response = await this.browser.fetch(callback); assert.equal(response.status, 302);
    return { response, callback };
  }
  async link() {
    assert.equal((await this.login()).status, 302);
    const start = await (await this.post('/oauth/start')).json() as any;
    const result = await this.authorize(start.redirect);
    assert.equal(result.response.headers.get('location'), '/?notice=linked');
    return (await this.state()).oauth_result;
  }
  async action(action: string, extra: Record<string, string> = {}) {
    if (action === 'login') { const r = await this.login(); return { status: r.status, body: { ok: r.status === 302 } }; }
    if (['charge', 'book', 'schedule'].includes(action)) {
      const startResponse = await this.post('/api/booking-intents', { payment_mode: action === 'schedule' ? 'offline' : 'immediate' });
      const start = await startResponse.json() as any;
      assert.equal(startResponse.status, 200); this.lastIntent = start.intent_id;
      const authorized = await this.authorize(start.redirect);
      assert.equal(new URL(authorized.response.headers.get('location')!, this.c.taxi).searchParams.get('intent'), start.intent_id);
      const response = await this.post('/api/bookings', { intent_id: start.intent_id });
      const body = await response.json() as any; this.lastJob = body.job;
      return { status: response.status, body };
    }
    const path = action === 'logout' ? '/session/logout' : action === 'start' ? '/oauth/start' : action === 'retry' ? `/api/bookings/${extra.id || this.lastJob}/retry` : `/api/wallet/${action}`;
    const response = await this.post(path, extra);
    return { status: response.status, body: await response.json() as any };
  }
  async revoke() {
    const html = await (await this.browser.fetch(`${this.c.as}/account`)).text();
    const response = await this.browser.fetch(`${this.c.as}/account/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.c.as }, body: new URLSearchParams({ csrf: field(html, 'csrf') }) });
    assert.equal(response.status, 302);
  }
}
export async function smoke(c: Config) {
  const driver = new ApiDriver(c);
  assert.equal((await driver.post('/api/bookings')).status, 401);
  assert.equal((await driver.login('incorrect-password')).status, 401);
  const trace = await driver.link();
  assert.equal((await driver.post('/api/bookings')).status, 403);
  const before = await driver.observe();
  const pending = await (await driver.post('/api/booking-intents')).json() as any;
  const csrfRejected = await driver.browser.fetch(`${c.taxi}/api/bookings`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: c.taxi }, body: new URLSearchParams({ csrf: 'invalid', intent_id: pending.intent_id }) });
  assert.equal(csrfRejected.status, 403);
  const secondSession = new ApiDriver(c); await secondSession.login();
  assert.equal((await secondSession.post('/api/bookings', { intent_id: pending.intent_id })).status, 403);
  assert.equal((await driver.post('/api/bookings', { intent_id: pending.intent_id })).status, 403);
  const denied = await driver.authorize(pending.redirect, 'deny');
  assert.equal(denied.response.headers.get('location'), '/?notice=link_failed');
  assert.equal((await driver.post('/api/bookings', { intent_id: pending.intent_id })).status, 403);
  assert.equal((await driver.observe()).booking_count, before.booking_count);
  assert.equal((await driver.observe()).wallet.charge_count, before.wallet.charge_count);
  const balance = await driver.action('balance'); assert.equal(balance.body.steps.at(-1).status, 200);
  const first = await driver.action('book'); assert.equal(first.status, 201); assert.equal(first.body.status, 'completed');
  const labels = JSON.stringify(first.body.trace);
  assert(labels.includes('POST /consent') && labels.includes('GET /oauth/callback') && labels.includes('POST /token'));
  const bookingResponse = await driver.browser.fetch(`${c.taxi}/api/bookings/${first.body.job}`);
  assert.equal(bookingResponse.status, 200); assert.equal((await bookingResponse.json() as any).status, 'confirmed');
  const invalidTrip = await driver.post('/api/booking-intents', { trip_id: 'does-not-exist' }); assert.equal(invalidTrip.status, 404);
  const replay = await driver.post('/api/bookings', { intent_id: driver.lastIntent }); assert.equal(replay.status, 200);
  assert.equal((await replay.json() as any).job, first.body.job);
  const retry = await driver.action('retry'); assert.equal(retry.body.status, 'completed');
  assert.equal(retry.body.steps.at(-1).response.duplicate, true);
  assert.equal(retry.body.booking.ticket_id, first.body.booking.ticket_id);
  assert.equal((await driver.observe()).wallet.charge_count, before.wallet.charge_count + 1);
  assert.equal((await driver.observe()).booking_count, before.booking_count + 1);
  const other = new ApiDriver(c, 'bob'); await other.login();
  assert.equal((await other.post(`/api/bookings/${first.body.job}/retry`)).status, 404);
  assert.equal((await other.browser.fetch(`${c.taxi}/api/bookings/${first.body.job}`)).status, 404);
  const callbackIntent = await (await driver.post('/api/booking-intents')).json() as any;
  const callbackResult = await driver.authorize(callbackIntent.redirect);
  const callbackReplay = await driver.browser.fetch(callbackResult.callback);
  assert.equal(callbackReplay.headers.get('location'), '/?notice=callback_rejected');
  assert.equal((await driver.observe()).booking_count, before.booking_count + 1);
  const m2m = await runCase(c, 'm2m'); assert.equal(m2m.protected, c.mode === 'secure');
  if (c.mode === 'secure') {
    await driver.revoke();
    assert.equal((await driver.action('refresh')).status, 409);
    const failedRetry = await driver.action('retry'); assert.equal(failedRetry.body.status, 'failed');
    const original = await driver.browser.fetch(`${c.taxi}/api/bookings/${first.body.job}`);
    assert.equal((await original.json() as any).status, 'confirmed');
    assert.equal((await driver.observe()).wallet.charge_count, before.wallet.charge_count + 1);
  }
  for (const path of ['/demo/login', '/demo/book', '/demo/case']) assert.equal((await driver.post(path)).status, 404);
  await secondSession.action('logout'); await other.action('logout');
  await driver.action('logout');
  return { mode: c.mode, trace, balance: balance.body, charge: first.body, retry: retry.body, m2m, passed: true,
    checks: ['actual Taxi password authentication', 'no create before consent', 'deny creates no booking or debit', 'CSRF and session binding', 'actual consent trace before booking', 'confirmed booking accessible through primary API', 'unknown trip rejected', 'same intent creates once', 'same ticket retry charges once', 'other user cannot read or retry ticket', 'callback replay rejected without booking', 'demo routes absent', ...(c.mode === 'secure' ? ['failed retry after revoke preserves confirmed booking'] : [])] };
}
if (process.argv[1]?.endsWith('smoke.ts')) for (const mode of ['baseline', 'secure'] as Mode[]) {
  const result = await smoke(config(mode)); console.log(`${mode}: PASS real login, OAuth consent, booking API, deny/guards, same-ticket retry, ownership, no demo routes (${result.checks.length} checks)`);
}
