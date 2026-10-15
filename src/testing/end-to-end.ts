import { randomUUID } from 'node:crypto';
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
import type { WorkerHttpExchange } from '../shared/process-messages.js';
import { createSignature, loadPrivateKey, signatureHeaders, type SigningAlgorithm } from '../shared/signing.js';

export type EndToEndFlowId = 'baseline-e2e' | 'secure-e2e';
export type EndToEndCaseId =
  | 'baseline-order-success' | 'baseline-stock-low'
  | 'secure-order-success' | 'secure-no-jwt' | 'secure-invalid-jwt' | 'secure-stock-low' | 'secure-refresh';

export interface EndToEndExchange {
  sequence: number;
  label: string;
  note?: string;
  actors: { request: { from: string; to: string }; response: { from: string; to: string } };
  request: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; body: unknown };
  expectedStatus: number;
  pass: boolean;
  children?: EndToEndExchange[];
}

export interface EndToEndResult {
  runId: string;
  flowId: EndToEndFlowId;
  caseId: EndToEndCaseId;
  label: string;
  objective: string;
  signing: { algorithm: SigningAlgorithm; kid: string } | null;
  expected: number;
  actual: number;
  pass: boolean;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  before: unknown;
  after: unknown;
  exchanges: EndToEndExchange[];
}

const cases: Record<EndToEndCaseId, { flowId: EndToEndFlowId; label: string; objective: string }> = {
  'baseline-order-success': { flowId: 'baseline-e2e', label: 'Đặt hàng thành công, không cần đăng nhập', objective: 'Order v1 gọi Inventory v1 và tạo reservation không cần JWT hay chữ ký service.' },
  'baseline-stock-low': { flowId: 'baseline-e2e', label: 'Đặt hàng vượt quá tồn kho', objective: 'Inventory v1 trả lỗi hết hàng và không tạo reservation.' },
  'secure-order-success': { flowId: 'secure-e2e', label: 'Đăng nhập và đặt hàng bảo mật', objective: 'JWT bảo vệ Client → Order; HMAC/Ed25519 bảo vệ Order → Inventory.' },
  'secure-no-jwt': { flowId: 'secure-e2e', label: 'Thiếu access token', objective: 'Order v2 phải từ chối request khi không có JWT và không gọi Inventory.' },
  'secure-invalid-jwt': { flowId: 'secure-e2e', label: 'Access token không hợp lệ', objective: 'Order v2 phải từ chối JWT giả trước khi gọi Inventory.' },
  'secure-stock-low': { flowId: 'secure-e2e', label: 'Có JWT nhưng kho không đủ hàng', objective: 'JWT và chữ ký nội bộ hợp lệ nhưng nghiệp vụ trả hết hàng, không tạo reservation.' },
  'secure-refresh': { flowId: 'secure-e2e', label: 'Đăng nhập rồi đổi refresh token A → B', objective: 'Login phát token A; refresh hợp lệ xoay sang token B.' },
};

export const endToEndCases = Object.entries(cases).map(([id, value]) => ({ id, ...value }));

const cookiePair = (headers: Headers): string => {
  const setCookie = typeof headers.getSetCookie === 'function' ? headers.getSetCookie()[0] : headers.get('set-cookie');
  return setCookie?.split(';', 1)[0] ?? '';
};

const resetFixtures = () => {
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

const stateSnapshot = (flowId: EndToEndFlowId) => {
  const inventory = flowId === 'baseline-e2e' ? openBaselineInventory() : openSecureInventory();
  const order = flowId === 'baseline-e2e' ? openBaselineOrder() : openSecureOrder();
  try {
    return {
      inventory: inventoryMetrics(inventory),
      orders: (order.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count,
    };
  } finally {
    inventory.close();
    order.close();
  }
};

const exchange = (args: Omit<EndToEndExchange, 'sequence'> & { sequence: number }): EndToEndExchange => args;

export const runEndToEndCase = async (args: {
  caseId: EndToEndCaseId;
  signing: { algorithm: SigningAlgorithm; kid?: 'ed-1' | 'ed-2' };
  waitForInternalExchange: (traceId: string) => Promise<WorkerHttpExchange>;
}): Promise<EndToEndResult> => {
  const definition = cases[args.caseId];
  if (!definition) throw new Error('UNKNOWN_E2E_CASE');
  resetFixtures();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = randomUUID();
  const before = stateSnapshot(definition.flowId);
  const exchanges: EndToEndExchange[] = [];
  let expected = 201;
  let actual = 0;
  let operationPass = false;
  const signing = definition.flowId === 'secure-e2e'
    ? { algorithm: args.signing.algorithm, kid: args.signing.algorithm === 'hmac-sha256' ? 'hmac-lab-1' : (args.signing.kid ?? 'ed-1') }
    : null;

  if (args.caseId === 'secure-refresh') {
    const traceId = `${runId}-login`;
    const login = await jsonFetch<{ accessToken?: string; expiresIn?: number }>(url(config.ports.secureOrder, '/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': traceId },
      body: JSON.stringify({ username: config.username, password: config.password }),
    });
    const tokenA = cookiePair(login.headers);
    exchanges.push(exchange({
      sequence: 1, label: 'Đăng nhập và nhận token A',
      actors: { request: { from: 'Trình duyệt', to: 'Order v2 /auth/login' }, response: { from: 'Order v2', to: 'Trình duyệt' } },
      request: { method: 'POST', url: url(config.ports.secureOrder, '/auth/login'), headers: { 'content-type': 'application/json', 'x-trace-id': traceId }, body: { username: config.username, password: '[ĐÃ ẨN]' } },
      response: { status: login.status, body: { accessToken: login.body.accessToken ? '[ĐÃ ẨN]' : '[KHÔNG CÓ]', expiresIn: login.body.expiresIn, setCookie: tokenA ? 'refresh_token=[TOKEN A]; HttpOnly' : '[KHÔNG CÓ]' } },
      expectedStatus: 200, pass: login.status === 200 && tokenA.startsWith('refresh_token='),
    }));
    const refreshTraceId = `${runId}-refresh`;
    let refreshedStatus = login.status;
    if (login.status === 200 && tokenA) {
      const refreshed = await jsonFetch<{ accessToken?: string; expiresIn?: number }>(url(config.ports.secureOrder, '/auth/refresh'), {
        method: 'POST', headers: { cookie: tokenA, 'x-trace-id': refreshTraceId },
      });
      const tokenB = cookiePair(refreshed.headers);
      refreshedStatus = refreshed.status;
      exchanges.push(exchange({
        sequence: 2, label: 'Dùng token A để đổi sang token B',
        actors: { request: { from: 'Trình duyệt', to: 'Order v2 /auth/refresh' }, response: { from: 'Order v2', to: 'Trình duyệt' } },
        request: { method: 'POST', url: url(config.ports.secureOrder, '/auth/refresh'), headers: { cookie: 'refresh_token=[TOKEN A]', 'x-trace-id': refreshTraceId } },
        response: { status: refreshed.status, body: { accessToken: refreshed.body.accessToken ? '[ĐÃ ẨN]' : '[KHÔNG CÓ]', expiresIn: refreshed.body.expiresIn, setCookie: tokenB ? 'refresh_token=[TOKEN B]; HttpOnly' : '[KHÔNG CÓ]' } },
        expectedStatus: 200, pass: refreshed.status === 200 && Boolean(tokenB) && tokenB !== tokenA,
      }));
    }
    expected = 200;
    actual = refreshedStatus;
    operationPass = exchanges.every((item) => item.pass);
  } else {
    const secure = definition.flowId === 'secure-e2e';
    const orderPath = secure ? '/orders' : '/orders';
    const orderPort = secure ? config.ports.secureOrder : config.ports.baselineOrder;
    const quantity = 2;
    const sku = args.caseId.endsWith('stock-low') ? 'SKU-LOW' : 'SKU-001';
    const orderBody = { sku, quantity };
    const isUnauthorizedCase = args.caseId === 'secure-no-jwt' || args.caseId === 'secure-invalid-jwt';
    const needsLogin = secure && !isUnauthorizedCase;
    let accessToken: string | undefined;

    if (needsLogin) {
      const loginTrace = `${runId}-login`;
      const login = await jsonFetch<{ accessToken?: string; expiresIn?: number }>(url(config.ports.secureOrder, '/auth/login'), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': loginTrace },
        body: JSON.stringify({ username: config.username, password: config.password }),
      });
      accessToken = login.body.accessToken;
      exchanges.push(exchange({
        sequence: 1, label: 'Đăng nhập để lấy access token',
        actors: { request: { from: 'Trình duyệt', to: 'Order v2 /auth/login' }, response: { from: 'Order v2', to: 'Trình duyệt' } },
        request: { method: 'POST', url: url(config.ports.secureOrder, '/auth/login'), headers: { 'content-type': 'application/json', 'x-trace-id': loginTrace }, body: { username: config.username, password: '[ĐÃ ẨN]' } },
        response: { status: login.status, body: { accessToken: accessToken ? '[ĐÃ ẨN]' : '[KHÔNG CÓ]', tokenType: 'Bearer', expiresIn: login.body.expiresIn, setCookie: accessToken ? 'refresh_token=[ĐÃ ẨN]; HttpOnly' : '[KHÔNG CÓ]' } },
        expectedStatus: 200, pass: login.status === 200 && Boolean(accessToken),
      }));
    }

    const orderTrace = `${runId}-order`;
    const internalExchangePromise = !isUnauthorizedCase && (!secure || Boolean(accessToken))
      ? args.waitForInternalExchange(orderTrace)
      : null;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-trace-id': orderTrace };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (args.caseId === 'secure-invalid-jwt') headers.authorization = 'Bearer invalid.demo.token';
    let orderResponse: { status: number; body: Record<string, unknown>; headers: Headers };
    try {
      orderResponse = await jsonFetch<Record<string, unknown>>(url(orderPort, orderPath), {
        method: 'POST', headers, body: JSON.stringify(orderBody),
      });
    } catch (error) {
      await internalExchangePromise?.catch(() => undefined);
      throw error;
    }
    actual = orderResponse.status;
    expected = args.caseId.endsWith('stock-low') ? 409 : isUnauthorizedCase ? 401 : 201;
    const loginSequence = needsLogin ? 2 : 1;
    const outerPass = orderResponse.status === expected;
    const children: EndToEndExchange[] = [];
    if (internalExchangePromise) {
      const internal = await internalExchangePromise;
      children.push(exchange({
        sequence: 1, label: secure ? 'Order v2 ký request nội bộ' : 'Order v1 gọi Inventory không chữ ký',
        note: secure ? `Inventory xác minh ${signing?.algorithm}${signing?.kid ? ` · ${signing.kid}` : ''} trước khi giữ hàng.` : 'Baseline chấp nhận request nội bộ không có chữ ký service.',
        actors: { request: { from: secure ? 'Order v2' : 'Order v1', to: secure ? 'Inventory v2' : 'Inventory v1' }, response: { from: secure ? 'Inventory v2' : 'Inventory v1', to: secure ? 'Order v2' : 'Order v1' } },
        request: internal.request,
        response: internal.response,
        expectedStatus: expected,
        pass: internal.response.status === expected,
      }));
    }
    exchanges.push(exchange({
      sequence: loginSequence,
      label: secure ? 'Gửi đơn hàng kèm access token' : 'Gửi đơn hàng không cần đăng nhập',
      note: children.length ? 'Order chờ Inventory xử lý ở bước lồng bên dưới rồi mới trả kết quả cho client.' : undefined,
      actors: { request: { from: 'Client', to: secure ? 'Order v2 /orders' : 'Order v1 /orders' }, response: { from: secure ? 'Order v2' : 'Order v1', to: 'Client' } },
      request: { method: 'POST', url: url(orderPort, orderPath), headers: { ...headers, ...(accessToken ? { authorization: 'Bearer [ĐÃ ẨN]' } : args.caseId === 'secure-invalid-jwt' ? { authorization: 'Bearer [JWT KHÔNG HỢP LỆ]' } : { authorization: '(không gửi)' }) }, body: orderBody },
      response: { status: orderResponse.status, body: orderResponse.body },
      expectedStatus: expected, pass: outerPass, children,
    }));
    operationPass = outerPass && children.every((item) => item.pass) && exchanges.every((item) => item.pass);
  }

  const after = stateSnapshot(definition.flowId);
  const completedAt = new Date().toISOString();
  return {
    runId, flowId: definition.flowId, caseId: args.caseId, label: definition.label,
    objective: definition.objective, signing, expected, actual, pass: operationPass,
    durationMs: Date.now() - startedAtMs, startedAt, completedAt, before, after, exchanges,
  };
};

export const runRetiredSigningKeyCheck = async (): Promise<EndToEndExchange> => {
  const traceId = randomUUID();
  const body = { sku: 'SKU-001', quantity: 2, orderId: randomUUID() };
  const signature = createSignature(body, 'ed25519', 'ed-1', loadPrivateKey(config.privateKeyPath('ed-1')));
  const response = await jsonFetch<Record<string, unknown>>(url(config.ports.secureInventory, '/internal/reservations'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trace-id': traceId, ...signatureHeaders(signature) },
    body: JSON.stringify(body),
  });
  return {
    sequence: 1,
    label: 'Gửi request bằng key ed-1 đã gỡ',
    note: 'Inventory phải từ chối key cũ sau bước Retire.',
    actors: { request: { from: 'Order v2 (mô phỏng)', to: 'Inventory v2' }, response: { from: 'Inventory v2', to: 'Order v2 (mô phỏng)' } },
    request: {
      method: 'POST', url: url(config.ports.secureInventory, '/internal/reservations'),
      headers: { 'content-type': 'application/json', 'x-trace-id': traceId, 'x-signature-alg': signature.algorithm, 'x-key-id': signature.kid, 'x-timestamp': signature.timestamp, 'x-nonce': signature.nonce, 'x-signature': '[ĐÃ ẨN]' },
      body,
    },
    response: { status: response.status, body: response.body },
    expectedStatus: 401,
    pass: response.status === 401,
  };
};
