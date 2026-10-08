// HTTP client cho composer (BFF/GraphQL): timeout, chuyển tiếp rid, log http-out (D16, D20).
import { UPSTREAM_TIMEOUT_MS, URLS } from './config.js';
import { currentRid, log, now } from './context.js';
import { UpstreamError } from './errors.js';

// Trả về { status, body } với mọi HTTP status. Ném UpstreamError khi timeout hoặc lỗi kết nối.
export async function getJson(target, pathname) {
  const start = now();
  let status = null;
  let timedOut = false;
  try {
    const res = await fetch(URLS[target] + pathname, {
      headers: { 'X-Request-Id': currentRid() ?? '', Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    status = res.status;
    const body = await res.json().catch(() => null);
    return { status, body };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      timedOut = true;
      throw new UpstreamError(target, 'timeout', null, `quá ${UPSTREAM_TIMEOUT_MS} ms`);
    }
    throw new UpstreamError(target, 'unavailable', null, err.cause?.code || err.message);
  } finally {
    log({
      ts: start,
      kind: 'http-out',
      target,
      method: 'GET',
      path: pathname,
      status,
      durationMs: Math.round((now() - start) * 1000) / 1000,
      timedOut,
    });
  }
}

// Như getJson nhưng coi mọi status khác 200 là lỗi 'http'.
export async function getOk(target, pathname) {
  const { status, body } = await getJson(target, pathname);
  if (status !== 200 || body == null) throw new UpstreamError(target, 'http', status);
  return body;
}
