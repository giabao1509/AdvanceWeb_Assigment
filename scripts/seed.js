// Seed tất định cho 3 DB và ảnh thumbnail local (decisions.md mục 3.2).
// Chạy: npm run seed
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { DATA_DIR, ROOT } from '../shared/config.js';

const IMG_DIR = path.join(ROOT, 'client', 'img');

const EXPECTED = {
  u_small: { N: 10, M: 19, K: 6 },
  u_large: { N: 200, M: 399, K: 30 },
};

// ---------- PRNG tất định ----------
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

// ---------- PNG tối giản (không cần thư viện) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const stripe = (x + y) % 16 < 4; // sọc chéo để thumbnail không phải một khối màu
      const o = row + 1 + x * 4;
      raw[o] = stripe ? Math.min(255, r + 40) : r;
      raw[o + 1] = stripe ? Math.min(255, g + 40) : g;
      raw[o + 2] = stripe ? Math.min(255, b + 40) : b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

// ---------- Dữ liệu giả ----------
const KINDS = ['Bàn phím cơ', 'Chuột không dây', 'Tai nghe', 'Màn hình', 'Cáp USB-C', 'Sạc nhanh', 'Loa Bluetooth', 'Webcam', 'Ổ SSD', 'Balo laptop'];
const MODELS = ['Mini', 'Pro', 'Lite', 'Max', 'Air'];
const CATEGORIES = ['Phụ kiện', 'Âm thanh', 'Hiển thị', 'Lưu trữ', 'Túi xách'];
const STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const ADDRESSES = [
  '12 Đường Số 3, Phường 4, Quận 5, TP.HCM (địa chỉ giả)',
  '227 Nguyễn Văn Cừ, Phường 4, Quận 5, TP.HCM (địa chỉ giả)',
  '45 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM (địa chỉ giả)',
  '8 Trần Hưng Đạo, Phường 6, Quận 5, TP.HCM (địa chỉ giả)',
];
const NOTES = ['Giao giờ hành chính', 'Gọi trước khi giao', 'Để ở quầy lễ tân'];
const LOREM =
  'Mô tả chi tiết sản phẩm dùng để làm payload nội bộ nặng hơn. Không client nào hiển thị trường này, ' +
  'nên BFF và GraphQL phải cắt bỏ nó trước khi trả về cho web và mobile. ';

const pid = (i) => `p_${String(i).padStart(3, '0')}`;

const products = Array.from({ length: 50 }, (_, idx) => {
  const i = idx + 1;
  return {
    id: pid(i),
    name: `${KINDS[idx % KINDS.length]} ${MODELS[Math.floor(idx / KINDS.length)]} ${String(i).padStart(2, '0')}`,
    price: 99_000 + ((i * 37) % 40) * 25_000,
    thumbnail_url: `/img/${pid(i)}.png`,
    category: CATEGORIES[idx % CATEGORIES.length],
    description: LOREM.repeat(4).trim(),
  };
});
const priceOf = new Map(products.map((p) => [p.id, p.price]));

const users = [
  { id: 'u_small', name: 'Lê Thu Hà', email: 'thuha@example.test', avatar_url: '/img/avatar_1.png' },
  { id: 'u_large', name: 'Phạm Quốc Bảo', email: 'quocbao@example.test', avatar_url: '/img/avatar_2.png' },
  { id: 'u_noise_1', name: 'Người dùng nhiễu 1', email: 'noise1@example.test', avatar_url: '/img/avatar_3.png' },
  { id: 'u_noise_2', name: 'Người dùng nhiễu 2', email: 'noise2@example.test', avatar_url: '/img/avatar_4.png' },
  { id: 'u_noise_3', name: 'Người dùng nhiễu 3', email: 'noise3@example.test', avatar_url: '/img/avatar_5.png' },
].map((u, i) => ({ ...u, created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));

const BASE_TIME = Date.UTC(2026, 8, 30, 12, 0, 0);
let orderSeq = 0;
const orders = [];
const items = [];

// N đơn, đơn thứ i có (i % 3) + 1 dòng, dòng toàn cục thứ g dùng pool[g % K].
function makeOrders(userId, n, pool, { randomProducts = false } = {}) {
  let g = 0;
  for (let i = 0; i < n; i++) {
    const id = `o_${String(++orderSeq).padStart(5, '0')}`;
    const lines = (i % 3) + 1;
    const used = new Set();
    let total = 0;
    for (let line = 1; line <= lines; line++) {
      let productId;
      if (randomProducts) {
        do productId = pick(pool);
        while (used.has(productId));
      } else {
        productId = pool[g % pool.length];
      }
      g++;
      used.add(productId);
      const quantity = 1 + Math.floor(rng() * 3);
      total += quantity * priceOf.get(productId);
      items.push({ order_id: id, line_no: line, product_id: productId, quantity });
    }
    orders.push({
      id,
      user_id: userId,
      status: pick(STATUSES),
      total_amount: total,
      shipping_address: pick(ADDRESSES),
      note: rng() < 0.3 ? pick(NOTES) : null,
      created_at: new Date(BASE_TIME - i * 3_600_000).toISOString(),
    });
  }
}

makeOrders('u_small', 10, products.slice(0, 6).map((p) => p.id));
makeOrders('u_large', 200, products.slice(0, 30).map((p) => p.id));
for (const u of ['u_noise_1', 'u_noise_2', 'u_noise_3']) {
  makeOrders(u, 20, products.map((p) => p.id), { randomProducts: true });
}

// ---------- Ghi DB ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
function freshDb(file, ddl) {
  const full = path.join(DATA_DIR, file);
  // unlinkSync thay cho rmSync: rmSync({force}) không xoá được file trên đường dẫn có dấu ở Windows (Node 24).
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (fs.existsSync(full + suffix)) fs.unlinkSync(full + suffix);
  const db = new Database(full);
  db.exec(ddl);
  return db;
}
function insertAll(db, table, rows) {
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  db.transaction((list) => list.forEach((r) => stmt.run(r)))(rows);
}

const userDb = freshDb(
  'user.db',
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, avatar_url TEXT, created_at TEXT NOT NULL
   );`,
);
insertAll(userDb, 'users', users);
userDb.close();

const orderDb = freshDb(
  'order.db',
  `CREATE TABLE orders (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','SHIPPED','DELIVERED','CANCELLED')),
     total_amount INTEGER NOT NULL,
     shipping_address TEXT,
     note TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
   CREATE TABLE order_items (
     order_id TEXT NOT NULL REFERENCES orders(id),
     line_no INTEGER NOT NULL,
     product_id TEXT NOT NULL,
     quantity INTEGER NOT NULL CHECK (quantity > 0),
     PRIMARY KEY (order_id, line_no)
   );`,
);
insertAll(orderDb, 'orders', orders);
insertAll(orderDb, 'order_items', items);

const productDb = freshDb(
  'product.db',
  `CREATE TABLE products (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
     thumbnail_url TEXT NOT NULL, category TEXT, description TEXT
   );`,
);
insertAll(productDb, 'products', products);
productDb.close();

// ---------- Ảnh ----------
fs.mkdirSync(IMG_DIR, { recursive: true });
products.forEach((p, idx) => fs.writeFileSync(path.join(IMG_DIR, `${p.id}.png`), makePng(48, hsl((idx * 47) % 360, 0.55, 0.5))));
for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(IMG_DIR, `avatar_${i}.png`), makePng(64, hsl(i * 70, 0.35, 0.45)));

// ---------- Kiểm tra N, M, K ----------
const meta = { seed: 42, users: {} };
let ok = true;
for (const userId of Object.keys(EXPECTED)) {
  const N = orderDb.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(userId).n;
  const row = orderDb
    .prepare(
      `SELECT COUNT(*) AS m, COUNT(DISTINCT product_id) AS k
         FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)`,
    )
    .get(userId);
  const actual = { N, M: row.m, K: row.k };
  meta.users[userId] = actual;
  const match = JSON.stringify(actual) === JSON.stringify(EXPECTED[userId]);
  ok &&= match;
  console.log(`${userId}: N=${actual.N} M=${actual.M} K=${actual.K} ${match ? 'OK' : `LỆCH (kỳ vọng ${JSON.stringify(EXPECTED[userId])})`}`);
}
orderDb.close();
fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

console.log(`users=${users.length} orders=${orders.length} order_items=${items.length} products=${products.length}`);
if (!ok) {
  console.error('Seed không khớp decisions.md mục 3.2, dừng.');
  process.exit(1);
}
