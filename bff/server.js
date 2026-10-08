// BFF :4010: một endpoint cho mỗi loại client; Product lỗi được trả partial.
import { MESSAGES, fatalUpstream } from '../shared/errors.js';
import { createApp, listen, sendError } from '../shared/server.js';
import { fetchOrders, fetchProductsBatch, fetchUser } from '../shared/upstream.js';

const app = createApp('bff');

class FatalError extends Error {
  constructor(httpStatus, code) {
    super(MESSAGES[code] ?? code);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

// Kết quả của Promise.allSettled cho User/Order: lỗi thì thất bại toàn bộ.
function unwrap(target, settled) {
  if (settled.status === 'fulfilled') return settled.value;
  const { httpStatus, code } = fatalUpstream(target, settled.reason);
  throw new FatalError(httpStatus, code);
}

// Ghép product vào từng dòng hàng. Product lỗi: product = null và thêm một lỗi có path (P2).
async function attachProducts(orders, shapeOrder, shapeProduct) {
  const ids = [...new Set(orders.flatMap((o) => o.items.map((it) => it.productId)))];
  const products = ids.length ? await fetchProductsBatch(ids) : new Map();
  const errors = [];
  const shaped = orders.map((order, i) =>
    shapeOrder(
      order,
      order.items.map((item, j) => {
        const r = products.get(item.productId);
        if (r.product) return { item, product: shapeProduct(r.product) };
        errors.push({ message: MESSAGES[r.code], path: ['orders', i, 'items', j, 'product'], extensions: { code: r.code } });
        return { item, product: null };
      }),
    ),
  );
  return { orders: shaped, errors };
}

function send(res, body, errors) {
  if (errors.length) {
    res.set('X-Partial-Response', 'true');
    body.errors = errors; // chỉ có mặt khi có lỗi, giống GraphQL
  }
  res.json(body);
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof FatalError) return sendError(res, err.httpStatus, err.code, err.message);
      throw err;
    }
  };
}

// Web: User ‖ Order song song, rồi Product theo batch.
app.get(
  '/bff/web/dashboard/:userId',
  handle(async (req, res) => {
    const { userId } = req.params;
    const [u, o] = await Promise.allSettled([fetchUser(userId), fetchOrders(userId)]);
    const user = unwrap('user', u);
    if (user === null) return sendError(res, 404, 'USER_NOT_FOUND', MESSAGES.USER_NOT_FOUND);
    const rawOrders = unwrap('order', o);

    const { orders, errors } = await attachProducts(
      rawOrders,
      (order, lines) => ({
        id: order.id,
        status: order.status,
        totalAmount: order.totalAmount,
        shippingAddress: order.shippingAddress,
        note: order.note,
        createdAt: order.createdAt,
        items: lines.map(({ item, product }) => ({ lineNo: item.lineNo, quantity: item.quantity, product })),
      }),
      (p) => ({ id: p.id, name: p.name, price: p.price, thumbnailUrl: p.thumbnailUrl }),
    );

    const { id, name, email, avatarUrl } = user;
    send(res, { user: { id, name, email, avatarUrl }, orders }, errors);
  }),
);

// Mobile: không gọi User Service, chỉ trả các trường mobile cần.
app.get(
  '/bff/mobile/orders/:userId',
  handle(async (req, res) => {
    const [o] = await Promise.allSettled([fetchOrders(req.params.userId)]);
    const rawOrders = unwrap('order', o);

    const { orders, errors } = await attachProducts(
      rawOrders,
      (order, lines) => ({ id: order.id, status: order.status, items: lines.map(({ product }) => ({ product })) }),
      (p) => ({ name: p.name, thumbnailUrl: p.thumbnailUrl }),
    );
    send(res, { orders }, errors);
  }),
);

listen(app, 'bff');
