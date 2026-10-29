// HTTP-only helpers for demo attack fixtures: use the real login and consent pages.
// Taxi's normal OAuth protocol implementation lives in oauth-client.ts and uses openid-client.
import type { Config } from './config.js';
import { random } from './crypto.js';
import type { Step } from './cases.js';
export class BrowserSession {
  private cookies = new Map<string, string>();
  constructor(private trace?: Step[]) {}
  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    const origin = new URL(url).origin;
    if (this.cookies.has(origin)) headers.set('cookie', this.cookies.get(origin)!);
    const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const values = response.headers.getSetCookie();
    if (values.length) this.cookies.set(origin, values.map(v => v.split(';')[0]).join('; '));
    if (this.trace) {
      const target = new URL(url), fields = init.body instanceof URLSearchParams ? init.body : target.searchParams;
      const input = Object.fromEntries([...fields].map(([key, value]) => [key, /^(password|client_secret|access_token|refresh_token|csrf|request|state|code|code_verifier|code_challenge)$/.test(key) ? '[REDACTED]' : value]));
      const rawLocation = response.headers.get('location');
      let location: string | undefined, error: string | null = null, codeIssued = false;
      if (rawLocation) { const safe = new URL(rawLocation, url); error = safe.searchParams.get('error'); codeIssued = safe.searchParams.has('code'); for (const key of ['code', 'state', 'request']) if (safe.searchParams.has(key)) safe.searchParams.set(key, '[REDACTED]'); location = safe.href; }
      this.trace.push({ service: 'Wallet AS', from: 'Người dùng', endpoint: `${init.method || 'GET'} ${target.pathname}`, status: response.status,
        request: { [init.body ? 'body' : 'query']: input }, response: { ...(location ? { headers: { location } } : {}), error: error || (response.status === 400 ? 'invalid_request' : null), code_issued: codeIssued, ...(response.status === 200 ? { page: target.pathname === '/authorize' ? 'Đăng nhập ví' : 'Đồng ý cấp quyền' } : {}) },
        explanation: 'Bộ kiểm thử gửi HTTP đến endpoint chính, đọc status/Location thực tế và chỉ ghi các trường đã che.' });
    }
    return response;
  }
}
export const field = (html: string, name: string) => {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`Missing form field ${name}`);
  return match[1];
};
export async function authorizeFixture(c: Config, overrides: Record<string, string | undefined> = {}) {
  const verifier = random() + random(), { challenge } = await import('./crypto.js');
  const p = new URLSearchParams({ client_id: 'taxi-web', redirect_uri: `${c.taxi}/oauth/callback`, response_type: 'code', scope: 'wallet:read wallet:charge offline_access', state: random(), code_challenge: challenge(verifier), code_challenge_method: 'S256' });
  for (const [k, v] of Object.entries(overrides)) { if (v === undefined) p.delete(k); else p.set(k, v); }
  const steps: Step[] = [], browser = new BrowserSession(steps);
  let response = await browser.fetch(`${c.as}/authorize?${p}`);
  if (response.status !== 200) return { response, verifier, code: '', state: p.get('state')!, location: response.headers.get('location') || '', steps };
  const login = await response.text();
  response = await browser.fetch(`${c.as}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: c.as }, body: new URLSearchParams({ username: 'alice', password: c.alicePassword, csrf: field(login, 'csrf'), request: field(login, 'request') }) });
  if (response.status !== 302) throw new Error(`Fixture login failed: ${response.status}`);
  response = await browser.fetch(new URL(response.headers.get('location')!, c.as).href);
  const consent = await response.text();
  response = await browser.fetch(`${c.as}/consent`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: c.as }, body: new URLSearchParams({ csrf: field(consent, 'csrf'), request: field(consent, 'request'), decision: 'allow' }) });
  const location = response.headers.get('location') || '';
  return { response, verifier, code: location ? new URL(location).searchParams.get('code') || '' : '', state: p.get('state')!, location, steps };
}
export async function rawToken(c: Config, body: Record<string, string>, id = 'taxi-web', secret = c.clients[id]) {
  const response = await fetch(`${c.as}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}` }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
export async function exchangeFixture(c: Config, overrides: Record<string, string | undefined> = {}) {
  const fixture = await authorizeFixture(c, overrides);
  const body = { grant_type: 'authorization_code', code: fixture.code, redirect_uri: `${c.taxi}/oauth/callback`, code_verifier: fixture.verifier };
  return { ...fixture, request: body, tokens: await rawToken(c, body) };
}
