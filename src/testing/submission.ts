import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { SignJWT, decodeJwt } from 'jose';
import { config, url } from '../shared/config.js';
import { inventoryMetrics, openBaselineInventory, openSecureInventory, openSecureOrder } from '../shared/database.js';
import { canonicalBody, bodyHash, canonicalRequest, createSignature, signatureHeaders, loadPrivateKey, loadPublicKey, verifyHmac, verifyEd25519, type SigningAlgorithm } from '../shared/signing.js';
import { ProcessManager } from '../supervisor/process-manager.js';

interface SafeLog { at: string; service: string; event: string; traceId: string; reason?: string; claim?: string; status?: number }
interface Snapshot { stock: Array<{ sku: string; availableQty: number }>; reservations: number }
interface Result {
  id: string; label: string; traceId: string; startedAt: string; completedAt: string;
  request: unknown; response: { status: number; body: unknown }; logs: SafeLog[];
  before: Snapshot; after: Snapshot; expectedStatus: number | number[];
  checks: Record<string, boolean>; pass: boolean; jwt?: unknown; internalExchange?: unknown; cookiePolicy?: unknown;
}
interface Step {
  id: string; label: string; service?: 'secure-order' | 'secure-inventory' | 'baseline-order' | 'baseline-inventory';
  path?: string; method?: string; body?: unknown; headers?: Record<string, string>; duplicateHeader?: [string, string];
  expected: number | number[]; reason?: string; jwt?: string; internal?: boolean; checkMutation?: boolean;
}

export async function runSubmission(outputDir: string) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const manager = new ProcessManager();
  const logs: SafeLog[] = [];
  const results: Result[] = [];
  const sensitive = new Set<string>([config.password, config.hmacSecret().toString('base64url'), config.jwtSecret().toString('base64url')]);
  const remember = (value?: string) => { if (value) sensitive.add(value); return value ?? ''; };
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of sensitive) if (secret.length >= 8) text = text.split(secret).join('[REDACTED]');
      return text.replace(/Bearer\s+[^\s";]+/gi, 'Bearer [REDACTED]').replace(/refresh_token=[^;\s"']+/gi, 'refresh_token=[REDACTED]');
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(password|authorization|cookie|set-cookie|accessToken|refreshToken|token|x-signature)$/i.test(key) ? '[REDACTED]' : clean(item)]));
    return value;
  };
  manager.subscribe((entry) => {
    try {
      const parsed = JSON.parse(entry.line) as Record<string, unknown>;
      if (typeof parsed.event !== 'string' || typeof parsed.traceId !== 'string' || !parsed.traceId.startsWith(runId)) return;
      logs.push({ at: entry.at, service: entry.process, event: parsed.event, traceId: parsed.traceId,
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        ...(typeof parsed.claim === 'string' ? { claim: parsed.claim } : {}),
        ...(typeof parsed.status === 'number' ? { status: parsed.status } : {}) });
    } catch { /* only explicitly selected, structured audit events enter the submission */ }
  });
  const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const addCheck = (record: Result, name: string, ok: boolean) => {
    record.checks[name] = ok; record.pass = Object.values(record.checks).every(Boolean);
  };
  const jwtMeta = (token: string) => {
    try {
      const p = decodeJwt(token);
      return { iat: p.iat, exp: p.exp, issuer: p.iss, audience: p.aud,
        issuedAt: typeof p.iat === 'number' ? new Date(p.iat * 1000).toISOString() : null,
        expiresAt: typeof p.exp === 'number' ? new Date(p.exp * 1000).toISOString() : null };
    } catch { return { format: 'invalid' }; }
  };
  let inventory: ReturnType<typeof openSecureInventory> | undefined;
  let baseline: ReturnType<typeof openBaselineInventory> | undefined;
  let order: ReturnType<typeof openSecureOrder> | undefined;
  const snapshot = (isBaseline: boolean) => inventoryMetrics((isBaseline ? baseline : inventory)!);
  const ports = () => ({ 'secure-order': config.ports.secureOrder, 'secure-inventory': config.ports.secureInventory,
    'baseline-order': config.ports.baselineOrder, 'baseline-inventory': config.ports.baselineInventory });
  async function step(input: Step) {
    const service = input.service ?? 'secure-order';
    const traceId = `${runId}-${input.id}-${randomUUID().slice(0, 8)}`;
    const path = input.path ?? (service.endsWith('inventory') ? '/internal/reservations' : '/orders');
    const endpoint = url(ports()[service], path);
    const method = input.method ?? 'POST';
    const headers = { ...(input.body === undefined ? {} : { 'content-type': 'application/json' }), ...input.headers, 'x-trace-id': traceId };
    const before = snapshot(service.startsWith('baseline'));
    const began = new Date().toISOString();
    const exchange = input.internal ? manager.waitForHttpExchange(traceId) : null;
    let status: number; let body: unknown; let responseHeaders: Headers;
    try {
      if (input.duplicateHeader) {
        const rawHeaders = Object.entries(headers).flatMap(([k, v]) => [k, v]);
        rawHeaders.push('host', new URL(endpoint).host, 'content-length', String(Buffer.byteLength(input.body === undefined ? '' : JSON.stringify(input.body))));
        rawHeaders.push(...input.duplicateHeader);
        const raw = await new Promise<{ status: number; body: unknown; headers: Headers }>((done, reject) => {
          const req = httpRequest(endpoint, { method, headers: rawHeaders, timeout: 10_000 }, (res) => {
            let text = ''; res.on('data', (chunk) => { text += String(chunk); });
            res.on('end', () => { let parsed: unknown = {}; try { parsed = JSON.parse(text); } catch { parsed = text; }
              done({ status: res.statusCode!, body: parsed, headers: new Headers() }); });
          });
          req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
          req.end(input.body === undefined ? undefined : JSON.stringify(input.body));
        });
        status = raw.status; body = raw.body; responseHeaders = raw.headers;
      } else {
        const response = await fetch(endpoint, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: AbortSignal.timeout(10_000) });
        status = response.status; responseHeaders = response.headers; body = await response.json().catch(() => ({}));
      }
    } catch (error) { await exchange?.catch(() => undefined); throw error; }
    if (body && typeof body === 'object' && 'accessToken' in body && typeof body.accessToken === 'string') remember(body.accessToken);
    const cookie = remember(responseHeaders.get('set-cookie')?.split(';', 1)[0]);
    const internal = exchange ? await exchange : null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (!logs.some((l) => l.traceId === traceId && l.service === service && l.event === 'HTTP_RESPONSE')
      || (input.reason && !logs.some((l) => l.traceId === traceId && l.service === service && l.reason === input.reason)))) await wait(20);
    const after = snapshot(service.startsWith('baseline'));
    const record: Result = {
      id: input.id, label: input.label, traceId, startedAt: began, completedAt: new Date().toISOString(),
      request: clean({ method, url: endpoint, headers, body: input.body, ...(input.duplicateHeader ? { duplicatedHeader: input.duplicateHeader[0] } : {}) }),
      response: { status, body: clean(body) }, logs: logs.filter((l) => l.traceId === traceId), before, after, expectedStatus: input.expected,
      checks: { status: Array.isArray(input.expected) ? input.expected.includes(status) : status === input.expected,
        responseLog: logs.some((l) => l.traceId === traceId && l.service === service && l.event === 'HTTP_RESPONSE' && l.status === status) }, pass: false,
    };
    if (input.reason) record.checks.reasonLog = record.logs.some((l) => l.service === service && l.reason === input.reason);
    if (input.checkMutation !== false) {
      const delta = status === 201 && (path === '/orders' || path === '/internal/reservations') ? 1 : 0;
      record.checks.reservationDelta = after.reservations - before.reservations === delta;
      if (delta === 0) record.checks.stockUnchanged = JSON.stringify(before.stock) === JSON.stringify(after.stock);
    }
    if (input.jwt) record.jwt = jwtMeta(input.jwt);
    if (internal) { record.internalExchange = clean({ ...internal, logs: record.logs.filter((l) => l.service.endsWith('inventory')) }); record.checks.internalHttp = internal.response.status === status; }
    const setCookie = responseHeaders.get('set-cookie');
    if (setCookie) record.cookiePolicy = { httpOnly: /httponly/i.test(setCookie), sameSite: setCookie.match(/samesite=([^;]+)/i)?.[1],
      path: setCookie.match(/path=([^;]+)/i)?.[1], secure: /;\s*secure(?:;|$)/i.test(setCookie), cleared: /max-age=0|expires=thu, 01 jan 1970/i.test(setCookie) };
    record.pass = Object.values(record.checks).every(Boolean); results.push(record);
    console.log(`${record.pass ? 'OK' : 'FAIL'} ${input.id}: HTTP ${status}`);
    return { record, body: body as Record<string, unknown>, cookie, status };
  }
  async function mode(algorithm: SigningAlgorithm, kid: 'ed-1' | 'ed-2' = 'ed-1') {
    manager.send('secure-inventory', { type: 'set-verifier-mode', algorithm });
    manager.send('secure-order', { type: 'set-signing', algorithm, kid });
    return Promise.all([
      manager.waitForWorkerState('secure-inventory', (s) => s?.activeAlgorithm === algorithm),
      manager.waitForWorkerState('secure-order', (s) => s?.activeAlgorithm === algorithm && s.activeSigningKid === (algorithm === 'ed25519' ? kid : 'hmac-lab-1')),
    ]);
  }
  const reservation = () => ({ sku: 'SKU-001', quantity: 1, orderId: randomUUID() });
  const signed = (body: ReturnType<typeof reservation>, algorithm: SigningAlgorithm = 'hmac-sha256', kid = algorithm === 'ed25519' ? 'ed-1' : 'hmac-lab-1', overrides: { timestamp?: string; nonce?: string } = {}) =>
    signatureHeaders(createSignature(body, algorithm, kid, algorithm === 'hmac-sha256' ? config.hmacSecret() : loadPrivateKey(config.privateKeyPath(kid === 'ed-2' ? 'ed-2' : 'ed-1')), overrides));
  const internalStep = (id: string, label: string, body: ReturnType<typeof reservation>, headers: Record<string, string>, expected: number, reason?: string) =>
    step({ id, label, service: 'secure-inventory', body, headers, expected, reason });
  const login = async (id: string) => {
    const response = await step({ id, label: 'Đăng nhập bằng tài khoản lab', path: '/auth/login', body: { username: config.username, password: config.password }, expected: 200 });
    const token = remember(typeof response.body.accessToken === 'string' ? response.body.accessToken : undefined);
    response.record.jwt = jwtMeta(token); addCheck(response.record, 'accessIssued', Boolean(token));
    addCheck(response.record, 'refreshCookieHttpOnly', Boolean((response.record.cookiePolicy as { httpOnly?: boolean })?.httpOnly));
    return { ...response, token };
  };
  let canonical: unknown; const rotation: unknown[] = []; const concurrency: unknown[] = [];
  try {
    await manager.startAll();
    inventory = openSecureInventory(); baseline = openBaselineInventory(); order = openSecureOrder();
    const body = reservation();
    // Expired timestamp makes these published example signatures unusable for live requests.
    canonical = { purpose: 'Ví dụ tính thật bằng khóa lab; timestamp cố định đã quá hạn, không công bố khóa bí mật.',
      body, canonicalBody: canonicalBody(body), bodySha256: bodyHash(body), examples: (['hmac-sha256', 'ed25519'] as const).map((algorithm) => {
        const kid = algorithm === 'ed25519' ? 'ed-1' : 'hmac-lab-1';
        const parts = createSignature(body, algorithm, kid, algorithm === 'ed25519' ? loadPrivateKey(config.privateKeyPath('ed-1')) : config.hmacSecret(),
          { timestamp: '1700000000', nonce: '00000000-0000-4000-8000-000000000001' });
        const text = canonicalRequest(body, parts);
        return { algorithm, kid, canonical: text, lineCount: text.split('\n').length, trailingNewline: text.endsWith('\n'), signature: parts.signature,
          verified: algorithm === 'ed25519' ? verifyEd25519(text, parts.signature, loadPublicKey(config.publicKeyPath('ed-1'))) : verifyHmac(text, parts.signature, config.hmacSecret()) };
      }) };
    await step({ id: 'B01', label: 'Baseline đặt hàng đủ tồn kho', service: 'baseline-order', body: { sku: 'SKU-001', quantity: 2 }, expected: 201, internal: true });
    await step({ id: 'B02', label: 'Baseline thiếu tồn kho', service: 'baseline-order', body: { sku: 'SKU-LOW', quantity: 2 }, expected: 409, internal: true });
    await step({ id: 'B03', label: 'Gọi thẳng Inventory baseline không chữ ký', service: 'baseline-inventory', body: reservation(), expected: 201 });
    await step({ id: 'B04', label: 'Baseline nhận đơn không JWT', service: 'baseline-order', body: { sku: 'SKU-001', quantity: 1 }, expected: 201, internal: true });
    await internalStep('S01', 'Thiếu chữ ký service', reservation(), {}, 401, 'MISSING_SIGNATURE');
    { const b = reservation(); await internalStep('S02', 'HMAC sai', b, { ...signed(b), 'x-signature': randomBytes(32).toString('base64url') }, 401, 'BAD_SIGNATURE'); }
    { const b = reservation(); await internalStep('S03', 'Sửa quantity sau khi ký', { ...b, quantity: 2 }, signed(b), 401, 'BAD_SIGNATURE'); }
    { const b = reservation(), headers = signed(b); const before = snapshot(false);
      await internalStep('S04-1', 'Nonce được dùng lần đầu', b, headers, 201);
      const replay = await internalStep('S04-2', 'Replay cùng body và nonce', b, headers, 401, 'REPLAY_NONCE');
      addCheck(replay.record, 'exactlyOneReservationAcrossBothAttempts', snapshot(false).reservations - before.reservations === 1); }
    for (const [id, offset] of [['S05', -61], ['S06', 120]] as const) { const b = reservation(); await internalStep(id, 'Timestamp ngoài cửa sổ cho phép', b, signed(b, 'hmac-sha256', 'hmac-lab-1', { timestamp: String(Math.floor(Date.now() / 1000) + offset) }), 401, 'TIMESTAMP_OUT_OF_WINDOW'); }
    { const b = reservation(); await internalStep('S07', 'HMAC hợp lệ', b, signed(b), 201); }
    { const b = { ...reservation(), sku: 'SKU-LOW', quantity: 2 }; await internalStep('S08', 'Chữ ký đúng nhưng thiếu hàng', b, signed(b), 409); }
    { const b = reservation(), h = signed(b); await step({ id: 'S09', label: 'Header bảo mật bị trùng', service: 'secure-inventory', body: b, headers: h, duplicateHeader: ['x-key-id', h['x-key-id']!], expected: 401, reason: 'DUPLICATE_SECURITY_HEADER' }); }
    { const b = reservation(), headers = signed(b), before = snapshot(false);
      const attempts = await Promise.all([1, 2].map((n) => step({ id: `S10-${n}`, label: 'Hai request đồng thời cùng nonce', service: 'secure-inventory', body: b, headers, expected: [201, 401], checkMutation: false })));
      const after = snapshot(false), pass = attempts.map((r) => r.status).sort().join(',') === '201,401' && after.reservations - before.reservations === 1;
      for (const r of attempts) addCheck(r.record, 'concurrentSingleReservation', pass);
      concurrency.push({ id: 'S10', before, after, statuses: attempts.map((r) => r.status), pass }); }
    await mode('ed25519');
    { const b = reservation(); await internalStep('S11', 'Ed25519 ed-1 hợp lệ', b, signed(b, 'ed25519'), 201); }
    { const b = reservation(); await internalStep('S12', 'Key ID không được tin cậy', b, { ...signed(b, 'ed25519'), 'x-key-id': 'unknown-key' }, 401, 'UNKNOWN_KID'); }
    { const b = reservation(); await internalStep('S13', 'Khai ed-1 nhưng ký bằng private ed-2', b, { ...signed(b, 'ed25519', 'ed-2'), 'x-key-id': 'ed-1' }, 401, 'BAD_SIGNATURE'); }
    { const b = reservation(); await internalStep('S14', 'Chữ ký Ed25519 bị thay đổi', b, { ...signed(b, 'ed25519'), 'x-signature': randomBytes(64).toString('base64url') }, 401, 'BAD_SIGNATURE'); }
    { const b = reservation(); await internalStep('S15', 'Gửi HMAC khi verifier chỉ cho Ed25519', b, signed(b), 401, 'ALGORITHM_NOT_ALLOWED'); }
    { const b = reservation(); await internalStep('S16', 'Nonce sai định dạng', b, signed(b, 'ed25519', 'ed-1', { nonce: 'not-a-uuid' }), 401, 'MALFORMED_NONCE'); }

    const user = await login('J01');
    addCheck(user.record, 'configuredJwtTtl', decodeJwt(user.token).exp! - decodeJwt(user.token).iat! === config.accessTtl);
    await step({ id: 'J02', label: 'Username không tồn tại', path: '/auth/login', body: { username: `missing-${runId}`, password: 'wrong-demo-password' }, expected: 401, reason: 'BAD_CREDENTIALS' });
    await step({ id: 'J03', label: 'Sai mật khẩu', path: '/auth/login', body: { username: config.username, password: 'wrong-demo-password' }, expected: 401, reason: 'BAD_CREDENTIALS' });
    await step({ id: 'J04', label: 'Thiếu bearer JWT', body: { sku: 'SKU-001', quantity: 1 }, expected: 401, reason: 'MISSING_BEARER' });
    const fixtureJwt = async (changes: { issuer?: string; audience?: string; exp?: number; wrongKey?: boolean } = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return remember(await new SignJWT({ username: config.username }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(String(decodeJwt(user.token).sub))
        .setIssuer(changes.issuer ?? config.issuer).setAudience(changes.audience ?? config.audience).setIssuedAt(now).setExpirationTime(changes.exp ?? now + 120)
        .sign(changes.wrongKey ? randomBytes(32) : config.jwtSecret()));
    };
    const jwtCases = [
      ['J05', 'JWT sai chữ ký', await fixtureJwt({ wrongKey: true }), 'JWSSignatureVerificationFailed'],
      ['J06', 'JWT alg=none', remember(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + user.token.split('.')[1] + '.'), 'JOSEAlgNotAllowed'],
      ['J07', 'JWT đã hết hạn (fixture ký bằng khóa lab)', await fixtureJwt({ exp: Math.floor(Date.now() / 1000) - 1 }), 'JWTExpired'],
      ['J08', 'JWT sai issuer', await fixtureJwt({ issuer: 'wrong-issuer' }), 'JWTClaimValidationFailed'],
      ['J09', 'JWT sai audience', await fixtureJwt({ audience: 'wrong-audience' }), 'JWTClaimValidationFailed'],
    ] as const;
    for (const [id, label, token, reason] of jwtCases) await step({ id, label, body: { sku: 'SKU-001', quantity: 1 }, headers: { authorization: `Bearer ${token}` }, jwt: token, expected: 401, reason });
    await mode('hmac-sha256');
    await step({ id: 'J10', label: 'JWT đúng đi qua Order → Inventory HMAC thật', body: { sku: 'SKU-001', quantity: 1 }, headers: { authorization: `Bearer ${user.token}` }, jwt: user.token, expected: 201, internal: true });
    const refresh = await step({ id: 'J11', label: 'Refresh A đổi thành B', path: '/auth/refresh', headers: { cookie: user.cookie }, expected: 200 });
    addCheck(refresh.record, 'refreshRotated', Boolean(refresh.cookie) && refresh.cookie !== user.cookie);
    await step({ id: 'J12', label: 'Dùng lại refresh A làm revoke family', path: '/auth/refresh', headers: { cookie: user.cookie }, expected: 401, reason: 'TOKEN_REUSE' });
    await step({ id: 'J13', label: 'Refresh B bị từ chối sau family revoke', path: '/auth/refresh', headers: { cookie: refresh.cookie }, expected: 401, reason: 'INVALID_TOKEN' });
    { const session = await login('J14-login');
      const attempts = await Promise.all([1, 2].map((n) => step({ id: `J14-${n}`, label: 'Hai refresh đồng thời dùng token A', path: '/auth/refresh', headers: { cookie: session.cookie }, expected: [200, 401] })));
      const rows = order.prepare('SELECT consumed_at, revoked_at FROM refresh_tokens WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)').all(createHash('sha256').update(session.cookie.split('=', 2)[1]!).digest('hex')) as Array<{ consumed_at: number | null; revoked_at: number | null }>;
      const pass = attempts.map((r) => r.status).sort().join(',') === '200,401' && rows.length === 2 && rows.every((r) => r.revoked_at !== null);
      attempts.forEach((r) => addCheck(r.record, 'singleRefreshThenFamilyRevocation', pass)); concurrency.push({ id: 'J14', statuses: attempts.map((r) => r.status), familyRows: rows.length, allRevoked: rows.every((r) => r.revoked_at !== null), pass }); }
    await step({ id: 'J18', label: 'Refresh token ngẫu nhiên không biết', path: '/auth/refresh', headers: { cookie: `refresh_token=${randomBytes(32).toString('base64url')}` }, expected: 401, reason: 'INVALID_TOKEN' });
    await step({ id: 'J19', label: 'Refresh từ Origin không được phép', path: '/auth/refresh', headers: { origin: 'https://not-allowed.invalid', cookie: user.cookie }, expected: 403, reason: 'FORBIDDEN_ORIGIN' });
    await step({ id: 'J20', label: 'Không gửi refresh cookie', path: '/auth/refresh', expected: 401, reason: 'MISSING_REFRESH_COOKIE' });

    await mode('ed25519', 'ed-1');
    const rotationUser = await login('K-login');
    const rotationOrder = async (id: string, label: string) => {
      const response = await step({ id, label, body: { sku: 'SKU-001', quantity: 1 }, headers: { authorization: `Bearer ${rotationUser.token}` }, jwt: rotationUser.token, expected: 201, internal: true });
      rotation.push({ phase: id, traceId: response.record.traceId, states: (await manager.statuses()).filter((s) => s.name.startsWith('secure')).map((s) => s.state) });
      return response;
    };
    await rotationOrder('K01', 'Trước rotation: E2E ed-1');
    manager.send('secure-inventory', { type: 'add-trusted-key', kid: 'ed-2' });
    await manager.waitForWorkerState('secure-inventory', (s) => Boolean(s?.trustedKids?.includes('ed-1') && s.trustedKids.includes('ed-2')));
    await rotationOrder('K02', 'Prepare ed-2 nhưng vẫn ký ed-1');
    // Submit old-key requests while switching signer; await every owned request before retiring.
    const overlapBefore = snapshot(false);
    const overlapBodies = Array.from({ length: 3 }, reservation);
    const overlap = overlapBodies.map((b, index) => step({ id: `K05-${index + 1}`, label: 'Request ed-1 trong cửa sổ overlap', service: 'secure-inventory', body: b, headers: signed(b, 'ed25519'), expected: 201, checkMutation: false }));
    await mode('ed25519', 'ed-2');
    const overlapped = await Promise.all(overlap);
    const overlapPass = snapshot(false).reservations - overlapBefore.reservations === overlapBodies.length && overlapped.every((r) => r.status === 201);
    overlapped.forEach((r) => addCheck(r.record, 'allOverlapReservationsCreated', overlapPass));
    await rotationOrder('K03', 'Sau Switch: E2E ed-2');
    manager.send('secure-inventory', { type: 'remove-trusted-key', kid: 'ed-1' });
    await manager.waitForWorkerState('secure-inventory', (s) => Boolean(s?.trustedKids?.includes('ed-2') && !s.trustedKids.includes('ed-1')));
    { const b = reservation(); await internalStep('K04-old', 'Sau Retire: ed-1 bị từ chối', b, signed(b, 'ed25519'), 401, 'UNKNOWN_KID'); }
    await rotationOrder('K04-new', 'Sau Retire: E2E ed-2 còn hợp lệ');

    const logoutUser = await login('J15-login');
    const claims = decodeJwt(logoutUser.token);
    await step({ id: 'J15-before', label: 'Access JWT dùng được trước logout', method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${logoutUser.token}` }, jwt: logoutUser.token, expected: 200 });
    const logout = await step({ id: 'J15', label: 'Logout thu hồi family và xóa cookie', path: '/auth/logout', headers: { cookie: logoutUser.cookie }, expected: 204 });
    addCheck(logout.record, 'cookieCleared', Boolean((logout.record.cookiePolicy as { cleared?: boolean })?.cleared));
    await step({ id: 'J16', label: 'Refresh sau logout bị từ chối', path: '/auth/refresh', headers: { cookie: logoutUser.cookie }, expected: 401, reason: 'INVALID_TOKEN' });
    const stillValid = await step({ id: 'J17-before-exp', label: 'Access JWT cũ còn hạn sau logout vẫn dùng được', method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${logoutUser.token}` }, jwt: logoutUser.token, expected: 200 });
    addCheck(stillValid.record, 'observedBeforeExp', Date.parse(stillValid.record.startedAt) < claims.exp! * 1000);
    while (Date.now() <= claims.exp! * 1000 + 1000) {
      const remaining = Math.max(0, Math.ceil((claims.exp! * 1000 + 1000 - Date.now()) / 1000));
      console.log(`Waiting for real login JWT expiry: ${remaining}s (no clock override)`);
      await wait(Math.min(20_000, Math.max(10, claims.exp! * 1000 + 1001 - Date.now())));
    }
    const expired = await step({ id: 'J17-after-exp', label: 'Cùng access JWT bị từ chối sau exp', method: 'GET', path: '/auth/me', headers: { authorization: `Bearer ${logoutUser.token}` }, jwt: logoutUser.token, expected: 401, reason: 'JWTExpired' });
    addCheck(expired.record, 'observedAfterExp', Date.parse(expired.record.startedAt) >= claims.exp! * 1000);
    const rows = order.prepare('SELECT token_hash FROM refresh_tokens').all() as Array<{ token_hash: string }>;
    addCheck(logout.record, 'refreshStoredAsSha256Only', rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  } finally {
    await manager.stopAll(); inventory?.close(); baseline?.close(); order?.close();
  }

  mkdirSync(outputDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { node: string }; dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const installed = Object.fromEntries(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map((name) => [name,
    JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8')).version as string]));
  const sourceFiles = ['package.json', 'package-lock.json', 'src/testing/submission.ts', 'scripts/export-submission.ts', 'src/shared/signing.ts', 'src/shared/http.ts', 'src/shared/config.ts', 'src/secure/order/main.ts', 'src/secure/inventory/main.ts', 'src/supervisor/process-manager.ts'];
  const sourceSha256 = Object.fromEntries(sourceFiles.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  let commit = 'unavailable'; try { commit = execFileSync('git', ['-c', `safe.directory=${process.cwd().replace(/\\/g, '/')}`, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source hashes remain authoritative */ }
  const minimumMatch = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
  if (!minimumMatch) throw new Error('Evidence runtime check requires engines.node in >=major.minor.patch format');
  const minimum = minimumMatch.slice(1).map(Number);
  const actual = process.versions.node.split('.').map(Number);
  let runtimeMeetsDeclaredMinimum = true;
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) { runtimeMeetsDeclaredMinimum = actual[index]! > minimum[index]!; break; }
  }
  const versions = { runId, generatedAt, node: process.version, openssl: process.versions.openssl, platform: `${process.platform}-${process.arch}`,
    declaredNode: pkg.engines.node, runtimeMeetsDeclaredMinimum,
    declared: { ...pkg.dependencies, ...pkg.devDependencies }, installed, baseCommit: commit, sourceSha256 };
  const envelope = (data: unknown) => ({ runId, startedAt, generatedAt, data });
  const artifacts: Record<string, unknown> = {
    'cases.json': envelope(results),
    'negative-cases.json': envelope(results.filter((r) => r.response.status >= 400)),
    'canonical-example.json': envelope(canonical),
    'reservations.json': envelope(results.map((r) => ({ id: r.id, traceId: r.traceId, status: r.response.status, before: r.before, after: r.after }))),
    'logout-timeline.json': envelope(results.filter((r) => /^J15|^J16|^J17/.test(r.id))),
    'rotation.json': envelope({ phases: rotation, requests: results.filter((r) => r.id.startsWith('K')), scope: '3 old-key requests overlap signer switch; all owned requests drained before retire. Not a production load/zero-downtime proof.' }),
    'concurrency.json': envelope(concurrency),
    'versions.json': versions,
  };
  // Only safe, correlated fields are exported; the original process log stays gitignored.
  const artifactText: Record<string, string> = Object.fromEntries(Object.entries(artifacts).map(([name, data]) => [name, `${JSON.stringify(clean(data), null, 2)}\n`]));
  artifactText['logs.jsonl'] = logs.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  for (const [name, text] of Object.entries(artifactText)) {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) throw new Error(`Credential scan rejected ${name}`);
    for (const secret of sensitive) if (secret.length >= 8 && text.includes(secret)) throw new Error(`Credential scan rejected ${name}`);
  }
  for (const [name, text] of Object.entries(artifactText)) writeFileSync(join(outputDir, name), text);
  const passed = results.filter((r) => r.pass).length, failed = results.length - passed;
  const summary = `# Bộ evidence nộp Block 04\n\nRun: \`${runId}\`  \nTạo: ${generatedAt}  \nKết quả: **${passed}/${results.length} request checks đạt**, ${failed} thất bại.\n\n` +
    `Mỗi request có trace ID riêng, status thực, log theo đúng trace và snapshot reservation/stock. JWT lưu iat/exp và thời điểm gửi, không lưu raw token. Data/port của runner độc lập với dashboard; không sửa khóa hay reset dữ liệu demo.\n\n` +
    `Runtime thực tế: **${process.version}**, yêu cầu khai báo: **${pkg.engines.node}**. ${versions.runtimeMeetsDeclaredMinimum ? 'Runtime đáp ứng mức khai báo.' : '**Runtime chưa đáp ứng mức khai báo; kết quả này chỉ chứng minh hành vi trên runtime thực tế ghi ở đây.**'}\n\n` +
    `| Case | Tình huống | HTTP | Reservation trước → sau | Lý do log | Kết quả |\n|---|---|---:|---|---|---|\n` + results.map((r) =>
      `| ${r.id} | ${r.label} | ${r.response.status} | ${r.before.reservations} → ${r.after.reservations} | ${r.logs.filter((l) => l.reason).map((l) => l.reason + (l.claim ? ':' + l.claim : '')).join(', ') || '—'} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n') +
    `\n\n## Cách chạy lại\n\n\`npm.cmd run evidence:submission\` (không cần mở server trước). Cần dependencies, .env và khóa lab có sẵn. Runner chờ JWT login hết hạn thật (~${config.accessTtl}s), không giả lập đồng hồ. Mỗi lần chạy ghi đè bộ submission bằng một run ID mới; log và database thử nghiệm ở data/submission-* được gitignore.\n\n` +
    `## Phạm vi\n\n- canonical-example.json: canonical/body hash và HMAC/Ed25519 tính thật với timestamp đã quá hạn; không công bố secret.\n- negative-cases.json + logs.jsonl: các nhánh từ chối và lý do audit.\n- reservations.json: dữ liệu trước/sau; S04 chứng minh hai lần gửi chỉ tạo một reservation.\n- logout-timeline.json: login, logout, refresh bị từ chối, cùng access JWT trước/sau exp.\n- rotation.json: state và HTTP nội bộ thật ở từng phase, old key bị từ chối sau retire. Đây là demo overlap nhỏ, không phải chứng minh zero downtime dưới tải.\n- concurrency.json: hai request cùng nonce; hai refresh đồng thời và family revocation.\n- versions.json + manifest.json: phiên bản đang cài và hash source/artifact, không suy ra thời điểm viết Plan.\n\n` +
    `Kết quả này không bao gồm mọi kiểu lỗi mạng, restart hoặc browser-cookie test. Plan là mục tiêu thiết kế; không biến checklist chưa chạy thành PASS.\n`;
  writeFileSync(join(outputDir, 'summary.md'), summary);
  const files = [...Object.keys(artifactText), 'summary.md'];
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify({ runId, generatedAt, sourceSha256, artifacts: Object.fromEntries(files.map((name) => [name,
    { sha256: createHash('sha256').update(readFileSync(join(outputDir, name))).digest('hex'), bytes: readFileSync(join(outputDir, name)).length }])) }, null, 2) + '\n');
  return { runId, passed, total: results.length, failed, outputDir, runtimeMeetsDeclaredMinimum: versions.runtimeMeetsDeclaredMinimum };
}
