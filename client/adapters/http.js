// fetch dùng chung cho các adapter phía browser. Không gửi custom header để tránh CORS preflight.
export const URLS = {
  user: 'http://localhost:4001',
  order: 'http://localhost:4002',
  product: 'http://localhost:4003',
  bff: 'http://localhost:4010',
  graphql: 'http://localhost:4020',
};

export class ScreenError extends Error {
  constructor(code, message, httpStatus = null) {
    super(message || code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const withRid = (url, rid) => `${url}${url.includes('?') ? '&' : '?'}rid=${encodeURIComponent(rid)}`;

// raw: mảng ghi lại mọi response để verify.js kiểm tra đúng những gì client nhận.
export async function fetchJson(url, raw, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ScreenError('NETWORK_ERROR', err.message);
  }
  const body = await res.json().catch(() => null);
  raw.push({ url, status: res.status, partial: res.headers.get('X-Partial-Response') === 'true', body });
  if (!res.ok) throw new ScreenError(body?.error?.code || `HTTP_${res.status}`, body?.error?.message, res.status);
  return body;
}
