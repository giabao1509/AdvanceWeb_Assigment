import type { Config } from './config.js';
import { authorizeFixture, exchangeFixture, rawToken } from './fixtures.js';
import { tokenSummary } from './oauth-client.js';
import { random } from './crypto.js';

export const caseCatalog = [
  { id: 'redirect', title: 'Callback không đăng ký', description: 'AS có chuyển code tới địa chỉ lạ không?', target: 'Wallet AS · /authorize' },
  { id: 'pkce', title: 'Thiếu PKCE challenge', description: 'Xin code mà không chứng minh quyền đổi code.', target: 'Wallet AS · /authorize' },
  { id: 'code_replay', title: 'Dùng lại authorization code', description: 'Đổi một code hai lần và thử access token cũ.', target: 'Wallet AS → Wallet API' },
  { id: 'refresh_replay', title: 'Replay refresh token cũ', description: 'Xoay token, dùng lại token cũ rồi thử token mới.', target: 'Wallet AS · /token' },
  { id: 'wrong_secret', title: 'Client secret sai', description: 'Một client tự nhận là Taxi nhưng không biết secret.', target: 'Wallet AS · /token' },
  { id: 'm2m', title: 'M2M: bảng giá và giới hạn quyền', description: 'Client Credentials đọc rates nhưng không trừ tiền ví.', target: 'Wallet AS → Wallet API' }
];
export interface Step { service: string; endpoint: string; status: number; from?: string; request?: unknown; response: unknown; explanation: string; children?: Step[] }
// Only publish selected protocol fields; never serialize credentials into browser traces.
export function traceRequest(body: Record<string, string>, clientId = 'taxi-web') {
  return { headers: { authorization: `Basic [REDACTED] (${clientId})`, 'content-type': 'application/x-www-form-urlencoded' },
    body: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, /^(code|code_verifier|refresh_token)$/.test(key) ? '[REDACTED]' : value])) };
}
export async function runCase(c: Config, id: string) {
  const steps: Step[] = []; let protectedResult = false;
  async function tokenStep(body: Record<string, string>, explanation: string, clientId = 'taxi-web', secret = c.clients[clientId]) {
    const result = await rawToken(c, body, clientId, secret);
    const response = result.body.access_token ? await tokenSummary(c, result.body as any, body.grant_type) : result.body;
    steps.push({ service: 'Wallet AS', endpoint: 'POST /token', status: result.status, request: traceRequest(body, clientId), response, explanation });
    return result;
  }
  async function apiStep(path: string, token: string, explanation: string, init: RequestInit = {}) {
    const r = await fetch(`${c.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(15000) });
    const body = await r.json(); steps.push({ service: 'Wallet API', endpoint: `${init.method || 'GET'} ${path}`, status: r.status,
      request: { headers: { authorization: 'Bearer [REDACTED]', ...init.headers }, body: init.body ? JSON.parse(String(init.body)) : null }, response: body, explanation }); return r.status;
  }
  if (id === 'redirect' || id === 'pkce') {
    const fixture = await authorizeFixture(c, id === 'redirect' ? { redirect_uri: 'https://attacker.invalid/callback' } : { code_challenge: undefined, code_challenge_method: undefined });
    const location = fixture.location ? new URL(fixture.location) : null;
    steps.push(...fixture.steps);
    protectedResult = id === 'redirect' ? fixture.response.status === 400 && !location : location?.searchParams.get('error') === 'invalid_request';
  } else if (id === 'm2m') {
    const t = await tokenStep({ grant_type: 'client_credentials', scope: 'rates:read' }, 'Client taxi-m2m chỉ đại diện ứng dụng, không đại diện Alice.', 'taxi-m2m');
    await apiStep('/public/rates', t.body.access_token, 'Token client được đọc bảng giá.');
    const charged = await apiStep('/wallet/charges', t.body.access_token, 'API kiểm scope và principal; client không được charge ví.', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': random() }, body: JSON.stringify({ amount: 1000, trip_id: 'm2m-denied' }) });
    const escalated = await tokenStep({ grant_type: 'client_credentials', scope: 'wallet:charge' }, 'Thử xin scope không được cấp cho taxi-m2m.', 'taxi-m2m');
    protectedResult = charged === 403 && escalated.body.error === 'invalid_scope';
  } else {
    const fixture = await authorizeFixture(c);
    steps.push(...fixture.steps);
    const request = { grant_type: 'authorization_code', code: fixture.code, redirect_uri: `${c.taxi}/oauth/callback`, code_verifier: fixture.verifier };
    if (id === 'wrong_secret') {
      const result = await tokenStep(request, 'Secret không đúng: full phải trả 401 invalid_client.', 'taxi-web', 'incorrect-demo-secret'); protectedResult = result.status === 401 && result.body.error === 'invalid_client';
    } else if (id === 'wrong_verifier') {
      const result = await tokenStep({ ...request, code_verifier: random() + random() }, 'Verifier không khớp challenge đã gắn với code.'); protectedResult = result.body.error === 'invalid_grant';
    } else if (id === 'other_client') {
      const result = await tokenStep(request, 'Client khác có secret hợp lệ vẫn không được đổi code của taxi-web.', 'taxi-m2m'); protectedResult = result.body.error === 'invalid_grant';
    } else if (id === 'code_expired') {
      await new Promise(resolve => setTimeout(resolve, 61000));
      const result = await tokenStep(request, 'Đã chờ thật 61 giây; code TTL 60 giây.'); protectedResult = result.body.error === 'invalid_grant';
    } else if (id === 'code_replay') {
      const initial = await tokenStep(request, 'Lần đầu hợp lệ: AS cấp token.');
      const second = await tokenStep(request, 'Dùng lại cùng code: AS full từ chối và thu hồi grant.');
      const status = await apiStep('/wallet/balance', initial.body.access_token, 'Kiểm token lần đầu sau replay; full phải từ chối grant đã thu hồi.');
      protectedResult = second.body.error === 'invalid_grant' && status === 401;
    } else if (id === 'refresh_replay' || id === 'other_refresh') {
      const initial = await tokenStep(request, 'Đổi code có offline_access để lấy refresh token fixture.');
      if (id === 'other_refresh') {
        const result = await tokenStep({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token }, 'Client khác không sở hữu refresh token.', 'taxi-m2m');
        const valid = await tokenStep({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token }, 'Đúng client vẫn dùng được token: request sai client không phá family.');
        protectedResult = result.body.error === 'invalid_grant' && valid.status === 200;
      } else {
        const next = await tokenStep({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token }, 'Refresh lần đầu: full xoay sang token mới.');
        const replay = await tokenStep({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token }, 'Replay token cũ: full thu hồi cả family.');
        const family = await tokenStep({ grant_type: 'refresh_token', refresh_token: next.body.refresh_token }, 'Token mới cùng family cũng phải bị từ chối sau reuse.');
        protectedResult = replay.body.error === 'invalid_grant' && family.body.error === 'invalid_grant';
      }
    } else throw new Error('Unknown case');
  }
  return { id, mode: c.mode, at: new Date().toISOString(), protected: protectedResult,
    conclusion: protectedResult ? 'Hệ thống đã chặn đúng thao tác không hợp lệ trong tình huống này.' : 'AS chấp nhận thao tác mà full security cần chặn. Luồng chưa được bảo vệ đầy đủ trong tình huống này.', steps };
}
