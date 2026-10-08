// Product Service :4003, gồm batch API và fault injection phục vụ kiểm thử.
import express from 'express';
import { PRODUCT_BATCH_LIMIT } from '../../shared/config.js';
import { log } from '../../shared/context.js';
import { openDb, placeholders } from '../../shared/db.js';
import { createApp, listen, sendError } from '../../shared/server.js';

const app = createApp('product');
const db = openDb('product.db');

const COLS = 'id, name, price, thumbnail_url AS thumbnailUrl, category, description';
const byId = db.prepare(`SELECT ${COLS} FROM products WHERE id = ?`);

// ---------- Fault injection: chỉ bật khi ENABLE_FAULT=1 ----------
const MODES = ['none', 'delay', 'error', 'hang'];
let fault = { mode: 'none', delayMs: 0 };

if (process.env.ENABLE_FAULT === '1') {
  app.get('/__fault', (req, res) => res.json(fault));
  app.post('/__fault', express.json(), (req, res) => {
    const { mode = 'none', delayMs = 0 } = req.body ?? {};
    if (!MODES.includes(mode)) return sendError(res, 400, 'INVALID_FAULT', `mode phải là ${MODES.join('|')}`);
    fault = { mode, delayMs: Number(delayMs) || 0 };
    console.log(`[product] fault = ${JSON.stringify(fault)}`);
    res.json(fault);
  });
}

app.use('/products', async (req, res, next) => {
  if (fault.mode === 'none') return next();
  let closed = false;
  res.on('close', () => (closed = true));
  log({ kind: 'fault', mode: fault.mode, delayMs: fault.delayMs });

  if (fault.mode === 'error') return sendError(res, 500, 'INJECTED_FAULT', 'Lỗi giả lập từ /__fault');
  if (fault.mode === 'hang') return; // không bao giờ trả lời, bên gọi phải tự timeout

  await new Promise((r) => setTimeout(r, fault.delayMs));
  if (closed) return; // bên gọi đã bỏ cuộc (timeout), không truy vấn DB nữa
  next();
});

// ---------- Routes ----------
app.get('/products', (req, res) => {
  const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return sendError(res, 400, 'INVALID_IDS', 'Cần ?ids=p_001,p_002');
  if (ids.length > PRODUCT_BATCH_LIMIT) {
    return sendError(res, 400, 'TOO_MANY_IDS', `Tối đa ${PRODUCT_BATCH_LIMIT} id mỗi request, nhận ${ids.length}`);
  }
  // 1 query cho cả batch. Không dedup ở đây: dedup là việc của bên gọi (D10).
  const items = db.prepare(`SELECT ${COLS} FROM products WHERE id IN (${placeholders(ids.length)})`).all(...ids);
  const found = new Set(items.map((p) => p.id));
  res.json({ items, notFound: [...new Set(ids.filter((id) => !found.has(id)))] });
});

app.get('/products/:id', (req, res) => {
  const product = byId.get(req.params.id);
  if (!product) return sendError(res, 404, 'PRODUCT_NOT_FOUND', `Không có product ${req.params.id}`);
  res.json(product);
});

listen(app, 'product');
