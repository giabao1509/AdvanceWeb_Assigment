// Truy cập User/Order/Product từ composer. BFF và GraphQL dùng chung để hành vi lỗi giống nhau.
import { PRODUCT_BATCH_LIMIT } from './config.js';
import { UpstreamError, productErrorCode } from './errors.js';
import { getJson, getOk } from './httpClient.js';

const enc = encodeURIComponent;

// null nếu user không tồn tại. Ném UpstreamError nếu User Service lỗi.
export async function fetchUser(userId) {
  const { status, body } = await getJson('user', `/users/${enc(userId)}`);
  if (status === 404) return null;
  if (status !== 200 || body == null) throw new UpstreamError('user', 'http', status);
  return body;
}

export async function fetchOrders(userId) {
  return getOk('order', `/users/${enc(userId)}/orders`);
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ids phải đã được dedup. Trả về Map<id, { product } | { code }>.
export async function fetchProductsBatch(ids) {
  const result = new Map();
  await Promise.all(
    chunk(ids, PRODUCT_BATCH_LIMIT).map(async (part) => {
      try {
        const body = await getOk('product', `/products?ids=${part.map(enc).join(',')}`);
        const found = new Map(body.items.map((p) => [p.id, p]));
        for (const id of part) result.set(id, found.has(id) ? { product: found.get(id) } : { code: 'PRODUCT_NOT_FOUND' });
      } catch (err) {
        const code = productErrorCode(err);
        for (const id of part) result.set(id, { code });
      }
    }),
  );
  return result;
}

// Bản N+1: một call cho mỗi id. Trả về { product } | { code }.
export async function fetchProductOne(id) {
  try {
    const { status, body } = await getJson('product', `/products/${enc(id)}`);
    if (status === 404) return { code: 'PRODUCT_NOT_FOUND' };
    if (status !== 200 || body == null) throw new UpstreamError('product', 'http', status);
    return { product: body };
  } catch (err) {
    return { code: productErrorCode(err) };
  }
}
