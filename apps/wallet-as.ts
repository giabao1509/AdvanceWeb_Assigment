import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { SignJWT, importJWK } from 'jose';
import { config, modeFromEnv, now, subset, normalizeScope, hasScope } from '../shared/config.js';
import { database, audit, events } from '../shared/db.js';
import { random, hash, challenge, equal } from '../shared/crypto.js';
import { server, sessions, params, oauthError, escape } from '../shared/http.js';
import { page, hidden } from '../shared/views.js';
import type { Step } from '../shared/cases.js';

const c = config(modeFromEnv()), secure = c.mode === 'secure', db = database(c, 'as');
db.prepare('ATTACH DATABASE ? AS revocation').run(resolve(c.dir, 'revocations.sqlite'));
const app = await server(c, 'Wallet AS'), session = sessions(app, db, c, 'as');
const key = await importJWK(c.privateJwk, 'ES256');
app.get('/style.css', (_q, r) => r.type('text/css').send(readFileSync('public/style.css')));
app.get('/.well-known/jwks.json', () => ({ keys: [c.publicJwk] }));
app.get('/internal/events', (q, r) => {
  if (!equal(String(q.headers['x-client-secret'] || ''), c.clients['taxi-web'])) return r.code(401).send({ error: 'invalid_client' });
  return events(db);
});
// Capture actual browser requests at the AS; retain selected, redacted fields only.
app.addHook('preHandler', async q => {
  const path = q.url.split('?')[0];
  if (!['/authorize', '/login', '/consent'].includes(path)) return;
  const p = params(q.method === 'GET' ? q.query : q.body);
  if (!p) return;
  const row = p.request ? db.prepare('SELECT params FROM auth_requests WHERE id=?').get(p.request) as any : null;
  const state = path === '/authorize' ? p.state : row ? JSON.parse(row.params).state : null;
  if (!state) return;
  (q as any).oauthTrace = { id: hash(state), path, request: { [q.method === 'GET' ? 'query' : 'body']: Object.fromEntries(Object.entries(p).map(([key, value]) => [key, /^(password|client_secret|access_token|refresh_token|csrf|request|state|code|code_challenge)$/.test(key) ? '[REDACTED]' : value])) } };
});
app.addHook('onSend', async (q, r, payload) => {
  const trace = (q as any).oauthTrace;
  if (!trace) return payload;
  const rawLocation = r.getHeader('location');
  let location: string | undefined;
  if (typeof rawLocation === 'string') {
    const url = new URL(rawLocation, c.as);
    for (const key of ['code', 'state', 'request']) if (url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
    location = url.href;
  }
  const html = typeof payload === 'string' ? payload : '';
  const step: Step = { service: 'Wallet AS', from: 'Người dùng', endpoint: `${q.method} ${trace.path}`, status: r.statusCode, request: trace.request,
    response: { ...(location ? { headers: { location } } : {}), body: html.includes('<h1>Đăng nhập ví</h1>') ? { page: 'Đăng nhập ví' } : html.includes('<h1>Cho Taxi dùng ví?</h1>') ? { page: 'Đồng ý cấp quyền cho Taxi' } : { result: r.statusCode < 400 ? 'redirect' : 'rejected' } },
    explanation: trace.path === '/consent' && q.method === 'POST' ? 'Người dùng quyết định cấp quyền tại Wallet AS. Chỉ khi đồng ý, AS mới cấp authorization code.' : 'Request/response thực tế của trình duyệt tại Wallet AS; mật khẩu, code và state đã che.' };
  db.prepare('INSERT INTO oauth_trace_steps(trace_id,detail) VALUES(?,?)').run(trace.id, JSON.stringify(step));
  return payload;
});
app.get('/internal/oauth-traces/:id', (q, r) => {
  if (!equal(String(q.headers['x-client-secret'] || ''), c.clients['taxi-web'])) return r.code(401).send({ error: 'invalid_client' });
  return db.prepare('SELECT detail FROM oauth_trace_steps WHERE trace_id=? ORDER BY id').all((q.params as any).id).map((row: any) => JSON.parse(row.detail));
});
app.get('/', (_q, r) => r.redirect('/account'));

function redirect(reply: any, p: Record<string, string>, values: Record<string, string>) {
  const uri = new URL(p.redirect_uri);
  for (const [k, v] of Object.entries(values)) uri.searchParams.set(k, v);
  if (p.state !== undefined) uri.searchParams.set('state', p.state);
  return reply.redirect(uri.href);
}
function loginView(csrf: string, requestId = '', message = '') {
  return page('Đăng nhập Wallet', c.mode, `<div class="eyebrow">01 / WALLET AUTHORIZATION SERVER</div><h1>Đăng nhập ví</h1><p class="muted">Bạn đang ở Wallet AS. Taxi không thấy mật khẩu này.</p>
    ${message ? `<p class="alert">${escape(message)}</p>` : ''}<form method="post" action="/login">${hidden('csrf', csrf)}${hidden('request', requestId)}
    <label>Tài khoản<input name="username" autocomplete="username" value="alice" required></label><label>Mật khẩu<input type="password" name="password" autocomplete="current-password" required></label><button class="button primary">Đăng nhập Wallet</button></form>
    <aside class="note">Dữ liệu giả để demo: <b>alice</b> / <code>Alice-demo-2026!</code><br><b>bob</b> / <code>Bob-demo-2026!</code></aside>`);
}
function requestRow(id: string, s: any) {
  return db.prepare('SELECT * FROM auth_requests WHERE id=? AND session_hash=? AND expires_at>?').get(id, hash(s.csrf), now()) as any;
}
app.get('/authorize', async (q, r) => {
  const p = params(q.query);
  if (!p) return oauthError(r, 'invalid_request');
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(p.client_id || '') as any;
  if (!client || !p.redirect_uri || (secure && p.redirect_uri !== client.redirect_uri)) {
    audit(db, 'Wallet AS', 'Authorize: callback không được tin cậy', 400, { error: 'invalid_request', redirected: false });
    return r.code(400).type('text/html').send(page('Request bị từ chối', c.mode, '<h1>Không thể chuyển hướng</h1><p>Client hoặc redirect URI không hợp lệ. AS giữ lỗi ở đây để tránh gửi code tới bên khác.</p><code>invalid_request</code>'));
  }
  try { const uri = new URL(p.redirect_uri); if (!['http:', 'https:'].includes(uri.protocol) || uri.hash) return oauthError(r, 'invalid_request'); } catch { return oauthError(r, 'invalid_request'); }
  let error = '';
  if (p.response_type !== 'code') error = 'unsupported_response_type';
  else if (secure && !client.grants.split(' ').includes('authorization_code')) error = 'unauthorized_client';
  else if (secure && (!normalizeScope(p.scope || '') || !subset(p.scope, client.scope))) error = 'invalid_scope';
  else if (secure && (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || ''))) error = 'invalid_request';
  if (error) { audit(db, 'Wallet AS', 'Authorize bị từ chối', 302, { error, client: client.id }); return redirect(r, p, { error }); }
  const s = session.get(q, r), id = random();
  db.prepare('INSERT INTO auth_requests VALUES(?,?,?,?)').run(id, hash(s.csrf), JSON.stringify(p), now() + 600);
  audit(db, 'Wallet AS', 'Authorize → đăng nhập / consent', 200, { client: client.id, scope: p.scope, pkce: Boolean(p.code_challenge), redirect: new URL(p.redirect_uri).origin });
  if (!s.user) return r.type('text/html').send(loginView(s.csrf, id));
  return r.redirect(`/consent?request=${id}`);
});
app.get('/login', (q, r) => { const s = session.get(q, r); return r.type('text/html').send(loginView(s.csrf)); });
app.post('/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (q, r) => {
  const p = params(q.body), s = session.get(q, r);
  if (!p || !session.csrf(q, s, p.csrf, c.as)) return oauthError(r, 'invalid_request', 403);
  if (p.request && !requestRow(p.request, s)) return oauthError(r, 'invalid_request');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(p.username || '') as any;
  if (!user || !await argon2.verify(user.password_hash, p.password || '')) return r.code(401).type('text/html').send(loginView(s.csrf, p.request, 'Tài khoản hoặc mật khẩu không đúng.'));
  const next = session.rotate(q, r, { csrf: '', user: user.id });
  if (p.request) db.prepare('UPDATE auth_requests SET session_hash=? WHERE id=?').run(hash(next.csrf), p.request);
  audit(db, 'Wallet AS', 'Đăng nhập thành công', 200, { user: user.id });
  return r.redirect(p.request ? `/consent?request=${p.request}` : '/account');
});
app.get('/consent', (q, r) => {
  const p = params(q.query), s = session.get(q, r), row = requestRow(p?.request || '', s);
  if (!s.user || !row) return oauthError(r, 'invalid_request');
  const request = JSON.parse(row.params);
  return r.type('text/html').send(page('Cho phép Taxi', c.mode, `<div class="eyebrow">02 / RESOURCE OWNER CONSENT</div><h1>Cho Taxi dùng ví?</h1><p>Chào <b>${escape(s.user)}</b>, <b>${escape(request.client_id)}</b> đang xin quyền:</p>
    <ul class="permissions">${(request.scope || '').split(' ').filter(Boolean).map((scope: string) => `<li><code>${escape(scope)}</code><span>${escape(({ 'wallet:read': 'Xem số dư ví', 'wallet:charge': 'Trừ tiền sau chuyến đi', offline_access: 'Tiếp tục thanh toán khi bạn đã thoát app' } as any)[scope] || 'Scope ngoài quyền thông thường')}</span></li>`).join('')}</ul>
    <p class="note">AS cấp quyền theo consent này. Wallet API vẫn kiểm tra từng request.</p><form method="post" action="/consent">${hidden('request', row.id)}${hidden('csrf', s.csrf)}<div class="actions"><button class="button primary" name="decision" value="allow">Đồng ý liên kết</button><button class="button secondary" name="decision" value="deny">Từ chối</button></div></form>`));
});
app.post('/consent', (q, r) => {
  const p = params(q.body), s = session.get(q, r);
  if (!p || !session.csrf(q, s, p.csrf, c.as)) return oauthError(r, 'invalid_request', 403);
  const row = requestRow(p.request || '', s);
  if (!s.user || !row) return oauthError(r, 'invalid_request');
  const request = JSON.parse(row.params);
  if (!['allow', 'deny'].includes(p.decision)) return oauthError(r, 'invalid_request');
  if (p.decision === 'deny') { db.prepare('DELETE FROM auth_requests WHERE id=?').run(row.id); return redirect(r, request, { error: 'access_denied' }); }
  const code = random(), consent = random(), grant = random();
  db.transaction(() => {
    db.prepare('INSERT INTO consents VALUES(?,?,?,?,NULL)').run(consent, s.user, request.client_id, normalizeScope(request.scope || ''));
    db.prepare('INSERT INTO auth_codes VALUES(?,?,?,?,?,?,?,NULL,?,?)').run(hash(code), request.client_id, request.redirect_uri, s.user,
      normalizeScope(request.scope || ''), request.code_challenge || '', now() + 60, consent, grant);
    db.prepare('DELETE FROM auth_requests WHERE id=?').run(row.id);
  }).immediate();
  audit(db, 'Wallet AS', 'Consent → authorization code', 302, { user: s.user, client: request.client_id, code: '[REDACTED]', ttl: 60 });
  return redirect(r, request, { code });
});

function revoke(grantId: string, reason: string) {
  db.prepare('INSERT OR IGNORE INTO revocation.revoked_grants VALUES(?,?,?)').run(grantId, now(), reason);
  const families = db.prepare('SELECT DISTINCT family_id FROM issued_tokens WHERE grant_id=? AND family_id IS NOT NULL').all(grantId) as any[];
  for (const f of families) {
    db.prepare('UPDATE refresh_families SET revoked_at=? WHERE id=?').run(now(), f.family_id);
    db.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE family_id=?').run(now(), f.family_id);
  }
}
async function candidate(sub: string, client: string, scope: string, principal: string, grant: string) {
  const jti = random(), exp = now() + 120;
  const token = await new SignJWT({ client_id: client, scope, principal_type: principal, grant_id: grant })
    .setProtectedHeader({ alg: 'ES256', kid: c.kid, typ: 'at+jwt' }).setIssuer(c.as).setAudience('wallet-api').setSubject(sub).setIssuedAt().setExpirationTime(exp).setJti(jti).sign(key);
  return { token, jti, exp };
}
app.post('/token', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (q, r) => {
  const p = params(q.body);
  if (!q.headers['content-type']?.startsWith('application/x-www-form-urlencoded') || !p || 'client_secret' in p || 'client_id' in p) return oauthError(r, 'invalid_request');
  let id = '', secret = '';
  try {
    if (!q.headers.authorization?.startsWith('Basic ')) throw new Error();
    const decoded = Buffer.from(q.headers.authorization.slice(6), 'base64').toString(); const colon = decoded.indexOf(':');
    if (colon < 1) throw new Error();
    id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')); secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
  } catch { return oauthError(r, 'invalid_client', 401); }
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(id) as any;
  const fail = (error: string, status = 400) => { audit(db, 'Wallet AS', '/token từ chối', status, { grant: p.grant_type, client: id, error }, String(q.headers['x-trace-id'] || '')); return oauthError(r, error, status); };
  if (!client || (secure && !await argon2.verify(client.secret_hash, secret))) return fail('invalid_client', 401);
  if (!['authorization_code', 'refresh_token', 'client_credentials'].includes(p.grant_type)) return fail('unsupported_grant_type');
  let sub: string, scope: string, grant: string, family: any, row: any;
  const timestamp = now();
  if (p.grant_type === 'authorization_code') {
    row = db.prepare('SELECT * FROM auth_codes WHERE code_hash=?').get(hash(p.code || '')) as any;
    if (!row || (secure && row.client_id !== id)) return fail('invalid_grant');
    if (secure && !client.grants.split(' ').includes(p.grant_type)) return fail('unauthorized_client');
    if (secure && (p.redirect_uri !== row.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier || '') || !equal(challenge(p.code_verifier), row.challenge))) return fail('invalid_grant');
    sub = row.user_id; scope = row.scope; grant = row.grant_id;
  } else if (p.grant_type === 'refresh_token') {
    row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=?').get(hash(p.refresh_token || '')) as any;
    if (!row || (secure && row.client_id !== id)) return fail('invalid_grant');
    if (secure && !client.grants.split(' ').includes(p.grant_type)) return fail('unauthorized_client');
    family = db.prepare('SELECT * FROM refresh_families WHERE id=?').get(row.family_id) as any;
    sub = family.user_id; scope = normalizeScope(p.scope === undefined ? row.scope : p.scope);
    grant = (db.prepare('SELECT grant_id FROM issued_tokens WHERE family_id=? LIMIT 1').get(family.id) as any)?.grant_id;
    if (!grant) return fail('invalid_grant');
  } else {
    if (secure && !client.grants.split(' ').includes(p.grant_type)) return fail('unauthorized_client');
    scope = normalizeScope(p.scope || client.scope);
    if (secure && !subset(scope, client.scope)) return fail('invalid_scope');
    sub = id; grant = random();
  }
  const issued = await candidate(sub, id, scope, p.grant_type === 'client_credentials' ? 'client' : 'user', grant);
  const newRefresh = random(), refreshHash = hash(newRefresh), familyId = family?.id || random();
  const outcome = db.transaction(() => {
    if (p.grant_type === 'authorization_code') {
      const current = db.prepare('SELECT * FROM auth_codes WHERE code_hash=?').get(row.code_hash) as any;
      if (secure && current.used_at) { revoke(grant, 'authorization_code_replay'); return 'invalid_grant'; }
      const consent = db.prepare('SELECT * FROM consents WHERE id=?').get(row.consent_id) as any;
      if (secure && (current.expires_at <= now() || !consent || consent.revoked_at)) return 'invalid_grant';
      db.prepare('UPDATE auth_codes SET used_at=? WHERE code_hash=?').run(now(), row.code_hash);
      if (hasScope(scope, 'offline_access')) {
        db.prepare('INSERT INTO refresh_families VALUES(?,?,?,?,?,?,NULL)').run(familyId, sub, id, row.consent_id, scope, timestamp + 604800);
        db.prepare('INSERT INTO refresh_tokens VALUES(?,?,?,?,?,NULL,NULL,NULL)').run(refreshHash, familyId, id, scope, timestamp + 604800);
      }
    } else if (p.grant_type === 'refresh_token') {
      const current = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=?').get(row.token_hash) as any;
      const f = db.prepare('SELECT * FROM refresh_families WHERE id=?').get(family.id) as any;
      const consent = db.prepare('SELECT * FROM consents WHERE id=?').get(f.consent_id) as any;
      if (secure && (f.revoked_at || current.revoked_at || f.expires_at <= now() || current.expires_at <= now() || !consent || consent.revoked_at)) return 'invalid_grant';
      if (secure && current.used_at) { revoke(grant, 'refresh_reuse'); return 'invalid_grant'; }
      if (secure && !subset(scope, current.scope)) return 'invalid_scope';
      if (secure) {
        db.prepare('UPDATE refresh_tokens SET used_at=?,replaced_by=? WHERE token_hash=?').run(now(), refreshHash, row.token_hash);
        db.prepare('INSERT INTO refresh_tokens VALUES(?,?,?,?,?,NULL,NULL,NULL)').run(refreshHash, familyId, id, scope, f.expires_at);
        db.prepare('UPDATE refresh_families SET scope=? WHERE id=?').run(scope, familyId);
      }
    }
    db.prepare('INSERT INTO issued_tokens VALUES(?,?,?,?)').run(issued.jti, grant, p.grant_type !== 'client_credentials' && (family || hasScope(scope, 'offline_access')) ? familyId : null, issued.exp);
    return '';
  }).immediate();
  if (outcome) return fail(outcome);
  const result: Record<string, unknown> = { access_token: issued.token, token_type: 'Bearer', expires_in: 120, scope };
  if (p.grant_type === 'authorization_code' && hasScope(scope, 'offline_access')) result.refresh_token = newRefresh;
  if (p.grant_type === 'refresh_token') result.refresh_token = secure ? newRefresh : p.refresh_token;
  audit(db, 'Wallet AS', '/token cấp token', 200, { grant: p.grant_type, client: id, sub, scope, principal_type: p.grant_type === 'client_credentials' ? 'client' : 'user', expires_in: 120, exp: issued.exp, refresh_token: Boolean(result.refresh_token), tokens: '[REDACTED]' }, String(q.headers['x-trace-id'] || ''));
  return r.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(result);
});

app.get('/account', (q, r) => {
  const s = session.get(q, r); if (!s.user) return r.redirect('/login');
  const rows = db.prepare('SELECT client_id,scope FROM consents WHERE user_id=? AND revoked_at IS NULL').all(s.user) as any[];
  return r.type('text/html').send(page('Quyền ứng dụng', c.mode, `<div class="eyebrow">WALLET ACCOUNT / ${escape(s.user)}</div><h1>Quản lý quyền</h1><p class="muted">Gỡ quyền ngăn Taxi tiếp tục refresh. Access token đã cấp vẫn hợp lệ đến exp.</p>${rows.length ? `<ul class="permissions">${rows.map(row => `<li><b>${escape(row.client_id)}</b><span>${escape(row.scope)}</span></li>`).join('')}</ul><form method="post" action="/account/revoke">${hidden('csrf', s.csrf)}<button class="button danger">Gỡ toàn bộ quyền của Taxi</button></form>` : '<p class="note">Chưa có quyền đang hoạt động.</p>'}<p><a href="${c.taxi}">← Về dashboard Taxi</a></p><form method="post" action="/logout">${hidden('csrf', s.csrf)}<button class="button secondary">Đăng xuất Wallet</button></form>`));
});
app.post('/account/revoke', (q, r) => {
  const s = session.get(q, r), p = params(q.body);
  if (!s.user || !p || !session.csrf(q, s, p.csrf, c.as)) return oauthError(r, 'invalid_request', 403);
  db.transaction(() => {
    db.prepare('UPDATE consents SET revoked_at=? WHERE user_id=? AND client_id=?').run(now(), s.user, 'taxi-web');
    db.prepare('UPDATE refresh_families SET revoked_at=? WHERE user_id=? AND client_id=?').run(now(), s.user, 'taxi-web');
    db.prepare('UPDATE refresh_tokens SET revoked_at=? WHERE family_id IN (SELECT id FROM refresh_families WHERE user_id=? AND client_id=?)').run(now(), s.user, 'taxi-web');
  }).immediate();
  audit(db, 'Wallet AS', 'Alice/Bob gỡ consent', 200, { user: s.user, policy: secure ? 'Refresh bị chặn; access token đến exp' : 'Baseline chưa enforce consent khi refresh' });
  return r.redirect('/account');
});
app.post('/logout', (q, r) => { const s = session.get(q, r), p = params(q.body); if (!p || !session.csrf(q, s, p.csrf, c.as)) return oauthError(r, 'invalid_request', 403); session.destroy(q, r); return r.redirect('/login'); });
await app.listen({ port: c.ports.as, host: '127.0.0.1' });
console.log(`[${c.mode}] Wallet AS ${c.as}`);
let closing = false;
function shutdown() { if (closing) return; closing = true; void app.close().then(() => { db.close(); process.exit(0); }); }
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
