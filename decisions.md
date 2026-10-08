# Quyết định đã chốt: API composition (Block 2)

> **Trạng thái:** chốt, viết trước khi hiện thực BFF và GraphQL. Đây là phần "Plan gồm các quyết định đã chốt và policy lỗi" của bài nộp.
> **Nguồn:** các đề xuất trong `brainstorm.md`. Riêng quan hệ order–product đã đổi sang **option B (đơn có nhiều dòng)**, nên mọi phần phụ thuộc (schema, contract, N+1, số call kỳ vọng) được viết lại theo B.
> Muốn đổi một quyết định thì sửa file này, ghi ngày và lý do vào mục 10. Không sửa ngầm trong code.

Ký hiệu:

- `N` = số đơn của user
- `M` = tổng số dòng hàng (order item) của các đơn đó (`M ≥ N`)
- `K` = số product **khác nhau** trong `M` dòng (`K ≤ M`)
- `B` = số id tối đa mỗi lần gọi batch (`B = 100`)

---

## 1. Tóm tắt quyết định

| ID | Chủ đề | Quyết định |
|---|---|---|
| D01 | Stack | Node.js ≥ 20, Express, `better-sqlite3`, `graphql-yoga` + `dataloader`, Playwright. Client là HTML + JS thuần, không dùng framework |
| D02 | CSDL | SQLite, mỗi service một file: `user.db`, `order.db`, `product.db` |
| D03 | Port | User `4001`, Order `4002`, Product `4003`, BFF `4010`, GraphQL `4020`, client tĩnh `5173` |
| D04 | Quan hệ order–product | **B: `orders` 1–n `order_items`**, mỗi dòng trỏ tới 1 product |
| D05 | Nguồn giá | Giá hiển thị là `products.price` từ Product Service. `order_items` **không** lưu `unit_price`. `orders.total_amount` lưu ở Order |
| D06 | Id | Chuỗi có prefix: `u_…`, `o_…`, `p_…`. Không có FK xuyên service |
| D07 | Dữ liệu | Hai user trong cùng DB: `u_small` (N = 10, M = 19, K = 6) và `u_large` (N = 200, M = 399, K = 30). Seed tất định. Không phân trang |
| D08 | Thumbnail | File PNG tĩnh local, không dùng URL ngoài |
| D09 | Format nội bộ | Resource trần khi thành công. Lỗi thống nhất `{error:{code,message}}`. `Cache-Control: no-store`. Không bật nén |
| D10 | Batch Product | `GET /products?ids=` với B = 100. Phía gọi tự dedup, chia chunk và map lại theo id. Trả về có `notFound` |
| D11 | BFF | `GET /bff/web/dashboard/:userId` và `GET /bff/mobile/orders/:userId`. Gọi User ‖ Order song song, sau đó gọi Product theo batch. Mobile không gọi User |
| D12 | Shape mobile | Lồng, **giống hệt query GraphQL**: `{orders:[{id,status,items:[{product:{name,thumbnailUrl}}]}]}` |
| D13 | GraphQL | Một endpoint `POST /graphql`. Root `user(id)` cho web, `ordersByUser(userId)` cho mobile |
| D14 | N+1 | Env `PRODUCT_LOADER=naive\|batched`. DataLoader tạo mới cho **mỗi request** |
| D15 | Baseline | B1: browser gọi tuần tự User → Order → Product batch (3 request). B2 (naive) chỉ làm nếu còn thời gian |
| D16 | Đếm | Log JSON lines theo `rid`, dùng `AsyncLocalStorage`. Đếm DB query bằng hook `verbose` của `better-sqlite3`. Đếm client request bằng HAR |
| D17 | Màn hình hoàn tất | `performance.mark('screen-complete')` sau khi render và qua 2 lần `rAF`. Báo `t_data` (số chính) và `t_complete` |
| D18 | Điều kiện chạy | Đo bằng Playwright, mỗi lần một context mới. 5 lượt × (restart → 1 cold + 5 warm). Thêm lượt warm có throttle RTT 100 ms |
| D19 | Fault injection | `POST /__fault` trên Product Service, chỉ bật khi `ENABLE_FAULT=1`. Lỗi tất định (100%) |
| D20 | Timeout / retry | Timeout 1000 ms cho mọi call nội bộ, 0 retry |
| D21 | **Policy lỗi** | **P2: trả dữ liệu một phần có đánh dấu lỗi** khi Product chậm/lỗi. User/Order lỗi thì thất bại toàn bộ |

---

## 2. Nền tảng (D01–D03)

| Quyết định | Lý do | Trade-off chấp nhận |
|---|---|---|
| Node.js + Express cho cả 3 service, BFF và GraphQL | Một ngôn ngữ cho cả nhóm, `dataloader` là thư viện chuẩn | Không so sánh được hiệu năng giữa các runtime (không cần) |
| SQLite (`better-sqlite3`) | Dựng nhanh trong 65 phút. Hook `verbose` bắt **mọi** câu SQL ở tầng driver | Cold không thật sự lạnh vì OS vẫn cache trang (xem mục 9) |
| Client HTML + JS thuần, **một hàm render chung** cho mọi biến thể | Mỗi biến thể chỉ khác *adapter lấy dữ liệu*. Trường hiển thị và chi phí render giống hệt nhau | Phải tự viết DOM code |

Cấu trúc repo:

```
services/{user,order,product}/   # REST + SQLite
bff/                             # BFF web + mobile
graphql/                         # yoga + dataloader
client/                          # web.html, mobile.html, render.js, adapters/{baseline,bff,graphql}.js, img/
shared/                          # rid middleware, logger, httpClient (timeout), db wrapper
scripts/                         # seed.js, measure.js, verify.js, parse-logs.js, waterfall.js
data/  logs/  results/raw/  results/waterfall/
```

---

## 3. Schema và dữ liệu (D04–D08)

### 3.1 DDL

```sql
-- data/user.db
CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- 'u_small', 'u_large', 'u_noise_1'..
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TEXT NOT NULL
);

-- data/order.db
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,      -- 'o_00001'
  user_id          TEXT NOT NULL,         -- tham chiếu logic sang user.db
  status           TEXT NOT NULL CHECK (status IN ('PENDING','PAID','SHIPPED','DELIVERED','CANCELLED')),
  total_amount     INTEGER NOT NULL,      -- VND, số nguyên
  shipping_address TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL          -- ISO-8601, duy nhất trong mỗi user
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);

CREATE TABLE order_items (
  order_id    TEXT NOT NULL REFERENCES orders(id),   -- FK trong cùng DB thì được phép
  line_no     INTEGER NOT NULL,                      -- 1..n, quyết định thứ tự hiển thị
  product_id  TEXT NOT NULL,                         -- tham chiếu logic sang product.db
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, line_no)
);

-- data/product.db
CREATE TABLE products (
  id            TEXT PRIMARY KEY,         -- 'p_001'..'p_050'
  name          TEXT NOT NULL,
  price         INTEGER NOT NULL,
  thumbnail_url TEXT NOT NULL,            -- '/img/p_001.png'
  category      TEXT,
  description   TEXT                      -- ~500 ký tự, KHÔNG client nào hiển thị (để thấy rõ việc cắt trường)
);
```

Lý do không lưu `unit_price` (D05): khi Product lỗi thì cả tên **và** giá đều không có. Kịch bản lỗi vì vậy kiểm tra được đúng quy tắc "không thay tên hoặc giá bằng giá trị giả".

Trade-off: không đúng nghiệp vụ thật (giá đơn cũ phải là giá lúc mua). Đây là lựa chọn có chủ đích để phục vụ thí nghiệm, và được ghi lại trong phần trade-off khi trình bày.

### 3.2 Seed (`scripts/seed.js`, tất định)

- **Catalog:** 50 product `p_001..p_050`.
- **Số dòng mỗi đơn:** đơn thứ `i` (bắt đầu từ 0) có `(i % 3) + 1` dòng. Như vậy `u_small` có M = 19 và `u_large` có M = 399.
- **Product mỗi dòng:** dòng toàn cục thứ `g` của user dùng `pool[g % K]`.
  - `u_small` dùng `p_001..p_006` (K = 6).
  - `u_large` dùng `p_001..p_030` (K = 30, nhỏ hơn B nên batch luôn là 1 call).
  - Một đơn không bao giờ lặp product, vì K ≥ 3.
- **Status, quantity, địa chỉ:** PRNG `mulberry32(42)`.
- **`created_at`:** mốc cố định trừ `i` giờ, nên không bị trùng khi sắp xếp.
- **`total_amount`:** `Σ quantity × products.price` tại thời điểm seed. Seed đọc catalog trước.
- **User nhiễu:** 3 user, mỗi người 20 đơn, product ngẫu nhiên trong toàn catalog.
- Seed in ra `N, M, K` của từng user. Số in ra **phải khớp** bảng dưới, nếu lệch thì dừng.

| User | N | M | K | Tỉ lệ dedup M/K |
|---|---|---|---|---|
| `u_small` | 10 | 19 | 6 | ≈ 3.2 |
| `u_large` | 200 | 399 | 30 | ≈ 13.3 |

Không phân trang. Dashboard luôn hiển thị toàn bộ đơn, để thấy được sự tăng theo N.

---

## 4. Contract

### 4.1 Quy ước chung (D09)

- Thành công: resource trần, JSON, `Cache-Control: no-store`, không nén.
- Lỗi: `{ "error": { "code": "<UPPER_SNAKE>", "message": "..." } }` kèm status `4xx/5xx` phù hợp.
- Correlation id `rid`:
  - Server nhận `rid` từ header `X-Request-Id` hoặc query `?rid=`. Không có thì tự sinh.
  - BFF/GraphQL chuyển tiếp `rid` xuống service bằng header `X-Request-Id`.
  - Client truyền qua `?rid=`, vì custom header gây CORS preflight.
- CORS: cả 5 server đều cho phép origin `http://localhost:5173`.

### 4.2 User Service `:4001`

```
GET /users/:id
200 { "id": "u_small", "name": "Nguyễn Văn A", "email": "a@example.test", "avatarUrl": "/img/avatar_1.png" }
404 { "error": { "code": "USER_NOT_FOUND", "message": "..." } }
```

DB: 1 query.

### 4.3 Order Service `:4002`

```
GET /users/:userId/orders
200 [ { "id": "o_00001", "userId": "u_small", "status": "PAID", "totalAmount": 398000,
        "shippingAddress": "...", "note": null, "createdAt": "2026-09-01T10:00:00.000Z",
        "items": [ { "lineNo": 1, "productId": "p_003", "quantity": 2 } ] }, ... ]
```

- Sắp theo `createdAt DESC`. `items` sắp theo `lineNo ASC`. User không có đơn thì trả `[]`.
- **Đúng 2 DB query** mỗi request:
  1. `SELECT … FROM orders WHERE user_id = ? ORDER BY created_at DESC`
  2. `SELECT … FROM order_items WHERE order_id IN (…) ORDER BY order_id, line_no`

  Không truy vấn items theo từng đơn, vì như vậy là N+1 ngay trong Order Service. Nếu không có đơn thì chỉ có 1 query.
- Luôn trả đủ trường. Việc cắt trường cho mobile làm ở BFF/GraphQL.

### 4.4 Product Service `:4003`

```
GET /products/:id                         -- chỉ dùng cho GraphQL naive (và baseline B2)
200 { "id", "name", "price", "thumbnailUrl", "category", "description" }
404 PRODUCT_NOT_FOUND

GET /products?ids=p_001,p_003,...         -- batch, tối đa B = 100 id
200 { "items": [ {...product} ], "notFound": ["p_999"] }
400 TOO_MANY_IDS   (nếu > 100 id)  |  400 INVALID_IDS (rỗng)

POST /__fault  { "mode": "none" | "delay" | "error" | "hang", "delayMs": 3000 }   -- chỉ khi ENABLE_FAULT=1
GET  /__fault  → trạng thái hiện tại
```

- Batch: **1 DB query** `SELECT … WHERE id IN (…)`. Thứ tự `items` không được đảm bảo. Phía gọi map lại theo `id`.
- Fault chỉ áp lên các route `/products*`, không áp lên `/__fault`.

### 4.5 BFF `:4010` (D11, D12)

```
GET /bff/web/dashboard/:userId
200 {
  "user":   { "id", "name", "email", "avatarUrl" },
  "orders": [ { "id", "status", "totalAmount", "shippingAddress", "note", "createdAt",
                "items": [ { "lineNo", "quantity", "product": { "id", "name", "price", "thumbnailUrl" } | null } ] } ],
  "errors": [ ... ]        -- CHỈ có mặt khi có lỗi (giống GraphQL)
}

GET /bff/mobile/orders/:userId
200 { "orders": [ { "id", "status", "items": [ { "product": { "name", "thumbnailUrl" } | null } ] } ],
      "errors": [ ... ] }  -- chỉ có mặt khi có lỗi
```

Luồng gọi nội bộ (dùng để vẽ call graph):

```
web:    ┌ GET user/users/:id ───────┐
        └ GET order/users/:id/orders┘ → dedup productId → GET product/products?ids=(chunk ≤100) → ghép
mobile:   GET order/users/:id/orders  → dedup productId → GET product/products?ids=(chunk ≤100) → ghép, cắt trường
```

- User hoặc Order lỗi/timeout: trả `502 UPSTREAM_USER_FAILED | UPSTREAM_ORDER_FAILED`, hoặc `504 …_TIMEOUT` (thất bại toàn bộ, mục 7).
- User không tồn tại: `404 USER_NOT_FOUND`.

### 4.6 GraphQL `:4020` (D13, D14)

```graphql
type Query {
  user(id: ID!): User
  ordersByUser(userId: ID!): [Order!]!     # mobile: không gọi User Service
}
type User      { id: ID!  name: String!  email: String!  avatarUrl: String  orders: [Order!]! }
type Order     { id: ID!  status: OrderStatus!  totalAmount: Int!  shippingAddress: String  note: String
                 createdAt: String!  items: [OrderItem!]! }
type OrderItem { lineNo: Int!  quantity: Int!  product: Product }   # NULLABLE để làm policy P2
type Product   { id: ID!  name: String!  price: Int!  thumbnailUrl: String! }
enum OrderStatus { PENDING PAID SHIPPED DELIVERED CANCELLED }
```

Hai query cố định, lưu ở `client/adapters/graphql.js`:

```graphql
query WebDashboard($id: ID!) {
  user(id: $id) { id name email avatarUrl
    orders { id status totalAmount shippingAddress note createdAt
             items { lineNo quantity product { id name price thumbnailUrl } } } } }

query MobileOrders($id: ID!) {
  ordersByUser(userId: $id) { id status items { product { name thumbnailUrl } } } }
```

Resolver:

- `user` gọi User Service. `User.orders` và `ordersByUser` gọi Order Service (1 call, đã có sẵn items).
- `OrderItem.product` có hai chế độ:
  - `PRODUCT_LOADER=naive`: gọi `GET /products/:id` cho **từng dòng**. Không dedup, không cache. Đây là N+1: **M call**.
  - `PRODUCT_LOADER=batched`: `context.productLoader.load(productId)`. DataLoader được tạo trong hàm `context` của **mỗi request**. `batchFn` gọi `GET /products?ids=` theo chunk ≤ 100 rồi map theo id. Id nằm trong `notFound` thì trả `Error` cho key đó.
- `POST /graphql?rid=…`. Không persisted query, không giới hạn depth (ngoài phạm vi, ghi vào trade-off).
- Mỗi lần đổi `PRODUCT_LOADER` phải restart. Hai chế độ được đo như hai biến thể riêng, mỗi biến thể có lần cold riêng.

### 4.7 Baseline (D15)

- Chỉ có client web (`web.html?variant=baseline`).
- Gọi **tuần tự**, đúng theo đề:
  1. `GET :4001/users/:id?rid=`
  2. `GET :4002/users/:id/orders?rid=`
  3. `GET :4003/products?ids=<K id đã dedup>&rid=`

  Sau đó browser tự ghép thành cùng model với BFF web.
- User và Order không phụ thuộc nhau nhưng vẫn gọi tuần tự. Lựa chọn này có chủ đích để minh hoạ chi phí ghép ở client.
- B2 (naive, 2 + M request) là tuỳ chọn. Nếu làm thì báo riêng, không thay B1.

---

## 5. Cách đếm (D16)

### 5.1 Định nghĩa

| Đại lượng | Tính | Không tính |
|---|---|---|
| **Client request** | Mọi request lấy dữ liệu màn hình từ browser tới :4001–4020 (nguồn: HAR) | File tĩnh từ :5173 (báo cột riêng `static_requests`), preflight `OPTIONS` (báo cột riêng `preflight`) |
| **Service call** | Mỗi request HTTP tới User/Order/Product, tính theo service đích, bao gồm cả request bị timeout. Ở baseline, mỗi client request là một service call | Lượt DataLoader trả từ cache (ghi `cache-hit`) |
| **DB query** | Mỗi câu SQL được `better-sqlite3` thực thi trong lúc xử lý request có `rid` | Migration, seed, câu lệnh lúc khởi động (không có `rid`) |

Lưu ý preflight: GraphQL dùng `POST` với `Content-Type: application/json` nên mỗi lần chạy có **1 preflight**. Baseline và BFF dùng GET đơn giản nên không có preflight. Số này được báo riêng, không gộp vào client request, và được nêu trong phần giới hạn.

### 5.2 Cơ chế

1. **Middleware `rid`** (`shared/rid.js`): lấy hoặc sinh `rid` rồi đặt vào `AsyncLocalStorage`. Ghi log `http-in` khi bắt đầu, và `http-done` khi kết thúc (kèm status và `durationMs`).
2. **HTTP client** (`shared/httpClient.js`): ghi `http-out` gồm target, status, `durationMs`, `timedOut`. Gắn `X-Request-Id`, timeout 1000 ms bằng `AbortController`.
3. **DB**: mở `new Database(file, { verbose: sql => log({kind:'db', sql}) })`. Hook ở tầng driver nên không câu SQL nào lọt qua được.
4. **DataLoader**: bọc `load()` để ghi `cache-hit` khi key đã có trong request.
5. **Log**: mỗi process ghi JSON lines vào `logs/<service>.jsonl`:
   ```json
   {"ts":1728370000123.45,"rid":"…","service":"graphql","kind":"http-out","target":"product","method":"GET","path":"/products?ids=…","status":200,"durationMs":3.2}
   ```
   `ts` = `performance.timeOrigin + performance.now()` (ms, có phần thập phân).
6. **`scripts/parse-logs.js`**: gom theo `rid` thành các cột của bảng đo thô, đồng thời xuất trace (cho N+1) và call graph (cho BFF).

### 5.3 Kiểm chứng (bắt buộc trước khi lấy số)

- Với mỗi service đích: **số `http-out` từ composer = số `http-in` tại service** cho cùng `rid`. Lệch là instrumentation sai.
- Số client request trong HAR = số `http-in` có `rid` đó tại các server mà client gọi trực tiếp.
- Chạy đo **tuần tự, không đồng thời**. Mỗi `rid` dùng cho đúng một lần tải màn hình.

### 5.4 Số kỳ vọng (giả thuyết, đo thật để xác nhận)

Đơn vị mỗi ô là `service call / DB query`. Đã tính Order DB = 2 query.

| Biến thể | Client req | User | Order | Product (small) | Product (large) | cache-hit (small / large) |
|---|---|---|---|---|---|---|
| Baseline B1 (web) | 3 | 1 / 1 | 1 / 2 | 1 / 1 | 1 / 1 | – |
| BFF web | 1 | 1 / 1 | 1 / 2 | 1 / 1 | 1 / 1 | – |
| BFF mobile | 1 | **0 / 0** | 1 / 2 | 1 / 1 | 1 / 1 | – |
| GraphQL naive web | 1 (+1 preflight) | 1 / 1 | 1 / 2 | **19 / 19** | **399 / 399** | – |
| GraphQL naive mobile | 1 (+1 preflight) | 0 / 0 | 1 / 2 | 19 / 19 | 399 / 399 | – |
| GraphQL batched web | 1 (+1 preflight) | 1 / 1 | 1 / 2 | **1 / 1** | **1 / 1** | 13 / 369 |
| GraphQL batched mobile | 1 (+1 preflight) | 0 / 0 | 1 / 2 | 1 / 1 | 1 / 1 | 13 / 369 |

Tiêu chí đạt: Product call của GraphQL batched **bằng 1 ở cả small và large**, tức không tăng theo N hay M. `cache-hit = M − K`.

### 5.5 Bảng đo thô (`results/raw/runs.csv`, mỗi lần chạy là một dòng)

```
run_id, ts, variant(baseline|bff|gql-naive|gql-batched), client(web|mobile), dataset(small|large),
throttle(none|rtt100), fault(none|delay300|delay3000|error500|hang), round, mode(cold|warm), run_no, rid,
client_requests, preflight, static_requests,
user_calls, order_calls, product_calls, cache_hits,
user_db, order_db, product_db,
t_data_ms, t_complete_ms, t_images_ms,
payload_bytes, payload_gzip_bytes, http_status, has_errors, rows_rendered
```

- `payload_bytes`: tổng body JSON của các client request dữ liệu, lấy từ HAR. Baseline là tổng của 3 response.
- `payload_gzip_bytes`: script tính gzip offline, chỉ để tham khảo.
- `results/summary.csv`: median và min–max theo `(variant, client, dataset, throttle, fault, mode)`.

---

## 6. Màn hình hoàn tất và điều kiện chạy (D17, D18)

### 6.1 Định nghĩa

- **Web** hoàn tất khi DOM hiển thị tên user và đủ N dòng đơn. Mỗi đơn hiển thị đủ M dòng hàng, mỗi dòng có tên và giá product, **hoặc** marker lỗi `[data-error="product"]`.
- **Mobile** hoàn tất khi đủ N đơn, mỗi đơn có mã, trạng thái và các dòng gồm tên product kèm thẻ `<img>`, **hoặc** marker lỗi.
- **Thất bại toàn bộ** (User/Order lỗi): màn hình lỗi `[data-screen-error]` hiển thị xong cũng được tính là hoàn tất, với `status = error`.

### 6.2 Mốc đo (do `client/render.js` đặt, giống nhau cho mọi biến thể)

| Mark | Thời điểm |
|---|---|
| `data-start` | Ngay trước `fetch` dữ liệu đầu tiên |
| `screen-complete` | Response cuối về, render xong, qua 2 lần `requestAnimationFrame`. Detail gồm `{status: 'ok' \| 'partial' \| 'error', rows}` |
| `images-complete` | Mọi `<img>` đã `load`/`error`. **Số phụ**, không dùng để so sánh |

- **`t_data = screen-complete − data-start`**: số chính để so sánh giữa các biến thể.
- `t_complete = screen-complete − timeOrigin`: báo kèm.
- Trang expose `window.__rid` và `window.__screenData` (model đã render) cho script.
- Script Playwright dùng `MutationObserver`/selector để xác nhận số `[data-order-row]` = N và số `[data-item-row]` = M lúc mark được đặt. Nếu sai, lần chạy bị đánh dấu `invalid`.

### 6.3 Quy trình đo (`scripts/measure.js`)

- Trang:
  - `web.html?variant=baseline|bff|graphql&user=u_small|u_large`
  - `mobile.html?variant=bff|graphql&user=…`
- Mỗi lần chạy: **browser context mới** (không có cache, cookie hay preflight cache), ghi HAR.
- **Cold:** restart toàn bộ 5 server (cùng `PRODUCT_LOADER` của biến thể), chờ `/health`, chạy lần đầu.
- **Warm:** 5 lần tiếp theo, giữ nguyên process.
- **Ma trận chính** (không throttle, không fault): 7 tổ hợp `(variant, client)` × 2 dataset × **5 lượt** × (1 cold + 5 warm). Tổng cộng 5 mẫu cold và 25 mẫu warm cho mỗi ô.
- **Ma trận throttle:** như trên nhưng chỉ chạy warm, 1 lượt × 5 lần. Throttle bằng CDP `Network.emulateNetworkConditions({latency: 100, downloadThroughput: -1, uploadThroughput: -1})`, chỉ áp cho đoạn client → server.
- **Waterfall** (`results/waterfall/`):
  - Mỗi biến thể lấy lần warm có `t_data` gần median nhất, dataset small, không throttle. Vẽ thêm một bản có throttle.
  - Kẻ vạch dọc tại `data-start` và `screen-complete`.
  - Call graph nội bộ của BFF và trace N+1/batched của GraphQL dựng từ log theo `rid` của chính lần chạy đó.

---

## 7. Policy lỗi (D19–D21)

### 7.1 Policy chính thức: **P2, trả dữ liệu một phần có đánh dấu lỗi**

Policy này áp dụng **giống nhau cho BFF và GraphQL, cho cả web và mobile**, khi **Product Service** chậm quá timeout, lỗi 5xx hoặc thiếu id.

| Thành phần | Hành vi |
|---|---|
| Dữ liệu | User và order vẫn trả đủ. Mỗi dòng hàng bị ảnh hưởng có `product: null` |
| Marker | Một phần tử `errors[]` **cho mỗi field `product` bị null**: `{ message, path, extensions: { code } }` |
| Mã lỗi | `PRODUCT_TIMEOUT` (quá 1000 ms), `PRODUCT_UNAVAILABLE` (5xx hoặc lỗi kết nối), `PRODUCT_NOT_FOUND` (id nằm trong `notFound`) |
| BFF | HTTP `200`, header `X-Partial-Response: true`, `errors[].path` dạng `["orders", 3, "items", 1, "product"]` |
| GraphQL | HTTP `200`, `data` + `errors[]` theo chuẩn, `path` dạng `["user","orders",3,"items",1,"product"]` hoặc `["ordersByUser",3,"items",1,"product"]` |
| Client | Dòng hàng hiện **"Không tải được thông tin sản phẩm"** (`data-error="product"`, kiểu hiển thị lỗi rõ ràng). Banner đầu trang: "Một số thông tin sản phẩm chưa tải được" |
| **Cấm** | Điền tên/giá giả, giá `0`, chuỗi rỗng, giá trị cache cũ, hoặc ẩn dòng hàng |

Để so sánh BFF với GraphQL, hàm đối chiếu bỏ tiền tố root (`user.` / `ordersByUser`) trong `path`. Shape `errors` của BFF dùng cùng khoá `message`, `path`, `extensions.code` như GraphQL.

**User hoặc Order lỗi thì thất bại toàn bộ**, vì không còn gì có nghĩa để hiển thị:

- BFF trả `502`/`504` kèm `{error:{code}}`.
- GraphQL trả `data.user` (hoặc `data`) là `null`, kèm `errors[]`.
- Client hiển thị màn hình lỗi.

### 7.2 Lý do chọn P2

- Product chỉ bổ sung tên, giá và ảnh. Trạng thái, tổng tiền và địa chỉ đơn vẫn có giá trị khi Product lỗi. Nếu fail toàn bộ thì availability của dashboard chỉ còn xấp xỉ tích availability của 3 service.
- GraphQL hỗ trợ partial tự nhiên (field nullable cộng `errors` có `path`). BFF bắt chước đúng shape đó nên hai biến thể nhất quán và dùng chung được một hàm kiểm tra.

### 7.3 Trade-off chấp nhận

- HTTP `200` che sự cố khỏi monitoring dựa trên status. Bù lại bằng header `X-Partial-Response` và log `http-out` có `status`/`timedOut`.
- Client phải xử lý `product: null` ở mọi chỗ dùng product.
- Vì dùng batch, lỗi của một call batch làm **mọi** dòng trong chunk đó null cùng lúc: "lỗi từng item" thực chất thành "lỗi cả nhóm".
- `errors[]` có một phần tử cho mỗi field. Khi Product chết, `u_large` trả 399 lỗi, payload lỗi tăng theo M. Chấp nhận vì đây là hành vi chuẩn của GraphQL, và ghi vào phần giới hạn.
- Không cache response partial (đã có `no-store`).

### 7.4 Timeout, retry, fault injection

- Timeout **1000 ms** cho mọi call nội bộ (User, Order, Product), dùng `AbortController`.
- **0 retry**. Không circuit breaker. Không fallback.
- Fault tất định (không ngẫu nhiên), do `measure.js` điều khiển qua `POST /__fault` giữa các lượt.

| Mã | Kịch bản | Kỳ vọng |
|---|---|---|
| F0 | `none` | Dữ liệu đủ, `status = ok` |
| F1 | `delay` 300 ms (dưới timeout) | Dữ liệu đủ, `t_data` tăng khoảng 300 ms (naive: chậm theo M lần, tuỳ mức song song) |
| F2 | `delay` 3000 ms (trên timeout) | `status = partial`, `PRODUCT_TIMEOUT`, `t_data` ≈ 1000 ms + phần còn lại |
| F3 | `error` (500 ngay lập tức) | `status = partial`, `PRODUCT_UNAVAILABLE` |
| F4 | `hang` (tuỳ chọn) | Giống F2. Chứng minh timeout thật sự cắt request |

Ma trận lỗi: F1–F3 (cộng F4 nếu làm) × {BFF, GraphQL batched} × {web, mobile} × dataset small. Mỗi ô chạy warm 5 lần. Baseline không thuộc phạm vi policy nên không đo lỗi.

Với mỗi ô, ghi:

- HTTP status, `has_errors`, các `code`
- `t_data`, `t_complete`
- Số product call (kể cả call bị timeout)
- Ảnh chụp màn hình
- Kết quả kiểm tra "không có giá trị giả" (mục 8)

---

## 8. Đối chiếu dữ liệu (tiêu chí đạt)

`scripts/verify.js` đọc `window.__screenData` qua Playwright, cho cả `u_small` và `u_large`:

1. **Web:** model của baseline, BFF và GraphQL batched (và GraphQL naive) phải **deep-equal** sau khi chuẩn hoá. Chuẩn hoá gồm: bỏ envelope `data`/`errors`, giữ nguyên thứ tự đơn và dòng hàng.
2. **Mobile:** response của BFF và GraphQL (sau khi bỏ `data.ordersByUser` → `orders`) phải deep-equal. Mỗi response cũng phải khớp **whitelist khoá chính xác**:
   - order: `{id, status, items}`
   - item: `{product}`
   - product: `{name, thumbnailUrl}`

   Thừa hay thiếu một khoá đều tính là trượt.
3. **Mobile ⊂ web:** dữ liệu mobile phải bằng phép chiếu của dữ liệu web lên các trường mobile.
4. **Không có giá trị giả** (khi chạy fault): mọi `product` hoặc bằng đúng bản ghi trong `product.db`, hoặc là `null` và có lỗi với `path` tương ứng. Không có `null` nào thiếu lỗi, không có lỗi nào thiếu `null`.
5. Kết quả ghi vào `results/verify.json` (pass/fail từng mục, kèm diff nếu trượt). Lần trượt cũng được nộp.

---

## 9. Giới hạn đã biết của phép đo

- Localhost có RTT gần 0, nên lợi ích từ việc giảm số client request bị thu nhỏ. Vì vậy có thêm ma trận throttle RTT 100 ms.
- SQLite cold vẫn được OS cache trang. "Cold" ở đây là cold về process (JIT, kết nối, statement cache), không phải cold về đĩa.
- Instrumentation (log JSON, hook `verbose`) thêm overhead. Overhead giống nhau giữa các biến thể nhưng không bằng 0.
- Preflight của GraphQL `POST` là chi phí thật khi chạy cross-origin, được báo riêng. Nếu deploy cùng origin thì sẽ không có.
- Độ trễ CDP hoạt động như **thời gian tối thiểu cho mỗi request**, không phải RTT cộng thêm: khi server xử lý dưới 100 ms, thời gian xử lý bị "giấu" trong độ trễ giả lập (đo được: server 92 ms thì fetch 126 ms, server 161 ms thì fetch 168 ms). Ma trận throttle vì vậy chỉ phản ánh **số round-trip tuần tự phía client**, không dùng để so chi phí server giữa naive và batched.
- Throttle bằng CDP (`Network.emulateNetworkConditions`) không áp độ trễ lên CORS preflight. Vì vậy ma trận throttle **đánh giá thấp** chi phí của GraphQL `POST` cross-origin, vốn tốn thêm 1 RTT ngoài thực tế.
- `errors[]` tăng theo M khi Product chết (mục 7.3).
- 5 mẫu cold mỗi ô chỉ đủ thấy xu hướng, không đủ để kết luận thống kê.
- Không phân trang, không có tải đồng thời, không có auth. Kết quả không đại diện cho production.
- Giá lấy từ catalog hiện tại thay vì snapshot là đơn giản hoá có chủ đích (D05).

---

## 10. Thứ tự hiện thực và nhật ký thay đổi

Thứ tự hiện thực:

1. `seed.js` và 3 service, `shared/` (rid, log, httpClient, db hook). Kiểm tra bằng curl.
2. Client `render.js` và adapter baseline. Đối chiếu bằng mắt trên `u_small`.
3. BFF web + mobile. Chạy `verify.js` (mục 8.1–8.3).
4. GraphQL `naive`. Ghi trace N+1. Sau đó chuyển sang `batched`, ghi trace và chạy lại `verify.js`.
5. `measure.js` và `parse-logs.js`. Kiểm chứng đếm (mục 5.3), rồi chạy ma trận chính và ma trận throttle.
6. Fault injection F1–F4. Chạy `verify.js` mục 8.4.
7. Waterfall, bảng tổng hợp, README.

| Ngày | Thay đổi | Lý do |
|---|---|---|
| 2026-10-08 | Chốt bản đầu từ `brainstorm.md`. D04 chọn option B (order_items) thay vì A | Quyết định của nhóm trong brainstorm |
| 2026-10-08 | D16: số client request lấy từ sự kiện `requestfinished` của Playwright (cùng nguồn với HAR) thay vì ghi file HAR cho mọi lần chạy. Timing phía client lấy từ Resource Timing (`results/raw/client-timing.jsonl`) | Ghi HAR cho khoảng 500 lần chạy quá nặng. Resource Timing dùng cùng gốc thời gian với các mark nên vẽ waterfall chính xác hơn |
| 2026-10-08 | D18: ma trận throttle và ma trận lỗi có thêm 1 lần chạy khởi động ngay sau restart, **không ghi** vào bảng, để các lần được ghi đều là warm | Giữ đúng định nghĩa warm (mục 6.3) |
| 2026-10-08 | D01: Playwright dùng Chromium nếu đã cài, nếu không thì tự chuyển sang Edge/Chrome có sẵn (`BROWSER_CHANNEL`) | Máy chạy đo chưa có bản Chromium của Playwright 1.64 |
| 2026-10-08 | Mục 9: thêm giới hạn "throttle bằng CDP không áp lên CORS preflight" | Quan sát khi chạy thử: request GraphQL có preflight vẫn mất khoảng 1 RTT giả lập, giống BFF |
| 2026-10-08 | Mục 9: thêm giới hạn "độ trễ CDP là thời gian tối thiểu, che mất thời gian server" | Đối chiếu thời lượng fetch phía client với `http-done.durationMs` phía GraphQL trên các lần chạy naive/large có throttle |
| 2026-10-08 | Bảng đo thô thêm các cột `items_rendered, screen_status, error_codes, timed_out, count_check, valid` | Dùng để kiểm chứng mục 5.3 và 6.2 ngay trên từng dòng |
