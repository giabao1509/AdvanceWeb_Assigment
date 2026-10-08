// Order Service :4002 (decisions.md mục 4.3). Đúng 2 DB query mỗi request (1 nếu user không có đơn).
import { openDb, placeholders } from '../../shared/db.js';
import { createApp, listen } from '../../shared/server.js';

const app = createApp('order');
const db = openDb('order.db');

const ordersOfUser = db.prepare(
  `SELECT id, user_id AS userId, status, total_amount AS totalAmount,
          shipping_address AS shippingAddress, note, created_at AS createdAt
     FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
);

app.get('/users/:userId/orders', (req, res) => {
  const orders = ordersOfUser.all(req.params.userId);
  if (orders.length === 0) return res.json([]);

  // Lấy items của mọi đơn trong 1 query, tránh N+1 ngay trong Order Service.
  const ids = orders.map((o) => o.id);
  const rows = db
    .prepare(
      `SELECT order_id AS orderId, line_no AS lineNo, product_id AS productId, quantity
         FROM order_items WHERE order_id IN (${placeholders(ids.length)})
        ORDER BY order_id, line_no`,
    )
    .all(...ids);

  const byOrder = new Map(ids.map((id) => [id, []]));
  for (const { orderId, ...item } of rows) byOrder.get(orderId).push(item);
  res.json(orders.map((o) => ({ ...o, items: byOrder.get(o.id) })));
});

listen(app, 'order');
