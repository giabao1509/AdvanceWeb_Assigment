// Baseline B1: browser gọi tuần tự User -> Order -> Product batch rồi tự ghép.
import { URLS, fetchJson, withRid } from './http.js';

const enc = encodeURIComponent;
const BATCH_LIMIT = 100;

export async function loadWeb(userId, rid) {
  const raw = [];
  const user = await fetchJson(withRid(`${URLS.user}/users/${enc(userId)}`, rid), raw);
  const orders = await fetchJson(withRid(`${URLS.order}/users/${enc(userId)}/orders`, rid), raw);

  const ids = [...new Set(orders.flatMap((o) => o.items.map((it) => it.productId)))];
  const products = new Map();
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const part = ids.slice(i, i + BATCH_LIMIT);
    try {
      const body = await fetchJson(withRid(`${URLS.product}/products?ids=${part.map(enc).join(',')}`, rid), raw);
      for (const p of body.items) products.set(p.id, { product: p });
      for (const id of body.notFound) products.set(id, { code: 'PRODUCT_NOT_FOUND' });
    } catch {
      for (const id of part) products.set(id, { code: 'PRODUCT_UNAVAILABLE' });
    }
  }

  const errors = [];
  const model = {
    user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
    orders: orders.map((o, i) => ({
      id: o.id,
      status: o.status,
      totalAmount: o.totalAmount,
      shippingAddress: o.shippingAddress,
      note: o.note,
      createdAt: o.createdAt,
      items: o.items.map((it, j) => {
        const r = products.get(it.productId);
        if (!r?.product) {
          const code = r?.code ?? 'PRODUCT_UNAVAILABLE';
          errors.push({ message: code, path: ['orders', i, 'items', j, 'product'], extensions: { code } });
          return { lineNo: it.lineNo, quantity: it.quantity, product: null };
        }
        const { id, name, price, thumbnailUrl } = r.product;
        return { lineNo: it.lineNo, quantity: it.quantity, product: { id, name, price, thumbnailUrl } };
      }),
    })),
  };
  return { model, errors, raw };
}
