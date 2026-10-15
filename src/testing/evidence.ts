import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { config, url } from '../shared/config.js';
import {
  inventoryMetrics,
  openBaselineInventory,
  openBaselineOrder,
  openSecureInventory,
  openSecureOrder,
  resetBaselineOrder,
  resetInventory,
  resetSecureOrder,
} from '../shared/database.js';
import { jsonFetch } from '../shared/http.js';
import { createSignature, loadPrivateKey, signatureHeaders, type SigningAlgorithm } from '../shared/signing.js';

export interface EvidenceExchange {
  sequence: number;
  label: string;
  note?: string;
  actors: {
    request: { from: string; to: string };
    response: { from: string; to: string };
  };
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response: { status: number; body: unknown };
  expectedStatus: number;
  pass: boolean;
}

export interface EvidenceResult {
  id: string;
  flow: 'baseline' | 'signing' | 'session';
  objective: string;
  expected: number | number[];
  actual: number | number[];
  pass: boolean;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number | number[];
    body: unknown;
  };
  actors: {
    request: { from: string; to: string };
    response: { from: string; to: string };
  };
  durationMs: number;
  completedAt: string;
  before?: unknown;
  after?: unknown;
  detail?: unknown;
  exchanges?: EvidenceExchange[];
}

export type EvidenceFlow = EvidenceResult['flow'];
export const evidenceCaseFlows = {
  B03: 'baseline', B04: 'baseline',
  S01: 'signing', S04: 'signing',
  J04: 'session', J01: 'session', J10: 'session', J11: 'session', J12: 'session', J13: 'session',
} as const satisfies Record<string, EvidenceFlow>;
export type EvidenceCaseId = keyof typeof evidenceCaseFlows;
const evidenceActors: Record<EvidenceCaseId, EvidenceResult['actors']> = {
  B03: { request: { from: 'External caller', to: 'Inventory v1' }, response: { from: 'Inventory v1', to: 'External caller' } },
  B04: { request: { from: 'Client', to: 'Order v1' }, response: { from: 'Order v1', to: 'Client' } },
  S01: { request: { from: 'External caller', to: 'Inventory v2' }, response: { from: 'Inventory v2', to: 'External caller' } },
  S04: { request: { from: 'External caller', to: 'Inventory v2' }, response: { from: 'Inventory v2', to: 'External caller' } },
  J04: { request: { from: 'Client', to: 'Order v2' }, response: { from: 'Order v2', to: 'Client' } },
  J01: { request: { from: 'Browser', to: 'Order v2 /auth/login' }, response: { from: 'Order v2', to: 'Browser' } },
  J10: { request: { from: 'Client', to: 'Order v2' }, response: { from: 'Order v2', to: 'Client' } },
  J11: { request: { from: 'Browser', to: 'Order v2 /auth/refresh' }, response: { from: 'Order v2', to: 'Browser' } },
  J12: { request: { from: 'Browser', to: 'Order v2 /auth/refresh' }, response: { from: 'Order v2', to: 'Browser' } },
  J13: { request: { from: 'Browser', to: 'Order v2 /auth/refresh' }, response: { from: 'Order v2', to: 'Browser' } },
};

export interface EvidenceRunEvent {
  type: 'suite-start' | 'case-start' | 'case-complete' | 'suite-complete';
  total: number;
  completed: number;
  caseId?: string;
  flow?: EvidenceResult['flow'];
  objective?: string;
  result?: EvidenceResult;
  at: string;
}

export interface EvidenceRunOptions {
  onEvent?: (event: EvidenceRunEvent) => void;
  stepDelayMs?: number;
  flows?: EvidenceFlow[];
  caseIds?: EvidenceCaseId[];
  signing?: { algorithm: SigningAlgorithm; kid?: 'ed-1' | 'ed-2' };
}

const resetFixture = () => {
  const baselineInventory = openBaselineInventory();
  const baselineOrder = openBaselineOrder();
  const secureInventory = openSecureInventory();
  const secureOrder = openSecureOrder();
  resetInventory(baselineInventory, false);
  resetBaselineOrder(baselineOrder);
  resetInventory(secureInventory, true);
  resetSecureOrder(secureOrder);
  baselineInventory.close();
  baselineOrder.close();
  secureInventory.close();
  secureOrder.close();
};

const cookiePair = (headers: Headers): string => {
  const setCookie = typeof headers.getSetCookie === 'function' ? headers.getSetCookie()[0] : headers.get('set-cookie');
  return setCookie?.split(';', 1)[0] ?? '';
};

const metrics = async (port: number) => (await jsonFetch<unknown>(url(port, '/internal/metrics'))).body;

export const runEvidenceSuite = async (options: EvidenceRunOptions = {}): Promise<{ generatedAt: string; results: EvidenceResult[] }> => {
  resetFixture();
  const results: EvidenceResult[] = [];
  const orderInput = { sku: 'SKU-001', quantity: 2 };
  const signing = options.signing ?? { algorithm: 'hmac-sha256' as const };
  const selectedFlows = new Set<EvidenceFlow>(options.flows ?? ['baseline', 'signing', 'session']);
  const selectedCaseIds = new Set<EvidenceCaseId>(options.caseIds
    ?? (Object.keys(evidenceCaseFlows) as EvidenceCaseId[]).filter((caseId) => selectedFlows.has(evidenceCaseFlows[caseId])));
  const total = selectedCaseIds.size;
  const emit = (event: Omit<EvidenceRunEvent, 'at' | 'total'>) => options.onEvent?.({ ...event, total, at: new Date().toISOString() });
  const begin = (id: string, flow: EvidenceResult['flow'], objective: string) => {
    emit({ type: 'case-start', completed: results.length, caseId: id, flow, objective });
    return Date.now();
  };
  const complete = async (startedAt: number, result: Omit<EvidenceResult, 'durationMs' | 'completedAt' | 'actors'>) => {
    const completedResult: EvidenceResult = {
      ...result,
      actors: evidenceActors[result.id as EvidenceCaseId],
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
    results.push(completedResult);
    emit({
      type: 'case-complete',
      completed: results.length,
      caseId: completedResult.id,
      flow: completedResult.flow,
      objective: completedResult.objective,
      result: completedResult,
    });
    if (options.stepDelayMs) await new Promise((resolvePromise) => setTimeout(resolvePromise, options.stepDelayMs));
  };

  emit({ type: 'suite-start', completed: 0 });

  if (selectedCaseIds.has('B03')) {
  const b03Objective = 'Direct baseline inventory call without signature mutates stock';
  const b03Started = begin('B03', 'baseline', b03Objective);
  const baselineBefore = await metrics(config.ports.baselineInventory);
  const b03Body = { ...orderInput, orderId: 'evidence-b03' };
  const directBaseline = await jsonFetch(url(config.ports.baselineInventory, '/internal/reservations'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-B03' },
    body: JSON.stringify(b03Body),
  });
  const baselineAfter = await metrics(config.ports.baselineInventory);
  await complete(b03Started, {
    id: 'B03', flow: 'baseline', objective: b03Objective,
    expected: 201, actual: directBaseline.status, pass: directBaseline.status === 201,
    request: {
      method: 'POST', url: url(config.ports.baselineInventory, '/internal/reservations'),
      headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-B03' }, body: b03Body,
    },
    response: { status: directBaseline.status, body: directBaseline.body },
    before: baselineBefore, after: baselineAfter,
  });
  }

  if (selectedCaseIds.has('S01')) {
  const s01Objective = 'Secure inventory rejects a missing signature without mutation';
  const s01Started = begin('S01', 'signing', s01Objective);
  const secureBefore = await metrics(config.ports.secureInventory);
  const s01Body = { ...orderInput, orderId: 'evidence-s01' };
  const unsignedSecure = await jsonFetch(url(config.ports.secureInventory, '/internal/reservations'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-S01' },
    body: JSON.stringify(s01Body),
  });
  const secureAfter = await metrics(config.ports.secureInventory);
  await complete(s01Started, {
    id: 'S01', flow: 'signing', objective: s01Objective,
    expected: 401, actual: unsignedSecure.status, pass: unsignedSecure.status === 401,
    request: {
      method: 'POST', url: url(config.ports.secureInventory, '/internal/reservations'),
      headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-S01' }, body: s01Body,
    },
    response: { status: unsignedSecure.status, body: unsignedSecure.body },
    before: secureBefore, after: secureAfter,
  });
  }

  if (selectedCaseIds.has('S04')) {
  const s04Objective = 'An accepted signed request can only consume its nonce once';
  const s04Started = begin('S04', 'signing', s04Objective);
  const replayBody = { ...orderInput, orderId: 'evidence-s04' };
  const signingKid = signing.algorithm === 'ed25519' ? (signing.kid ?? 'ed-1') : 'hmac-lab-1';
  const signingKey = signing.algorithm === 'ed25519'
    ? loadPrivateKey(config.privateKeyPath(signingKid as 'ed-1' | 'ed-2'))
    : config.hmacSecret();
  const signature = createSignature(replayBody, signing.algorithm, signingKid, signingKey);
  const replayRequest = () => jsonFetch(url(config.ports.secureInventory, '/internal/reservations'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-S04', ...signatureHeaders(signature) },
    body: JSON.stringify(replayBody),
  });
  const replayFirst = await replayRequest();
  const replaySecond = await replayRequest();
  const replayDisplayRequest = {
    method: 'POST', url: url(config.ports.secureInventory, '/internal/reservations'),
    headers: {
      'content-type': 'application/json', 'x-trace-id': 'evidence-S04',
      'x-signature-alg': signature.algorithm, 'x-key-id': signature.kid,
      'x-timestamp': signature.timestamp, 'x-nonce': signature.nonce, 'x-signature': '[REDACTED]',
    },
    body: replayBody,
  };
  await complete(s04Started, {
    id: 'S04', flow: 'signing', objective: s04Objective,
    expected: [201, 401], actual: [replayFirst.status, replaySecond.status],
    pass: replayFirst.status === 201 && replaySecond.status === 401,
    request: {
      method: 'POST × 2', url: url(config.ports.secureInventory, '/internal/reservations'),
      headers: {
        'content-type': 'application/json', 'x-trace-id': 'evidence-S04',
        'x-signature-alg': signature.algorithm, 'x-key-id': signature.kid,
        'x-timestamp': signature.timestamp, 'x-nonce': signature.nonce, 'x-signature': '[REDACTED]',
      },
      body: replayBody,
    },
    response: {
      status: [replayFirst.status, replaySecond.status],
      body: [{ attempt: 1, body: replayFirst.body }, { attempt: 2, body: replaySecond.body }],
    },
    exchanges: [
      {
        sequence: 1, label: 'Gửi request có chữ ký hợp lệ',
        note: 'Nonce được sử dụng lần đầu nên Inventory phải chấp nhận.',
        actors: evidenceActors.S04, request: replayDisplayRequest,
        response: { status: replayFirst.status, body: replayFirst.body },
        expectedStatus: 201, pass: replayFirst.status === 201,
      },
      {
        sequence: 2, label: 'Gửi lại đúng request và nonce cũ',
        note: 'Đây là replay có chủ đích; HTTP 401 là kết quả mong đợi.',
        actors: evidenceActors.S04, request: replayDisplayRequest,
        response: { status: replaySecond.status, body: replaySecond.body },
        expectedStatus: 401, pass: replaySecond.status === 401,
      },
    ],
  });
  }

  if (selectedCaseIds.has('B04')) {
  const b04Objective = 'Baseline order accepts no access JWT';
  const b04Started = begin('B04', 'baseline', b04Objective);
  const baselineNoJwt = await jsonFetch(url(config.ports.baselineOrder, '/orders'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-B04' }, body: JSON.stringify(orderInput),
  });
  await complete(b04Started, {
    id: 'B04', flow: 'baseline', objective: b04Objective,
    expected: 201, actual: baselineNoJwt.status, pass: baselineNoJwt.status === 201,
    request: {
      method: 'POST', url: url(config.ports.baselineOrder, '/orders'),
      headers: { 'content-type': 'application/json', authorization: '(none)', 'x-trace-id': 'evidence-B04' }, body: orderInput,
    },
    response: { status: baselineNoJwt.status, body: baselineNoJwt.body },
  });
  }

  if (selectedCaseIds.has('J04')) {
  const j04Objective = 'Secure order rejects no access JWT';
  const j04Started = begin('J04', 'session', j04Objective);
  const secureNoJwt = await jsonFetch(url(config.ports.secureOrder, '/orders'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-J04' }, body: JSON.stringify(orderInput),
  });
  await complete(j04Started, {
    id: 'J04', flow: 'session', objective: j04Objective,
    expected: 401, actual: secureNoJwt.status, pass: secureNoJwt.status === 401,
    request: {
      method: 'POST', url: url(config.ports.secureOrder, '/orders'),
      headers: { 'content-type': 'application/json', authorization: '(none)', 'x-trace-id': 'evidence-J04' }, body: orderInput,
    },
    response: { status: secureNoJwt.status, body: secureNoJwt.body },
  });
  }

  if (['J01', 'J10', 'J11', 'J12', 'J13'].some((caseId) => selectedCaseIds.has(caseId as EvidenceCaseId))) {
  const j01Objective = 'Login returns a 120-second access JWT and an HttpOnly refresh cookie';
  const j01Started = selectedCaseIds.has('J01') ? begin('J01', 'session', j01Objective) : null;
  const login = await jsonFetch<{ accessToken?: string; expiresIn?: number }>(url(config.ports.secureOrder, '/auth/login'), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-J01' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  const refreshA = cookiePair(login.headers);
  const claims = login.body.accessToken ? decodeJwt(login.body.accessToken) : {};
  const ttl = typeof claims.exp === 'number' && typeof claims.iat === 'number' ? claims.exp - claims.iat : 0;
  const loginRequest = {
    method: 'POST', url: url(config.ports.secureOrder, '/auth/login'),
    headers: { 'content-type': 'application/json', 'x-trace-id': 'evidence-J01' },
    body: { username: config.username, password: '[REDACTED]' },
  };
  const loginResponse = {
    status: login.status,
    body: { accessToken: '[REDACTED]', tokenType: 'Bearer', expiresIn: login.body.expiresIn, setCookie: 'refresh_token=[TOKEN A]; HttpOnly' },
  };
  const loginExchange: EvidenceExchange = {
    sequence: 1, label: 'Đăng nhập để lấy access JWT và refresh token A',
    actors: evidenceActors.J01, request: loginRequest, response: loginResponse,
    expectedStatus: 200, pass: login.status === 200 && refreshA.startsWith('refresh_token='),
  };
  if (j01Started !== null) await complete(j01Started, {
    id: 'J01', flow: 'session', objective: j01Objective,
    expected: 200, actual: login.status,
    pass: login.status === 200 && ttl === 120 && refreshA.startsWith('refresh_token='),
    request: loginRequest,
    response: loginResponse,
    detail: { issuer: claims.iss, audience: claims.aud, ttlSeconds: ttl, accessToken: '[REDACTED]', refreshToken: 'token A' },
  });

  if (selectedCaseIds.has('J10')) {
  const j10Objective = 'A valid access JWT reaches a service-signed inventory reservation';
  const j10Started = begin('J10', 'session', j10Objective);
  const secureOrder = await jsonFetch(url(config.ports.secureOrder, '/orders'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.body.accessToken ?? ''}`, 'x-trace-id': 'evidence-J10' },
    body: JSON.stringify(orderInput),
  });
  const secureOrderBody = secureOrder.body as { orderId?: string; reservationId?: string };
  const orderRequest = {
    method: 'POST', url: url(config.ports.secureOrder, '/orders'),
    headers: { 'content-type': 'application/json', authorization: 'Bearer [REDACTED]', 'x-trace-id': 'evidence-J10' }, body: orderInput,
  };
  await complete(j10Started, {
    id: 'J10', flow: 'session', objective: j10Objective,
    expected: 201, actual: secureOrder.status, pass: secureOrder.status === 201,
    request: orderRequest,
    response: { status: secureOrder.status, body: secureOrder.body },
    exchanges: [
      loginExchange,
      {
        sequence: 2, label: 'Gửi access JWT để tạo order',
        actors: evidenceActors.J10, request: orderRequest,
        response: { status: secureOrder.status, body: secureOrder.body },
        expectedStatus: 201, pass: secureOrder.status === 201,
      },
      {
        sequence: 3, label: 'Order v2 ký request xuống Inventory v2',
        note: 'Hop nội bộ được tổng hợp từ kết quả Order v2; dữ liệu chữ ký nhạy cảm được ẩn.',
        actors: {
          request: { from: 'Order v2', to: 'Inventory v2' },
          response: { from: 'Inventory v2', to: 'Order v2' },
        },
        request: {
          method: 'POST', url: url(config.ports.secureInventory, '/internal/reservations'),
          headers: {
            'content-type': 'application/json',
            'x-signature-alg': signing.algorithm,
            'x-key-id': signing.algorithm === 'ed25519' ? (signing.kid ?? 'ed-1') : 'hmac-lab-1',
            'x-signature': '[REDACTED]',
          },
          body: { ...orderInput, orderId: secureOrderBody.orderId ?? '[GENERATED]' },
        },
        response: { status: secureOrder.status === 201 ? 201 : secureOrder.status, body: { reservationId: secureOrderBody.reservationId } },
        expectedStatus: 201, pass: secureOrder.status === 201 && Boolean(secureOrderBody.reservationId),
      },
    ],
    detail: {
      downstreamRequest: {
        from: 'Order v2', to: 'Inventory v2', method: 'POST', path: '/internal/reservations',
        algorithm: signing.algorithm,
        kid: signing.algorithm === 'ed25519' ? (signing.kid ?? 'ed-1') : 'hmac-lab-1',
        signature: '[REDACTED]',
      },
    },
  });
  }

  if (['J11', 'J12', 'J13'].some((caseId) => selectedCaseIds.has(caseId as EvidenceCaseId))) {
  const j11Objective = 'Refresh A rotates to refresh B';
  const j11Started = selectedCaseIds.has('J11') ? begin('J11', 'session', j11Objective) : null;
  const refresh = await jsonFetch(url(config.ports.secureOrder, '/auth/refresh'), {
    method: 'POST', headers: { cookie: refreshA, 'x-trace-id': 'evidence-J11' },
  });
  const refreshB = cookiePair(refresh.headers);
  const refreshRequest = {
    method: 'POST', url: url(config.ports.secureOrder, '/auth/refresh'),
    headers: { cookie: 'refresh_token=[TOKEN A]', 'x-trace-id': 'evidence-J11' },
  };
  const refreshResponse = { status: refresh.status, body: { accessToken: '[REDACTED]', setCookie: 'refresh_token=[TOKEN B]; HttpOnly' } };
  const refreshExchange: EvidenceExchange = {
    sequence: 2, label: 'Dùng token A để rotate sang token B',
    actors: evidenceActors.J11, request: refreshRequest, response: refreshResponse,
    expectedStatus: 200, pass: refresh.status === 200 && refreshB !== refreshA,
  };
  if (j11Started !== null) await complete(j11Started, {
    id: 'J11', flow: 'session', objective: j11Objective,
    expected: 200, actual: refresh.status, pass: refresh.status === 200 && refreshB !== refreshA,
    request: refreshRequest,
    response: refreshResponse,
    exchanges: [loginExchange, refreshExchange],
  });

  if (selectedCaseIds.has('J12') || selectedCaseIds.has('J13')) {
  const j12Objective = 'Reusing refresh A revokes the family';
  const j12Started = selectedCaseIds.has('J12') ? begin('J12', 'session', j12Objective) : null;
  const reuseA = await jsonFetch(url(config.ports.secureOrder, '/auth/refresh'), { method: 'POST', headers: { cookie: refreshA } });
  const reuseRequest = { method: 'POST', url: url(config.ports.secureOrder, '/auth/refresh'), headers: { cookie: 'refresh_token=[REUSED TOKEN A]' } };
  const reuseResponse = { status: reuseA.status, body: reuseA.body };
  const reuseExchange: EvidenceExchange = {
    sequence: 3, label: 'Cố ý tái sử dụng token A',
    note: 'HTTP 401 là đúng: server phát hiện reuse và revoke toàn bộ token family.',
    actors: evidenceActors.J12, request: reuseRequest, response: reuseResponse,
    expectedStatus: 401, pass: reuseA.status === 401,
  };
  if (j12Started !== null) await complete(j12Started, {
    id: 'J12', flow: 'session', objective: j12Objective,
    expected: 401, actual: reuseA.status, pass: reuseA.status === 401,
    request: reuseRequest,
    response: reuseResponse,
    exchanges: [loginExchange, refreshExchange, reuseExchange],
    detail: { familyState: 'revoked' },
  });

  if (selectedCaseIds.has('J13')) {
  const j13Objective = 'Refresh B is invalid after family revocation';
  const j13Started = begin('J13', 'session', j13Objective);
  const useB = await jsonFetch(url(config.ports.secureOrder, '/auth/refresh'), { method: 'POST', headers: { cookie: refreshB } });
  const useBRequest = { method: 'POST', url: url(config.ports.secureOrder, '/auth/refresh'), headers: { cookie: 'refresh_token=[TOKEN B]' } };
  const useBResponse = { status: useB.status, body: useB.body };
  await complete(j13Started, {
    id: 'J13', flow: 'session', objective: j13Objective,
    expected: 401, actual: useB.status, pass: useB.status === 401,
    request: useBRequest,
    response: useBResponse,
    exchanges: [
      loginExchange,
      refreshExchange,
      reuseExchange,
      {
        sequence: 4, label: 'Thử dùng token B sau khi family bị revoke',
        note: 'Token B từng hợp lệ nhưng phải bị từ chối vì token family đã bị thu hồi ở lần 3.',
        actors: evidenceActors.J13, request: useBRequest, response: useBResponse,
        expectedStatus: 401, pass: useB.status === 401,
      },
    ],
    detail: { familyState: 'revoked by J12' },
  });
  }
  }
  }
  }

  const generatedAt = new Date().toISOString();
  emit({ type: 'suite-complete', completed: results.length });
  return { generatedAt, results };
};

export const writeEvidence = (evidence: Awaited<ReturnType<typeof runEvidenceSuite>>) => {
  mkdirSync(config.evidenceDir, { recursive: true });
  const normalizedEvidence = {
    ...evidence,
    results: evidence.results.map((result) => ({
      ...result,
      actors: result.actors ?? evidenceActors[result.id as EvidenceCaseId],
    })),
  };
  writeFileSync(join(config.evidenceDir, 'smoke-results.json'), `${JSON.stringify(normalizedEvidence, null, 2)}\n`);
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  writeFileSync(join(config.evidenceDir, 'versions.json'), `${JSON.stringify({
    generatedAt: normalizedEvidence.generatedAt,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
  }, null, 2)}\n`);
  const passed = normalizedEvidence.results.filter((result) => result.pass).length;
  const rows = normalizedEvidence.results.map((result) => {
    const actors = result.actors ?? evidenceActors[result.id as EvidenceCaseId];
    return `| ${result.id} | ${actors.request.from} → ${actors.request.to} | ${actors.response.from} → ${actors.response.to} | ${result.objective} | ${JSON.stringify(result.expected)} | ${JSON.stringify(result.actual)} | ${result.pass ? 'PASS' : 'FAIL'} |`;
  }).join('\n');
  writeFileSync(join(config.evidenceDir, 'summary.md'), `# Block 04 evidence summary\n\nGenerated: ${normalizedEvidence.generatedAt}\n\nPassed: ${passed}/${normalizedEvidence.results.length}\n\n| ID | Request sender → receiver | Response sender → receiver | Objective | Expected | Actual | Result |\n|---|---|---|---|---:|---:|---|\n${rows}\n`);
};
