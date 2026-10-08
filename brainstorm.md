# Brainstorm: API composition (Block 2)

> Ghi chép brainstorm trước khi viết `plan.md`. Mỗi mục liệt kê các option, trade-off và một **đề xuất**. Nhóm phải tự chốt và tự bảo vệ quyết định, vì đề bài ghi rõ: *câu trả lời của agent không dùng làm evidence*. Các con số "kỳ vọng" bên dưới chỉ là giả thuyết, cần đo thật để xác nhận.

Ký hiệu dùng xuyên suốt:

- `N` = số đơn của user đang xem
- `K` = số product **khác nhau** trong `N` đơn đó (`K ≤ N`, vì product lặp giữa các đơn)
- `B` = giới hạn số id trong một lần gọi batch tới Product Service

---

## 0. Quyết định nền (ảnh hưởng tới mọi mục sau)

| Câu hỏi | Option | Trade-off | Đề xuất |
|---|---|---|---|
| Stack | Node.js (Express/Fastify) + `graphql-yoga` hoặc Apollo + `dataloader` | Cả nhóm dùng chung một ngôn ngữ, có DataLoader chuẩn | **Node.js** cho cả 3 service, BFF và GraphQL |
| CSDL | **SQLite** (mỗi service một file `.db`) | Dựng nhanh, không cần Docker, dễ bọc hàm để đếm query. Nhưng cache trang của OS khiến "lạnh" không thật sự lạnh | **SQLite** nếu ưu tiên kịp 65 phút |
| | **Postgres** (docker-compose, mỗi service một database) | Giống thực tế, có `log_statement` / `pg_stat_statements` để đối chiếu số query. Tốn thời gian setup | Chọn nếu nhóm đã quen Docker |
| | JSON/in-memory | Không có "DB query" thật, nên chỉ số đếm query trở nên vô nghĩa | **Không dùng** |
| Port | User `:4001`, Order `:4002`, Product `:4003`, BFF `:4010`, GraphQL `:4020`, static client `:5173` | Tách port giúp waterfall đọc dễ hơn | Như bên cạnh |

---

## 1. Schema và dữ liệu mẫu

### 1.1 Quan hệ order ↔ product

| Option | Mô tả | Ưu | Nhược |
|---|---|---|---|
| **A. 1 đơn = 1 product** | `orders.product_id`, `orders.quantity` | Khớp đề ("mỗi đơn kèm tên product"). N+1 rõ ràng: N đơn thì N call. Mobile có đúng một `productName` mỗi đơn | Kém thực tế |
| **B. Đơn có nhiều dòng** | Bảng `order_items(order_id, product_id, quantity, unit_price)` | Thực tế. N+1 lồng hai tầng nên dedup thể hiện rõ hơn | Mobile "tên product" thành một danh sách. Đếm, đối chiếu và UI đều phức tạp hơn, khó kịp 65 phút |
| C. Mảng id trong đơn | `orders.product_ids` dạng JSON | Ít bảng | Phi chuẩn hoá, khó query, không đáng làm |

**Đề xuất: B.** 

### 1.2 Giá lấy từ đâu

| Option | Ưu | Nhược |
|---|---|---|
| **Giá lấy từ Product Service** (`products.price`) | Khi Product lỗi thì cả tên và giá đều mất, đúng tinh thần "không thay tên hoặc giá bằng giá trị giả". Kịch bản lỗi có ý nghĩa | Không thực tế: giá đơn cũ đáng lẽ phải là giá lúc mua |
| Snapshot `unit_price` trong Order | Đúng nghiệp vụ | Product lỗi chỉ còn ảnh hưởng tên và ảnh, nên kịch bản lỗi nhẹ đi |

**Đề xuất:** hiển thị `product.price` lấy từ Product Service. `orders.total_amount` vẫn lưu ở Order. Ghi rõ đây là lựa chọn có chủ đích để phục vụ thí nghiệm.

### 1.3 Schema đề xuất (option A)

```sql
-- user.db
CREATE TABLE users (
  id          TEXT PRIMARY KEY,      -- 'u_small', 'u_large'
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TEXT NOT NULL
);

-- order.db
CREATE TABLE orders (
  id               TEXT PRIMARY KEY, -- 'o_0001'
  user_id          TEXT NOT NULL,    -- tham chiếu logic, KHÔNG có FK xuyên service
  product_id       TEXT NOT NULL,    -- tham chiếu logic sang product.db
  quantity         INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','PAID','SHIPPED','DELIVERED','CANCELLED')),
  total_amount     INTEGER NOT NULL, -- đơn vị nhỏ nhất (VND), tránh số thực
  shipping_address TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);

-- product.db
CREATE TABLE products (
  id            TEXT PRIMARY KEY,    -- 'p_001'
  name          TEXT NOT NULL,
  price         INTEGER NOT NULL,
  thumbnail_url TEXT NOT NULL,
  category      TEXT,
  description   TEXT                 -- trường "nặng", web/mobile đều KHÔNG hiển thị, dùng để thấy rõ over-fetching
);
```

| Quyết định nhỏ | Option | Đề xuất |
|---|---|---|
| Kiểu id | Integer tự tăng / chuỗi có prefix (`u_`, `o_`, `p_`) | **Prefix**. Đọc log và trace biết ngay id thuộc service nào, và tránh nhầm id giữa các service |
| FK xuyên service | Có (gộp DB) / Không | **Không**. Mỗi service một DB, chỉ giữ tham chiếu logic |
| Ảnh thumbnail | URL ngoài (picsum…) / file tĩnh local / data URI | **File tĩnh local** (vài file PNG nhỏ). Tránh để mạng ngoài làm nhiễu số đo |

### 1.4 Hai kích thước dữ liệu

| Option | Mô tả | Ưu | Nhược |
|---|---|---|---|
| **Hai user trong cùng DB** | `u_small` có 10 đơn và K = 4; `u_large` có 200 đơn và K = 25 | Không phải seed lại, đổi kích thước chỉ cần đổi `userId`, dễ demo | Kích thước bảng giống nhau cho cả hai, nên chỉ đo được ảnh hưởng của N, không đo được ảnh hưởng của kích thước bảng |
| Hai profile seed | `SEED=small` và `SEED=large`, seed lại DB khi chuyển | Tách bạch hoàn toàn | Phải restart/seed khi chuyển kích thước, dễ lẫn cold/warm |

**Đề xuất: hai user trong cùng DB.** Seed bằng script có **random seed cố định**, để mọi biến thể và mọi lần chạy đều thấy cùng dữ liệu. Thêm vài user "nhiễu" để bảng không chỉ chứa dữ liệu của user cần đo.

Cần chốt thêm:

- Tỉ lệ lặp product (`N/K`): small khoảng 2.5, large khoảng 8. Tỉ lệ này quyết định lợi ích của dedup.
- **Không phân trang** dashboard. Phân trang sẽ giấu sự tăng theo N. Ghi việc này vào phần giới hạn.
- Nếu `K` của bộ large lớn hơn `B`, batch sẽ tách chunk. Chọn `K ≤ B` để giữ đúng 1 call, hoặc cố ý cho `K > B` để quan sát việc chia chunk.

---

## 2. Contract của từng service

### 2.1 Quy ước chung

| Vấn đề | Option | Đề xuất |
|---|---|---|
| Thân response khi thành công | Resource trần / envelope `{data, meta}` | **Resource trần** ở 3 service nội bộ (gọn, dễ đọc). Có `errors` ở tầng BFF/GraphQL |
| Format lỗi | Tuỳ service / thống nhất | **Thống nhất** `{ "error": { "code": "PRODUCT_NOT_FOUND", "message": "..." } }` |
| Correlation id | Header `X-Request-Id` / query `?rid=` | **Header** giữa các server. Riêng ở browser baseline: custom header gây CORS preflight (xem mục 3), nên dùng `?rid=` hoặc để server tự sinh |
| Danh tính user | Query param / path / token giả | **Path param** (`/users/:id`). Không làm auth thật vì nằm ngoài phạm vi |
| Cache HTTP | Mặc định / `Cache-Control: no-store` | **`no-store`** cho mọi API, để "ấm" chỉ phản ánh trạng thái phía server (xem mục 4) |

### 2.2 User Service

```
GET /users/:id
200 { "id": "u_small", "name": "Nguyễn Văn A", "email": "a@example.test", "avatarUrl": "/img/a.png" }
404 { "error": { "code": "USER_NOT_FOUND", "message": "..." } }
```

### 2.3 Order Service

```
GET /users/:userId/orders            (hoặc GET /orders?userId=)
200 [ { "id": "o_0001", "userId": "u_small", "productId": "p_003", "quantity": 2,
        "status": "PAID", "totalAmount": 398000, "shippingAddress": "...", "note": null,
        "createdAt": "2026-09-01T10:00:00Z" }, ... ]   -- sắp theo createdAt DESC
```

| Option | Ưu | Nhược |
|---|---|---|
| Luôn trả đủ trường | Đơn giản | BFF mobile nhận thừa dữ liệu nội bộ (vẫn cắt được trước khi trả client) |
| Thêm `?fields=id,status,productId` | Giảm payload nội bộ cho mobile | Thêm logic. Payload nội bộ không nằm trong yêu cầu đo bắt buộc |

**Đề xuất:** trả đủ trường. Việc cắt trường để ở BFF/GraphQL, vì yêu cầu chỉ là *response cho mobile* phải gọn.

### 2.4 Product Service

```
GET /products/:id                      -- dùng cho bản N+1 (và baseline naive)
200 { "id": "p_003", "name": "...", "price": 199000, "thumbnailUrl": "/img/p_003.png", "category": "...", "description": "..." }

GET /products?ids=p_001,p_003,p_007    -- dùng cho bản đã sửa
200 { "items": [ {...}, {...} ], "notFound": ["p_007"] }
400 nếu số id > B (vd. B = 100)

POST /__fault  { "mode": "none|delay|error|hang", "delayMs": 2000, "errorRate": 1.0 }   -- chỉ bật ở môi trường thí nghiệm
```

| Quyết định | Option | Trade-off | Đề xuất |
|---|---|---|---|
| Kiểu batch | `GET ?ids=` | Cache được, dễ thử bằng curl. Bị giới hạn độ dài URL | **GET ?ids=**, giới hạn B = 100 và chia chunk ở phía gọi |
| | `POST /products:batchGet` | Không giới hạn độ dài | Không cache được, sai ngữ nghĩa đọc |
| Thứ tự kết quả batch | Theo thứ tự `ids` / tuỳ ý | DataLoader yêu cầu kết quả khớp thứ tự key | Trả tuỳ ý, **map lại theo id ở phía gọi** (không phụ thuộc vào thứ tự) |
| Id không tồn tại | 404 cả request / bỏ qua / `notFound` | 404 cả batch khiến 1 id hỏng làm hỏng tất cả | **`notFound`** riêng, xử lý như lỗi từng item |
| Dedup | Ở server Product / ở phía gọi | | **Ở phía gọi** (DataLoader / `new Set`), để số id gửi đi đúng bằng K |

### 2.5 BFF (một endpoint cho mỗi loại client)

```
GET /bff/web/dashboard/:userId
200 {
  "user":   { "id", "name", "email", "avatarUrl" },
  "orders": [ { "id", "status", "quantity", "totalAmount", "shippingAddress", "note", "createdAt",
                "product": { "id", "name", "price", "thumbnailUrl" } } ],
  "errors": []                       -- dùng cho policy partial (mục 5)
}

GET /bff/mobile/orders/:userId
200 { "orders": [ { "id", "status", "product": { "name", "thumbnailUrl" } } ], "errors": [] }
```

| Quyết định | Option | Trade-off | Đề xuất |
|---|---|---|---|
| Shape của mobile | Phẳng `{id, status, productName, thumbnailUrl}` | Nhỏ nhất | |
| | Lồng `product: {name, thumbnailUrl}` **giống query GraphQL** | Payload BFF và GraphQL so sánh công bằng, đối chiếu dữ liệu dễ | **Lồng, giống GraphQL** |
| Thứ tự gọi bên trong | Tuần tự User → Order → Product | Dễ đọc | Chậm hơn mức cần |
| | User ‖ Order song song, rồi Product | User và Order độc lập nên chạy song song được. Đây chính là lợi thế của BFF so với baseline | **Song song**. Ghi rõ trong call graph |
| Mobile có gọi User không | Có / Không | Mobile không hiển thị tên user | **Không gọi User**, và chứng minh bằng call graph |
| Product call | Từng id / batch | | **Batch + dedup** ngay từ đầu (N+1 chỉ bắt buộc tái hiện ở GraphQL) |

### 2.6 GraphQL (`POST /graphql`)

```graphql
type Query {
  user(id: ID!): User
  ordersByUser(userId: ID!): [Order!]!     # cho mobile: không đụng tới User Service
}
type User    { id: ID!  name: String!  email: String!  avatarUrl: String  orders: [Order!]! }
type Order   { id: ID!  status: OrderStatus!  quantity: Int!  totalAmount: Int!
               shippingAddress: String  note: String  createdAt: String!
               product: Product }            # nullable hay non-null: xem mục 5
type Product { id: ID!  name: String!  price: Int!  thumbnailUrl: String! }
enum OrderStatus { PENDING PAID SHIPPED DELIVERED CANCELLED }
```

Hai query cố định, lưu trong repo:

```graphql
query WebDashboard($id: ID!) { user(id: $id) { id name email avatarUrl
  orders { id status quantity totalAmount shippingAddress note createdAt
           product { id name price thumbnailUrl } } } }

query MobileOrders($id: ID!) { ordersByUser(userId: $id) { id status product { name thumbnailUrl } } }
```

| Quyết định | Option | Trade-off | Đề xuất |
|---|---|---|---|
| Root cho mobile | `user(id){ orders{…} }` | Một root duy nhất | Resolver `user` gọi User Service dù mobile không cần tên, tức thừa 1 call |
| | `ordersByUser(userId)` | Thêm một root field | **Chọn**. Số service call của mobile ngang với BFF |
| | `user` resolve lười (chỉ gọi User Service khi query trường ngoài `id`) | Giữ một root | Phức tạp, khó giải thích |
| Bật/tắt N+1 | Biến môi trường `PRODUCT_LOADER=naive\|batched` | Cần restart, ảnh hưởng tới cold/warm | **Env var**. Đo hai bản như hai biến thể riêng, mỗi bản đều có lần cold |
| | Hai endpoint `/graphql-n1` và `/graphql` | Không cần restart | Vi phạm tinh thần "một endpoint". Chỉ nên dùng để demo |
| Phạm vi DataLoader | **Tạo mới mỗi request** (trong `context`) | Đúng yêu cầu "batching và dedup trong phạm vi một request", không rò dữ liệu giữa các user | **Chọn** |
| | Global | Có thêm cache giữa các request | Sai yêu cầu, làm nhiễu số đo warm, dữ liệu dễ cũ |
| Bảo vệ endpoint | Depth/complexity limit, persisted query | An toàn hơn | Ngoài phạm vi. Ghi vào phần trade-off |

### 2.7 Baseline (browser tự ghép)

| Option | Chuỗi request | Ưu | Nhược |
|---|---|---|---|
| **B1. Tuần tự, dùng batch** | `GET /users/:id` → `GET /users/:id/orders` → `GET /products?ids=` | Công bằng: chỉ khác *nơi ghép*, cùng dùng batch | Không thấy được N+1 ở client |
| B2. Naive | User → Orders → N lần `GET /products/:id` (tuần tự) | Waterfall rất "đẹp" để minh hoạ | Với `u_large` là 202 request, so với BFF thì thiên lệch vì khác cả thuật toán |

**Đề xuất:** **B1 là baseline chính.** B2 tuỳ chọn, chỉ để minh hoạ. Lưu ý:

- Baseline cần **CORS** ở cả 3 service.
- Đề bài yêu cầu "gọi tuần tự", nên giữ tuần tự kể cả User/Order (dù gọi song song được). Ghi rõ lựa chọn này.
- Baseline chỉ có client web. Mobile chỉ áp dụng cho BFF và GraphQL.

---

## 3. Cách đếm DB query và service call

### 3.1 Định nghĩa (cần chốt trước khi đo)

| Đại lượng | Định nghĩa đề xuất | Tính | Không tính |
|---|---|---|---|
| **Client request** | Request HTTP từ trang/thiết bị client tới backend để lấy dữ liệu màn hình | `fetch` dữ liệu, mỗi lần retry | File tĩnh (HTML/JS/CSS/ảnh) báo **riêng**. Preflight `OPTIONS` báo **riêng** |
| **Service call** | Request HTTP từ một server (BFF/GraphQL) tới User/Order/Product, tính theo từng service đích. Ở baseline, client request chính là service call | Mỗi attempt, mỗi chunk batch | Lượt trúng cache DataLoader (log riêng là `cache-hit`) |
| **DB query** | Mỗi câu lệnh SQL service gửi xuống DB khi xử lý request | `SELECT … WHERE id IN (…)` tính **1** | Migration, seed, healthcheck, mở kết nối |

### 3.2 Option cơ chế đếm

| Option | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A. Counter trong process** | Middleware và wrapper DB tăng bộ đếm theo `requestId`. `GET /__metrics?rid=`, `POST /__metrics/reset` | Chính xác từng request, rẻ, có kết quả ngay | Tự báo cáo: wrapper bỏ sót một đường query là đếm sai mà không biết |
| **B. Log có cấu trúc (JSON lines)** | Mỗi sự kiện ghi một dòng `{ts, rid, service, kind: "http-in\|http-out\|db\|cache-hit", target, durationMs}`. Script parse log ra bảng | Vừa đếm vừa là **trace thô** (dựng được N+1 trace và call graph), có sẵn file để nộp làm evidence | Phải viết script parse. Log nhiều có thể ảnh hưởng thời gian |
| C. OpenTelemetry + Jaeger | Auto-instrument HTTP và DB driver, xem trace trên UI | Chuẩn công nghiệp, waterfall nội bộ đẹp | Setup lâu so với 65 phút. Exporter và sampling làm nhiễu timing |
| D. Đếm ở tầng DB | SQLite `db.on('trace')` hoặc `verbose`, Postgres `log_statement=all` / `pg_stat_statements` | Ground truth, độc lập với code app | Khó gắn với từng request (cần thêm comment `/* rid=… */` vào SQL, kiểu sqlcommenter) |
| E. Browser DevTools / HAR | Export HAR từ DevTools hoặc Playwright | Ground truth phía client, là nguồn của waterfall | Chỉ thấy phía client |

**Đề xuất: B làm nguồn chính** (đếm và trace), cộng thêm:

- **D để kiểm chứng một lần**: so số query của B với log DB trên một lần chạy, để chứng minh instrumentation không bỏ sót.
- **E cho số client request** và waterfall.
- Chạy đo **tuần tự, không đồng thời**, và reset/đánh dấu giữa các lần, để mọi dòng log thuộc đúng một `rid`.
- BFF/GraphQL **truyền tiếp `X-Request-Id`** xuống service. Ở baseline, server tự sinh `rid` hoặc nhận qua query `?rid=`, vì custom header gây preflight và làm tăng số request.

### 3.3 Bảng giả thuyết (đo thật để xác nhận hoặc bác bỏ)

| Biến thể | Client req | User call / DB | Order call / DB | Product call / DB |
|---|---|---|---|---|
| Baseline B1 | 3 | 1 / 1 | 1 / 1 | 1 / 1 |
| Baseline B2 (naive) | 2 + N | 1 / 1 | 1 / 1 | N / N |
| BFF web | 1 | 1 / 1 | 1 / 1 | ⌈K/B⌉ / ⌈K/B⌉ |
| BFF mobile | 1 | **0** / 0 | 1 / 1 | ⌈K/B⌉ / ⌈K/B⌉ |
| GraphQL web, N+1 | 1 | 1 / 1 | 1 / 1 | **N / N** |
| GraphQL web, đã sửa | 1 | 1 / 1 | 1 / 1 | ⌈K/B⌉ / ⌈K/B⌉ (dedup N → K) |
| GraphQL mobile, đã sửa | 1 | 0 / 0 | 1 / 1 | ⌈K/B⌉ / ⌈K/B⌉ |

Tiêu chí đạt "số call tới Product không tăng theo số đơn": với `K ≤ B`, Product call bằng 1 ở cả `u_small` và `u_large`.

### 3.4 Format bảng đo thô (mỗi lần chạy là một dòng)

```
run_id, variant, client, dataset, mode(cold|warm), run_no, rid,
client_requests, preflight, user_calls, order_calls, product_calls, cache_hits,
user_db, order_db, product_db, t_complete_ms, t_data_ms, payload_bytes(gzip|raw)
```

Báo median và min–max theo nhóm `(variant, client, dataset, mode)`. Cold chỉ có 1 lần mỗi lượt restart, nên muốn có ≥ 5 mẫu cold phải restart ≥ 5 lần.

---

## 4. Cách xác định "màn hình hoàn tất"

### 4.1 Định nghĩa nội dung

Màn hình **web** hoàn tất khi DOM đã hiển thị: tên user, và đủ N dòng đơn, mỗi dòng có tên product (hoặc **marker lỗi** theo policy ở mục 5). Màn hình **mobile** hoàn tất khi đủ N dòng gồm mã đơn, trạng thái, tên product và thẻ ảnh.

### 4.2 Option đo mốc kết thúc

| Option | Cách làm | Ưu | Nhược |
|---|---|---|---|
| **A. Mark tự định nghĩa sau render** | Response cuối về, render xong, chờ 2 lần `requestAnimationFrame`, rồi `performance.mark('screen-complete')` | Đúng ngữ nghĩa "dữ liệu đã hiện", giống nhau giữa các biến thể, đọc tự động được | Do app tự khai báo: đặt mark sai chỗ là đo sai |
| B. A + chờ ảnh thumbnail load xong | Đặt mark sau khi mọi `<img>` gọi `onload`/`onerror` | Gần với cảm nhận người dùng (nhất là mobile) | Thời gian ảnh giống nhau giữa các biến thể, chỉ thêm nhiễu và che mất khác biệt cần đo |
| C. Chỉ số trình duyệt (`load`, LCP) | Dùng API có sẵn | Chuẩn | `load` có thể bắn trước khi fetch xong. LCP không phản ánh "đủ N dòng" |
| D. Observer theo DOM | `MutationObserver` chờ đủ `[data-order-row]` bằng số kỳ vọng | Kiểm chứng độc lập với code render | Script đo phải biết trước N |
| E. Chỉ đo thời gian API ở server | Đo TTLB của response | Đơn giản | Không phải "màn hình". Baseline có nhiều request nên không so sánh được |

**Đề xuất: A làm số chính.** Dùng D trong script Playwright để xác nhận mark đặt đúng lúc (số dòng phải đủ). Ghi B như số phụ, không dùng để so sánh.

### 4.3 Mốc bắt đầu

| Option | Ưu | Nhược |
|---|---|---|
| `performance.timeOrigin` (bắt đầu điều hướng) | Bao trọn trải nghiệm | Có cả thời gian tải HTML/JS. Phần này giống nhau giữa các biến thể nhưng làm loãng chênh lệch |
| **Mark `data-start` ngay trước `fetch` đầu tiên** | Cô lập phần composition | Bỏ qua phần tải trang |

**Đề xuất:** báo cả hai.

- `t_complete` = `screen-complete − timeOrigin`
- `t_data` = `screen-complete − data-start`

So sánh biến thể chủ yếu bằng `t_data`.

### 4.4 Điều kiện chạy

| Vấn đề | Option | Đề xuất |
|---|---|---|
| Tự động hoá | Bấm tay, đọc DevTools / **Playwright script** | **Playwright**. Mỗi lần chạy mở context mới, đọc `performance.getEntriesByName`, export HAR (để dựng waterfall) |
| Cold | Restart tất cả service (và GraphQL/BFF), mở browser context mới, chạy lần 1 | Như bên cạnh. Lần 1 sau restart là cold |
| Warm | Giữ process, chạy lần 2..n | Báo riêng, không trộn với cold |
| Cache trình duyệt | Để nguyên / tắt | **Tắt** (`no-store` + context mới). Cold/warm chỉ phản ánh phía server |
| Độ trễ mạng | Không có (localhost) | Localhost gần như không có RTT, nên lợi ích của việc giảm số request bị **đánh giá thấp** |
| | **Thêm throttling phía client** (CDP `Network.emulateNetworkConditions`, vd. RTT 100 ms) | **Đo cả hai**: không throttle và có throttle. Throttle chỉ áp cho đoạn client → server, đúng đoạn mà BFF/GraphQL tiết kiệm |
| Waterfall | HAR (client) và log `rid` (nội bộ) | Vẽ waterfall client từ HAR, kẻ vạch dọc tại `screen-complete`. Call graph nội bộ của BFF dựng từ log mục 3 |

---

## 5. Policy lỗi khi Product Service chậm hoặc lỗi

### 5.1 Cách gây lỗi (fault injection)

| Option | Ưu | Nhược | Đề xuất |
|---|---|---|---|
| Env var `FAULT=delay:2000` | Đơn giản | Phải restart, nên mất trạng thái warm | |
| **Admin endpoint `POST /__fault`** | Bật/tắt khi đang chạy, script đo tự điều khiển được | Phải chặn ở môi trường thật | **Chọn** |
| Proxy (toxiproxy) | Không sửa code service | Thêm một thành phần | Ngoài phạm vi |

Các kịch bản cần đo, mỗi kịch bản cho cả web và mobile, BFF và GraphQL:

1. `delay` **dưới** timeout (vd. 300 ms): dữ liệu vẫn đủ, chỉ chậm hơn.
2. `delay` **trên** timeout (vd. 3000 ms, timeout = 1000 ms): xử lý như lỗi.
3. `error` 500 với tỉ lệ 100%.
4. (tuỳ chọn) `hang`, không bao giờ trả lời: kiểm tra timeout có thật sự cắt.

Không dùng lỗi ngẫu nhiên nếu không cố định seed, vì kết quả sẽ không lặp lại được.

### 5.2 Timeout và retry (chung cho BFF và GraphQL)

| Quyết định | Option | Trade-off | Đề xuất |
|---|---|---|---|
| Timeout gọi Product | Không có / có (`AbortController`) | Không có timeout thì màn hình treo theo Product | **1000 ms** |
| Retry | 0 / 1 lần có backoff | Retry tăng số service call và thời gian khi Product chết hẳn | **0 retry**, để số call dễ giải thích. Nếu có retry thì mỗi attempt tính 1 call |
| Circuit breaker | Có / không | Hữu ích khi tải cao | Ngoài phạm vi |

### 5.3 Hai policy được phép

#### P1. Thất bại toàn bộ (fail-fast)

- **BFF:** `503`/`504` với body `{ "error": { "code": "PRODUCT_UNAVAILABLE" | "PRODUCT_TIMEOUT", "message": "..." } }`.
- **GraphQL:** `data` là `null` (hoặc `data.user` là `null`), kèm `errors[]` có `extensions.code`. Cách làm: khai báo `product: Product!` để `null` lan lên trên, hoặc ném lỗi ở resolver gốc.
- **Client:** màn hình lỗi và nút "Thử lại". Màn hình vẫn có mốc hoàn tất, là lúc lỗi được hiển thị.

| Ưu | Nhược |
|---|---|
| Đơn giản, không có trạng thái nửa vời. Client dễ xử lý, đối chiếu dữ liệu dễ (có hoặc không) | Product chỉ cung cấp tên và ảnh nhưng lỗi một chỗ là mất cả dashboard. Availability của màn hình ≈ tích availability của 3 service |
| HTTP status phản ánh đúng sự cố, monitoring và alert dễ | Với GraphQL, null lan theo non-null là hành vi "ngầm", khó thấy khi đọc schema |
| | Thông tin đơn có sẵn vẫn bị bỏ đi |

#### P2. Trả dữ liệu một phần có đánh dấu lỗi (partial)

- **BFF:** `200`, `orders[i].product = null`, kèm
  `"errors": [ { "code": "PRODUCT_UNAVAILABLE", "path": ["orders", 3, "product"], "message": "..." } ]`,
  và header `X-Partial-Response: true`.
- **GraphQL:** `product: Product` (nullable). Resolver trả `null` và ghi lỗi vào `errors[]` với `path` cùng `extensions.code`. Đây là hành vi gốc của GraphQL.
- **Client:** hiển thị user và đơn bình thường. Ô sản phẩm hiện **"Không tải được thông tin sản phẩm"** (kiểu chữ hoặc biểu tượng rõ là lỗi). **Không** tự điền tên/giá giả, không để trống như thể không có dữ liệu.

| Ưu | Nhược |
|---|---|
| Degrade gracefully: user vẫn xem được trạng thái và tổng tiền đơn | Client phức tạp hơn, phải xử lý `null` ở mọi chỗ dùng product |
| Khớp ngữ nghĩa GraphQL (`data` + `errors` cùng lúc), BFF bắt chước cùng shape | HTTP `200` che sự cố, cần log/metric riêng để thấy lỗi |
| Lỗi theo từng item: một product `notFound` không kéo theo cả màn hình | Nếu có cache ở client hoặc CDN, có thể vô tình lưu response "một nửa" |
| | Đối chiếu dữ liệu phải có thêm quy tắc cho trường hợp partial |

Chọn sub-option nếu đi theo P2:

| Câu hỏi | Option | Đề xuất |
|---|---|---|
| HTTP status của BFF | `200` / `206` (sai nghĩa: 206 dành cho Range) / `207` (WebDAV) | **`200` + `errors` + header** |
| Marker đặt ở đâu | Chỉ `errors[]` cấp gốc có `path` / thêm `productError` trong từng order | **`errors[]` có `path`**, giống GraphQL, nên một hàm đối chiếu dùng được cho cả hai |
| Batch lỗi | Cả chunk lỗi thì mọi product trong chunk là `null` | Đúng như vậy. Ghi chú: batch biến "lỗi từng item" thành "lỗi cả nhóm" |
| Giá trị cũ (stale cache) | Có / không | **Không**. Đề chỉ cho chọn 1 trong 2 policy và cấm giá trị giả. Stale chỉ chấp nhận được nếu đánh dấu rõ, và nằm ngoài phạm vi |

#### Đề xuất

**P2 (partial).** Lý do:

- Product chỉ bổ sung thông tin hiển thị. Trạng thái và tổng tiền đơn vẫn có giá trị khi Product lỗi.
- GraphQL hỗ trợ partial tự nhiên, BFF dùng cùng shape `errors[{code, path}]` thì hai biến thể nhất quán.

Nếu nhóm muốn ít rủi ro khi demo và ít code client, chọn **P1** cũng hợp lệ. Khi đó cần nêu rõ trade-off về availability. **Dù chọn gì, BFF và GraphQL phải dùng cùng một policy, cho cả web và mobile.**

### 5.4 Kết quả cần ghi cho phần lỗi

Với mỗi kịch bản (delay < timeout, delay > timeout, 500) × (BFF, GraphQL) × (web, mobile), ghi:

- HTTP status và có `errors` hay không
- `t_data` và `t_complete`
- Số product call (bao gồm attempt bị timeout)
- Ảnh chụp màn hình trạng thái lỗi
- Xác nhận **không có tên/giá giả** trong response (script kiểm tra: mọi `product` hoặc là object lấy từ Product DB, hoặc là `null` kèm lỗi có `path` tương ứng)

---

## 6. Checklist chốt quyết định (chép sang `plan.md`)

| # | Quyết định | Lựa chọn của nhóm | Lý do (nhóm tự viết) |
|---|---|---|---|
| 1 | Quan hệ order–product | ☐ A (1–1) ☐ B (order_items) | |
| 2 | Nguồn giá | ☐ Product ☐ Snapshot | |
| 3 | DB | ☐ SQLite ☐ Postgres | |
| 4 | Dữ liệu small/large (N, K) | small: N=__, K=__ / large: N=__, K=__ | |
| 5 | Batch Product | ☐ GET ?ids= (B=__) ☐ POST | |
| 6 | Shape mobile | ☐ Lồng (giống GraphQL) ☐ Phẳng | |
| 7 | Root GraphQL cho mobile | ☐ `ordersByUser` ☐ `user.orders` | |
| 8 | Bật/tắt N+1 | ☐ Env var ☐ Hai endpoint | |
| 9 | Baseline | ☐ B1 (batch) ☐ B2 (naive) ☐ cả hai | |
| 10 | Cơ chế đếm | ☐ Log JSON ☐ Counter ☐ OTel, kiểm chứng bằng ☐ DB log ☐ HAR | |
| 11 | Mốc hoàn tất | ☐ Mark sau render ☐ + ảnh, bắt đầu từ ☐ timeOrigin ☐ data-start | |
| 12 | Throttle mạng | ☐ Không ☐ Có (RTT=__ ms) ☐ cả hai | |
| 13 | Timeout / retry | timeout=__ ms, retry=__ | |
| 14 | Policy lỗi | ☐ P1 fail toàn bộ ☐ P2 partial | |

## 7. Giới hạn của phép đo (ghi sẵn để bổ sung khi có số thật)

- Mọi thứ chạy trên localhost. RTT gần 0 nên chênh lệch giữa 3 và 1 request bị thu nhỏ, cần đọc kết quả cùng số liệu có throttle.
- "Cold" với SQLite vẫn có cache trang của OS. Muốn cold thật phải khởi động lại máy hoặc dùng Postgres có restart container.
- Logging/instrumentation tự thêm overhead, và overhead đó như nhau giữa các biến thể nhưng không bằng 0.
- 5 lần chạy chỉ cho thấy xu hướng, không đủ để kết luận thống kê.
- Không phân trang, không đo khi có tải đồng thời, không có auth. Kết quả không đại diện cho production.
