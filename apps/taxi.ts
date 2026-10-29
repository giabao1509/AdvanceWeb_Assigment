import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { config, modeFromEnv, now } from '../shared/config.js';
import { database, audit, events } from '../shared/db.js';
import { random, hash, encrypt, decrypt } from '../shared/crypto.js';
import { server, sessions, params, escape, type Session } from '../shared/http.js';
import { page, hidden } from '../shared/views.js';
import { oauth, client, claims, tokenSummary } from '../shared/oauth-client.js';
import { caseCatalog, runCase, traceRequest, type Step } from '../shared/cases.js';

const c = config(modeFromEnv()), db = database(c, 'taxi'), app = await server(c, 'Taxi');
const session = sessions(app, db, c, 'taxi'), oauthClient = client(c);
// Sessions created by the former automatic-login route must authenticate again.
db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.user') IS NOT NULL AND COALESCE(json_extract(data,'$.auth_method'),'')!='password'").run();
function taxiResponse(endpoint: string, result: Record<string, any>, status = 200, requestBody: Record<string, string> = {}, prefix: Step[] = []) {
  const { steps = [], ...body } = result;
  const step: Step = { service: 'Taxi server', from: 'Người dùng', endpoint, status,
    request: { body: { csrf: '[REDACTED]', ...requestBody } }, response: body, children: steps,
    explanation: 'API nghiệp vụ Taxi thực thi thao tác. Token và client secret chỉ nằm phía server.' };
  return { ...result, steps: [step, ...steps], trace: [...prefix, step] };
}
const aad = (user: string) => `${c.mode}:${user}:taxi-web`;
const locks = new Map<string, Promise<void>>();
let caseBusy = false, workerBusy = false, stopping = false;
async function serialized<T>(user: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(user) || Promise.resolve(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), tail = previous.then(() => gate);
  locks.set(user, tail); await previous;
  try { return await work(); } finally { release(); if (locks.get(user) === tail) locks.delete(user); }
}
async function stored(user: string, force: boolean, steps: Step[]) {
  const link = db.prepare('SELECT * FROM links WHERE user_id=? AND status=?').get(user, 'linked') as any;
  if (!link) throw new Error('wallet_unlinked');
  let tokens = decrypt<oauth.TokenEndpointResponse>(link.vault, c.vaultKey, aad(user));
  if (force || link.token_exp <= now()) {
    if (!tokens.refresh_token) throw new Error('offline_access_missing');
    try {
      const fresh = await oauth.refreshTokenGrant(oauthClient, tokens.refresh_token);
      const p = await claims(c, fresh.access_token); tokens = fresh;
      db.prepare('UPDATE links SET vault=?,token_exp=? WHERE user_id=?').run(encrypt(fresh, c.vaultKey, aad(user)), p.exp!, user);
      const summary = await tokenSummary(c, fresh, 'refresh_token');
      steps.push({ service: 'Wallet AS', endpoint: 'POST /token · refresh_token', status: 200, request: traceRequest({ grant_type: 'refresh_token', refresh_token: '[REDACTED]' }), response: summary, explanation: 'Taxi refresh phía server và lưu token mới trước khi nhả khóa theo người dùng.' });
      audit(db, 'Taxi', 'Refresh và lưu token vault', 200, summary);
    } catch (error: any) {
      // A lost rotation response is ambiguous: do not retry the old refresh token.
      db.prepare("UPDATE links SET status='unlinked',vault='' WHERE user_id=?").run(user);
      const code = typeof error.error === 'string' ? error.error : 'refresh_failed_relink_required';
      audit(db, 'Taxi', 'Refresh thất bại → cần liên kết lại', 400, { error: code });
      steps.push({ service: 'Wallet AS', endpoint: 'POST /token · refresh_token', status: error.status || 400, request: traceRequest({ grant_type: 'refresh_token', refresh_token: '[REDACTED]' }), response: { error: code }, explanation: 'Taxi ngừng dùng refresh token và chuyển về chưa liên kết; không retry token cũ vô hạn.' });
      throw new Error(code);
    }
  }
  return tokens;
}
async function apiCall(path: string, tokens: oauth.TokenEndpointResponse, steps: Step[], init: RequestInit = {}) {
  const r = await fetch(`${c.api}${path}`, { ...init, headers: { authorization: `Bearer ${tokens.access_token}`, ...init.headers }, signal: AbortSignal.timeout(10000) });
  const body = await r.json();
  steps.push({ service: 'Wallet API', endpoint: `${init.method || 'GET'} ${path}`, status: r.status, request: { headers: { authorization: 'Bearer [REDACTED]', ...init.headers }, body: init.body ? JSON.parse(String(init.body)) : null }, response: body, explanation: 'API tự kiểm JWT qua JWKS, scope và principal trước khi xử lý dữ liệu ví.' });
  return { status: r.status, body };
}
async function processJob(job: any) {
  return serialized(job.user_id, async () => {
    const steps: Step[] = [];
    const previousDetail = JSON.parse((db.prepare('SELECT detail FROM jobs WHERE id=?').get(job.id) as any).detail);
    delete previousDetail.error;
    delete previousDetail.trace;
    const booking = previousDetail.booking || { ticket_id: job.trip_id, trip_id: job.trip_id, from: 'Bến Thành', to: 'Sân bay Tân Sơn Nhất', passenger: 'Alice', amount: 45000 };
    db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
    const activeSessions = (db.prepare("SELECT COUNT(*) n FROM sessions WHERE expires_at>? AND json_extract(data,'$.user')=?").get(now(), job.user_id) as any).n;
    audit(db, 'Taxi', 'Job bắt đầu', 200, { job: job.id, trip: job.trip_id, active_taxi_sessions: activeSessions, at: now() });
    try {
      const tokens = await stored(job.user_id, false, steps);
      const result = await apiCall('/wallet/charges', tokens, steps, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': job.trip_id }, body: JSON.stringify({ amount: booking.amount, trip_id: job.trip_id }) });
      const status = result.status < 300 ? 'completed' : 'failed';
      const bookingStatus = status === 'completed' ? 'confirmed' : 'payment_failed';
      db.prepare("UPDATE bookings SET status=? WHERE job_id=? AND (status!='confirmed' OR ?='confirmed')").run(bookingStatus, job.id, bookingStatus);
      db.prepare('UPDATE jobs SET status=?,detail=? WHERE id=?').run(status, JSON.stringify({ ...previousDetail, booking, steps, trace: [...(previousDetail.authorization_trace || []), ...(previousDetail.steps || []).filter((step: Step) => step.endpoint.startsWith('Tạo vé')), ...steps], active_taxi_sessions: activeSessions, result: result.body }), job.id);
      audit(db, 'Taxi', `Job ${status}`, result.status, { job: job.id, trip: job.trip_id, result: result.body });
      return { status, booking, result: result.body, steps };
    } catch (error: any) {
      const code = ['wallet_unlinked', 'invalid_grant', 'offline_access_missing', 'refresh_failed_relink_required'].includes(error.message) ? error.message : 'network_or_service_error';
      db.prepare("UPDATE bookings SET status='payment_failed' WHERE job_id=? AND status!='confirmed'").run(job.id);
      db.prepare("UPDATE jobs SET status='failed',detail=? WHERE id=?").run(JSON.stringify({ ...previousDetail, booking, error: code, steps, active_taxi_sessions: activeSessions }), job.id);
      audit(db, 'Taxi', 'Job thất bại', 400, { job: job.id, error: code });
      return { status: 'failed', booking, error: code, steps };
    }
  });
}
const worker = setInterval(() => {
  if (workerBusy || stopping) return;
  const job = db.prepare("SELECT * FROM jobs WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 1").get(now());
  if (!job) return;
  workerBusy = true; void processJob(job).finally(() => { workerBusy = false; });
}, 1000);
// A crash may happen after the API committed. Retry with the same trip/key.
db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run();

app.get('/', (q, r) => { session.get(q, r); return r.type('text/html').send(readFileSync('public/index.html')); });
app.get('/style.css', (_q, r) => r.type('text/css').send(readFileSync('public/style.css')));
app.get('/dashboard.js', (_q, r) => r.type('application/javascript').send(readFileSync('public/dashboard.js')));
function requireUser(q: any, r: any) {
  const s = session.get(q, r), p = params(q.body);
  if (!s.user) { r.code(401).send({ error: 'authentication_required', redirect: '/login' }); return null; }
  if (!p || !session.csrf(q, s, p.csrf, c.taxi)) { r.code(403).send({ error: 'csrf_failed' }); return null; }
  return { s, p };
}
function loginView(s: Session, next: string, message = '') {
  return page('Đăng nhập Taxi', c.mode, `<div class="eyebrow">TAXI ACCOUNT</div><h1>Đăng nhập Taxi</h1><p class="muted">Tài khoản Taxi riêng. Sau đó bạn cấp quyền sử dụng ví tại Wallet AS.</p>${message ? `<p class="alert">${escape(message)}</p>` : ''}<form method="post" action="/login">${hidden('csrf', s.csrf)}${hidden('next', next)}<label>Tài khoản Taxi<input name="username" autocomplete="username" value="alice" required></label><label>Mật khẩu Taxi<input name="password" type="password" autocomplete="current-password" required></label><button class="button primary">Đăng nhập Taxi</button></form><p class="note">Tài khoản thực hành: alice / <code>Taxi-alice-2026!</code><br>bob / <code>Taxi-bob-2026!</code></p>`);
}
app.get('/login', (q, r) => { const s = session.get(q, r); return r.type('text/html').send(loginView(s, (q.query as any)?.next === 'booking' ? 'booking' : '')); });
app.post('/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (q, r) => {
  const s = session.get(q, r), p = params(q.body);
  if (!p || !session.csrf(q, s, p.csrf, c.taxi)) return r.code(403).send({ error: 'csrf_failed' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(p.username || '') as any;
  if (!user || !await argon2.verify(user.password_hash, p.password || '')) return r.code(401).type('text/html').send(loginView(s, p.next === 'booking' ? 'booking' : '', 'Tài khoản hoặc mật khẩu không đúng.'));
  const landing = p.next === 'booking' ? '/?notice=taxi_logged_in' : '/';
  session.rotate(q, r, { csrf: '', user: user.id, auth_method: 'password', loginTrace: [{ service: 'Taxi server', from: 'Người dùng', endpoint: 'POST /login', status: 302, request: { body: { username: user.id, password: '[REDACTED]', csrf: '[REDACTED]' } }, response: { headers: { location: landing } }, explanation: 'Taxi xác minh mật khẩu bằng Argon2id rồi tạo session mới. Đây chưa phải quyền truy cập Wallet.' }] });
  audit(db, 'Taxi', 'Đăng nhập Taxi thành công', 302, { user: user.id });
  return r.redirect(landing);
});
app.post('/session/logout', (q, r) => {
  const auth = requireUser(q, r); if (!auth) return;
  session.destroy(q, r); audit(db, 'Taxi', 'Đăng xuất Taxi', 200, { user: auth.s.user }); return { ok: true };
});
async function beginOAuth(q: any, r: any, s: Session, intentId?: string) {
  const state = oauth.randomState(), verifier = oauth.randomPKCECodeVerifier();
  db.prepare('DELETE FROM attempts WHERE expires_at<=?').run(now());
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run(hash(state), hash(s.csrf), verifier, now() + 600);
  if (intentId) db.prepare('INSERT INTO booking_attempts VALUES(?,?)').run(hash(state), intentId);
  const codeChallenge = await oauth.calculatePKCECodeChallenge(verifier);
  const redirect = oauth.buildAuthorizationUrl(oauthClient, { response_type: 'code', redirect_uri: `${c.taxi}/oauth/callback`, scope: 'wallet:read wallet:charge offline_access', state, code_challenge: codeChallenge, code_challenge_method: 'S256' });
  audit(db, 'Taxi', 'Bắt đầu OAuth → đăng nhập và cấp quyền tại AS', 200, { pkce: 'S256', intent: intentId || null });
  return { redirect: redirect.href, ...(intentId ? { intent_id: intentId } : {}) };
}
app.post('/oauth/start', async (q, r) => { const auth = requireUser(q, r); if (!auth) return; return beginOAuth(q, r, auth.s); });
app.post('/api/booking-intents', async (q, r) => {
  const auth = requireUser(q, r); if (!auth) return;
  const { s, p } = auth;
  if (p.payment_mode && !['immediate', 'offline'].includes(p.payment_mode)) return r.code(400).send({ error: 'invalid_payment_mode' });
  const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(p.trip_id || 'ben-thanh-airport') as any;
  if (!trip) return r.code(404).send({ error: 'trip_not_found' });
  const id = random();
  const trace: Step[] = [...(Array.isArray(s.loginTrace) ? s.loginTrace as Step[] : []), { service: 'Taxi server', from: 'Người dùng', endpoint: 'POST /api/booking-intents', status: 200,
    request: { body: { trip_id: trip.id, payment_mode: p.payment_mode || 'immediate', csrf: '[REDACTED]' } }, response: { intent_id: id, status: 'awaiting_consent', next: 'Wallet AS /authorize' }, explanation: 'Taxi chỉ lưu ý định đặt vé. Chưa có vé, chuyến hoặc khoản trừ tiền; phải chờ người dùng cấp quyền tại AS.' }];
  db.prepare("INSERT INTO booking_intents(id,user_id,session_hash,payment_mode,status,trace,expires_at,trip_id) VALUES(?,?,?,?,'awaiting_consent',?,?,?)").run(id, s.user, hash(s.csrf), p.payment_mode || 'immediate', JSON.stringify(trace), now() + 600, trip.id);
  delete s.loginTrace; session.save(q, s);
  return beginOAuth(q, r, s, id);
});
app.get('/oauth/callback', async (q, r) => {
  const s = session.get(q, r), p = params(q.query);
  const stateHash = p?.state ? hash(p.state) : '';
  const attempt = db.prepare('SELECT * FROM attempts WHERE state_hash=? AND session_hash=? AND expires_at>?').get(stateHash, hash(s.csrf), now()) as any;
  if (!s.user || !attempt || !p) return r.redirect('/?notice=callback_rejected');
  if (!db.prepare('DELETE FROM attempts WHERE state_hash=?').run(stateHash).changes) return r.redirect('/?notice=callback_rejected');
  const binding = db.prepare('SELECT intent_id FROM booking_attempts WHERE state_hash=?').get(stateHash) as any;
  db.prepare('DELETE FROM booking_attempts WHERE state_hash=?').run(stateHash);
  const intent = binding ? db.prepare('SELECT * FROM booking_intents WHERE id=? AND user_id=? AND session_hash=? AND expires_at>?').get(binding.intent_id, s.user, hash(s.csrf), now()) as any : null;
  if (binding && (!intent || intent.status !== 'awaiting_consent')) return r.redirect('/?notice=callback_rejected');
  let asTrace: Step[] = [];
  try {
    const response = await fetch(`${c.as}/internal/oauth-traces/${stateHash}`, { headers: { 'x-client-secret': c.clients['taxi-web'] }, signal: AbortSignal.timeout(5000) });
    if (response.ok) asTrace = await response.json() as Step[];
  } catch { /* Trace collection cannot manufacture or authorize a grant. */ }
  const prefix: Step[] = [...(intent ? JSON.parse(intent.trace) : []), ...asTrace];
  const callback: Step = { service: 'Taxi server', from: 'Người dùng', endpoint: 'GET /oauth/callback', status: 302,
    request: { query: { state: '[REDACTED]', ...(p.code ? { code: '[REDACTED]' } : { error: p.error }) } }, response: { headers: { location: '/' } }, children: [], explanation: 'Taxi kiểm session/state, consume attempt một lần, rồi đổi authorization code bằng PKCE qua kênh server.' };
  try {
    const tokens = await oauth.authorizationCodeGrant(oauthClient, new URL(q.url, c.taxi), { pkceCodeVerifier: attempt.verifier, expectedState: p.state });
    const payload = await claims(c, tokens.access_token), summary = await tokenSummary(c, tokens, 'authorization_code');
    if (!String(payload.scope).split(' ').includes('wallet:charge')) throw new Error('required_scope_missing');
    callback.children!.push({ service: 'Wallet AS', endpoint: 'POST /token', status: 200, request: traceRequest({ grant_type: 'authorization_code', code: '[REDACTED]', redirect_uri: `${c.taxi}/oauth/callback`, code_verifier: '[REDACTED]' }), response: summary, explanation: 'Sau khi người dùng đồng ý, Taxi đổi code lấy access token và refresh token. Token chỉ lưu mã hóa ở server.' });
    db.prepare("INSERT INTO links VALUES(?,?,?,?, 'linked') ON CONFLICT(user_id) DO UPDATE SET wallet_sub=excluded.wallet_sub,vault=excluded.vault,token_exp=excluded.token_exp,status='linked'").run(s.user, payload.sub!, encrypt(tokens, c.vaultKey, aad(s.user)), payload.exp!);
    const landing = intent ? `/?notice=booking_authorized&intent=${encodeURIComponent(intent.id)}` : '/?notice=linked';
    callback.response = { headers: { location: landing } };
    const trace = [...prefix, callback];
    if (intent) db.prepare("UPDATE booking_intents SET status='authorized',trace=? WHERE id=?").run(JSON.stringify(trace), intent.id);
    s.oauthResult = { status: 'authorized', trace }; session.save(q, s);
    audit(db, 'Taxi', 'Đã cấp quyền và đổi code thành công', 200, summary);
    return r.redirect(landing);
  } catch (error: any) {
    const code = p.error === 'access_denied' ? 'access_denied' : typeof error.error === 'string' ? error.error : 'oauth_callback_failed';
    callback.response = { headers: { location: '/?notice=link_failed' } };
    if (!p.error) callback.children!.push({ service: 'Wallet AS', endpoint: 'POST /token', status: error.status || 400, request: traceRequest({ grant_type: 'authorization_code', code: '[REDACTED]', code_verifier: '[REDACTED]' }), response: { error: code }, explanation: 'Đổi code thất bại. Taxi không cho tạo vé.' });
    const trace = [...prefix, callback];
    if (intent) db.prepare("UPDATE booking_intents SET status='denied',trace=? WHERE id=?").run(JSON.stringify(trace), intent.id);
    s.oauthResult = { error: code, trace }; session.save(q, s);
    return r.redirect('/?notice=link_failed');
  }
});
app.post('/api/bookings', async (q, r) => {
  const auth = requireUser(q, r); if (!auth) return;
  const { s, p } = auth;
  const intent = db.prepare('SELECT * FROM booking_intents WHERE id=? AND user_id=? AND session_hash=? AND expires_at>?').get(p.intent_id || '', s.user, hash(s.csrf), now()) as any;
  if (!intent || !['authorized', 'completed'].includes(intent.status)) return r.code(403).send({ error: 'consent_required', explanation: 'Phải hoàn tất đồng ý cấp quyền tại Wallet AS trước khi tạo vé.' });
  const prefix: Step[] = JSON.parse(intent.trace);
  if (intent.job_id) {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(intent.job_id) as any;
    return taxiResponse('POST /api/bookings', { job: job.id, status: job.status, ...JSON.parse(job.detail) }, 200, { intent_id: intent.id }, prefix);
  }
  const link = db.prepare("SELECT token_exp FROM links WHERE user_id=? AND status='linked'").get(s.user) as any;
  if (!link) return r.code(409).send({ error: 'wallet_unlinked' });
  const id = random(), trip = `trip_${random().slice(0, 16)}`, due = intent.payment_mode === 'offline' ? Math.max(now() + 3, link.token_exp + 2) : now();
  const selectedTrip = db.prepare('SELECT * FROM trips WHERE id=?').get(intent.trip_id) as any;
  const booking = { ticket_id: `VE-${trip.slice(5)}`, trip_id: trip, from: selectedTrip.origin, to: selectedTrip.destination, passenger: s.user, amount: selectedTrip.fare };
  const creation: Step = { service: 'Taxi server', endpoint: 'Tạo vé và chuyến', status: 201, request: { body: { ...booking } }, response: { ...booking, status: 'pending_payment' }, explanation: 'Sau callback OAuth thành công, Taxi tạo và lưu vé/chuyến. Vé chỉ xác nhận khi Wallet API thanh toán thành công.' };
  db.transaction(() => {
    db.prepare("INSERT INTO jobs VALUES(?,?,?,?,'pending',?,0)").run(id, s.user, trip, due, JSON.stringify({ booking, steps: [creation], authorization_trace: prefix }));
    db.prepare("INSERT INTO bookings VALUES(?,?,?,?,?,?,?,'pending_payment',?,?)").run(id, booking.ticket_id, trip, s.user, booking.from, booking.to, booking.amount, id, intent.id);
    db.prepare("UPDATE booking_intents SET status='completed',job_id=? WHERE id=?").run(id, intent.id);
  }).immediate();
  audit(db, 'Taxi', 'Tạo vé sau cấp quyền', 201, { job: id, trip, intent: intent.id });
  if (intent.payment_mode === 'offline') return r.code(201).send(taxiResponse('POST /api/bookings', { job: id, booking, status: 'pending', due_at: due, steps: [creation] }, 201, { intent_id: intent.id }, prefix));
  const result = await processJob({ id, user_id: s.user, trip_id: trip });
  const output = taxiResponse('POST /api/bookings', { job: id, ...result, steps: [creation, ...result.steps] }, 201, { intent_id: intent.id }, prefix);
  const detail = JSON.parse((db.prepare('SELECT detail FROM jobs WHERE id=?').get(id) as any).detail);
  db.prepare('UPDATE jobs SET detail=? WHERE id=?').run(JSON.stringify({ ...detail, trace: output.trace }), id);
  return r.code(201).send(output);
});
app.post('/api/bookings/:id/retry', async (q, r) => {
  const auth = requireUser(q, r); if (!auth) return;
  const id = (q.params as any).id;
  const job = db.prepare('SELECT j.* FROM jobs j JOIN bookings b ON b.job_id=j.id WHERE b.user_id=? AND b.id=?').get(auth.s.user, id) as any;
  if (!job) return r.code(404).send({ error: 'booking_not_found' });
  if (['running', 'pending'].includes(job.status)) return r.code(409).send({ error: 'booking_in_progress' });
  const result = taxiResponse(`POST /api/bookings/${id}/retry`, { job: id, ...await processJob(job) });
  const detail = JSON.parse((db.prepare('SELECT detail FROM jobs WHERE id=?').get(id) as any).detail);
  db.prepare('UPDATE jobs SET detail=? WHERE id=?').run(JSON.stringify({ ...detail, trace: result.trace }), id);
  return result;
});
for (const action of ['balance', 'refresh'] as const) app.post(`/api/wallet/${action}`, async (q, r) => {
  const auth = requireUser(q, r); if (!auth) return;
  return serialized(auth.s.user!, async () => {
    const steps: Step[] = [];
    try {
      const tokens = await stored(auth.s.user!, action === 'refresh', steps);
      if (action === 'balance') await apiCall('/wallet/balance', tokens, steps);
      return taxiResponse(`POST /api/wallet/${action}`, { steps });
    } catch (error: any) { const code = ['wallet_unlinked', 'invalid_grant', 'offline_access_missing', 'refresh_failed_relink_required'].includes(error.message) ? error.message : 'service_error'; return r.code(409).send(taxiResponse(`POST /api/wallet/${action}`, { error: code, steps }, 409)); }
  });
});
// This route runs HTTP tests; it never supplies an alternative implementation of a business operation.
app.post('/testing/cases/:id/runs', async (q, r) => {
  const auth = requireUser(q, r); if (!auth) return;
  const id = (q.params as any).id;
  if (![...caseCatalog.map(x => x.id), 'wrong_verifier', 'other_client', 'other_refresh'].includes(id)) return r.code(404).send({ error: 'unknown_case' });
  if (caseBusy) return r.code(409).send({ error: 'case_running' });
  caseBusy = true;
  try { return await runCase(c, id); } finally { caseBusy = false; }
});
app.get('/api/bookings', (q, r) => {
  const s = session.get(q, r); if (!s.user) return r.code(401).send({ error: 'authentication_required' });
  return db.prepare('SELECT * FROM bookings WHERE user_id=? ORDER BY rowid DESC LIMIT 20').all(s.user);
});
app.get('/api/bookings/:id', (q, r) => {
  const s = session.get(q, r); if (!s.user) return r.code(401).send({ error: 'authentication_required' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?').get((q.params as any).id, s.user);
  return booking || r.code(404).send({ error: 'booking_not_found' });
});
app.get('/api/trips', () => db.prepare('SELECT * FROM trips ORDER BY rowid').all());
app.get('/api/state', async (q, r) => {
  const s = session.get(q, r);
  async function read(url: string, headers: Record<string, string> = {}) { try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) }); return response.ok ? await response.json() : null; } catch { return null; } }
  const diagnosticHeaders = { 'x-client-secret': c.clients['taxi-web'] };
  const [asEvents, apiEvents] = await Promise.all([read(`${c.as}/internal/events`, diagnosticHeaders), read(`${c.api}/internal/events`, diagnosticHeaders)]);
  const link = s.user ? db.prepare('SELECT user_id,wallet_sub,token_exp,status FROM links WHERE user_id=?').get(s.user) as any : null;
  let wallet: any = null;
  // Read the protected business APIs. Polling never refreshes, so an offline job still waits for real expiry.
  if (s.user && link?.status === 'linked' && link.token_exp > now()) {
    const row = db.prepare('SELECT vault FROM links WHERE user_id=?').get(s.user) as any;
    const tokens = decrypt<oauth.TokenEndpointResponse>(row.vault, c.vaultKey, aad(s.user));
    const headers = { authorization: `Bearer ${tokens.access_token}` };
    const [balance, charges] = await Promise.all([read(`${c.api}/wallet/balance`, headers), read(`${c.api}/wallet/charges`, headers)]);
    if (balance && charges) wallet = { wallets: [{ user_id: balance.user, balance: balance.balance }], charge_count: charges.charge_count };
  }
  const jobs = s.user ? (db.prepare('SELECT j.* FROM jobs j JOIN bookings b ON b.job_id=j.id WHERE b.user_id=? ORDER BY j.rowid DESC LIMIT 12').all(s.user) as any[]).map(j => ({ ...j, detail: JSON.parse(j.detail) })) : [];
  const intent = s.user ? db.prepare("SELECT id FROM booking_intents WHERE user_id=? AND session_hash=? AND status='authorized' AND expires_at>? ORDER BY rowid DESC LIMIT 1").get(s.user, hash(s.csrf), now()) as any : null;
  return r.header('Cache-Control', 'no-store').send({ mode: c.mode, csrf: s.csrf, user: s.user || null, services: { as: c.as, api: c.api, taxi: c.taxi },
    other: c.mode === 'secure' ? c.taxi.replace(String(c.ports.taxi), String(c.ports.taxi - 1000)) : c.taxi.replace(String(c.ports.taxi), String(c.ports.taxi + 1000)),
    health: { as: asEvents !== null, api: apiEvents !== null, taxi: true }, link: link || null, now: now(), wallet, cases: caseCatalog, jobs, trips: db.prepare('SELECT * FROM trips ORDER BY rowid').all(),
    authorized_intent: intent?.id || null, oauth_result: s.oauthResult || null,
    events: s.user ? [...events(db), ...(asEvents || []), ...(apiEvents || [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 70) : [] });
});

await app.listen({ port: c.ports.taxi, host: '127.0.0.1' });
console.log(`[${c.mode}] Dashboard ${c.taxi}`);
function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(worker);
  void app.close().then(async () => { await Promise.all([...locks.values()]); db.close(); process.exit(0); });
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
