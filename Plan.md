# PLAN — BLOCK 04: SERVER-TO-SERVER AUTHENTICATION & JWT

> **Trạng thái:** REVISED TECHNICAL PLAN — ưu tiên tổ chức demo thành **2 luồng end-to-end**; triển khai phải được đối chiếu lại theo kế hoạch này.  
> **Ngày cập nhật kế hoạch:** 15/10/2026  
> **Đề gốc:** https://pub.nndkhoa9.win/webadv/w3/block-04-assignment.html  
> **Phạm vi:** **100% mục tiêu bắt buộc + toàn bộ phần mở rộng** (HMAC, chữ ký bất đối xứng, `kid`, zero-downtime key rotation, login/access JWT, refresh rotation, family revocation, logout).  
> **Tiêu chí kiến trúc:** 5 process runtime; so sánh trực tiếp Baseline vs Secure; demo và evidence chạy thật, tái lập được.

---

## 1. Mục tiêu và tiêu chí thành công

Xây dựng và đối chiếu trực tiếp **hai luồng end-to-end dùng cùng payload nghiệp vụ**:

1. **Baseline End-to-End:** `Client -> Order v1 -> Inventory v1`, không access JWT và không request signature.
2. **Full Security End-to-End:** `Login -> Access JWT -> Order v2 -> signed request -> Inventory v2 -> reservation -> Client`.

Luồng Full Security bảo vệ hai ranh giới độc lập:

1. **Client -> Order API:** Access JWT đại diện cho **người dùng**.
2. **Order API -> Inventory:** HMAC-SHA256 **hoặc** Ed25519 đại diện cho **service Order**, độc lập với JWT.

Cần chứng minh:

- Baseline không có bảo mật: gọi thẳng Inventory có thể tạo reservation/trừ kho; gọi Order không cần JWT.
- Secure từ chối request gọi Inventory không hợp lệ, bị chỉnh sửa, replay, timestamp quá hạn, `kid` lạ, sai khóa; request hợp lệ chỉ giữ hàng **một lần**.
- Đăng nhập thành công phát access JWT 120 giây, JWT sai/thiếu/hết hạn/`alg=none` bị từ chối.
- Có cả **HMAC** và **Ed25519**; đổi khóa Ed25519 từ `ed-1` sang `ed-2` theo đúng thứ tự **nạp public key mới -> chuyển signing key -> gỡ public key cũ** mà không gián đoạn request hợp lệ.
- Dashboard chỉ có hai luồng chính; HMAC/Ed25519 là preset bên trong Full Security, còn key rotation là một scenario stateful của Full Security, không phải luồng cấp cao thứ ba.
- Mỗi lần chạy phải hiển thị tuần tự từng HTTP exchange, chỉ rõ ai gửi request, ai trả response, status thực tế và state trước/sau.
- Refresh token là token ngẫu nhiên, DB chỉ lưu hash; mỗi refresh xoay token; tái sử dụng token cũ thu hồi toàn bộ family; logout thu hồi family.
- Có script kiểm thử, log và evidence minh họa kết quả thực tế. Không dùng câu trả lời của coding agent làm minh chứng.

**Phạm vi loại trừ có chủ ý:** không làm benchmark REST vs gRPC (đó là trọng tâm Block 03); không triển khai OAuth provider bên ngoài; không tạo Auth Server riêng; không cần Docker/Kubernetes/Redis để hoàn tất bài lab.

---

## 2. Technical stack — CHỐT

| Hạng mục | Công nghệ / quyết định chốt | Lý do |
|---|---|---|
| Runtime | **Node.js 24.x** (khuyến nghị >=24.10) | Tiếp nối dự án Node/TypeScript, có `node:crypto` và `child_process` |
| Ngôn ngữ | **TypeScript 5.9+**, bật `strict` | Type-safe, tái sử dụng code Block 03 |
| Module | **ESM** (`"type": "module"`) | Nhất quán với `tsx`/Node hiện đại |
| Backend HTTP | **Fastify 5** | Schema, hooks, logging, hiệu năng tốt |
| Giao tiếp Order -> Inventory | **HTTP REST + JSON (chốt một protocol)** | Quan sát/can thiệp request và tạo negative test dễ nhất; đề cho chọn REST hoặc gRPC |
| Validate DTO / input | **Zod 4** hoặc JSON Schema Fastify; **chốt Zod 4 cho business DTO** | Ràng buộc kiểu và từ chối thuộc tính lạ |
| JWT | **jose 6** với **HS256** và key **riêng cho access JWT** | `SignJWT`, `jwtVerify`, whitelist alg, kiểm `iss/aud/exp`; không tự viết JWT |
| Password hash | **bcryptjs 3** (`bcrypt`, cost cấu hình, lab mặc định 12) | Phù hợp đề (bcrypt/argon2id), dễ cài trên Windows |
| Request HMAC | **Node `node:crypto` HMAC-SHA256** | Library chuẩn, so sánh bằng `timingSafeEqual` |
| Request bất đối xứng | **Node `node:crypto` Ed25519** | Dễ sinh 2 cặp khóa; Inventory chỉ cần public key |
| Random/Hash | **`crypto.randomBytes`, `randomUUID`, SHA-256** | Nonce và refresh token đủ entropy |
| Database | **SQLite + better-sqlite3 12** | Không tạo thêm process DB; transaction đồng bộ để tránh double refresh/replay |
| Dashboard | **React 19 + Vite 7 + TypeScript** | Trình bày 2 luồng end-to-end, timeline request/response và bảng đối chiếu |
| UI | **CSS thuần** (responsive), không bắt buộc thư viện UI | Giảm phụ thuộc; chú trọng bảng, badge và log |
| Supervisor | **Fastify + `child_process.fork/spawn` + IPC** | Quản lý 4 worker, collect stdout/stderr, điều khiển mode và rotation |
| Log | **Pino** (logger mặc định Fastify), JSON structured | Lọc theo process/request/test; redaction token/key |
| Testing | **Vitest 4** + script integration/e2e TypeScript dùng native `fetch` | Có các test độc lập, có thể xuất JSON evidence |
| Package manager | **npm** + `package-lock.json`, `npm ci` | Chạy lại đơn giản trên Windows/CI |
| Local deployment | **Chạy trực tiếp Windows 11 / Linux**, 5 runtime process | Dễ thao tác demo trong một máy |

**Chính sách version:** Bảng trên chốt **major/minor mục tiêu**; khi bootstrap, cài phiên bản tương thích thực tế, kiểm tra `npm ls` và **khóa phiên bản chính xác trong `package-lock.json`**. Không tự giả định các package đã được cài, không nâng major sau khi chốt plan nếu chưa kiểm thử.

### Vì sao chọn REST thay vì gRPC cho Block 04?

- Đề gốc cho phép **một trong hai**. Với toàn bộ phần mở rộng bảo mật và thời lượng lab, REST giúp dễ quan sát request headers, raw/canonical body, `401`, cookie và replay test.
- **Không phải dựng cả hai transport** để đáp ứng yêu cầu Block 04. Dự án Block 03 có thể được tận dụng về nghiệp vụ, logging và supervisor, nhưng REST là đường giao tiếp nội bộ chính thức của kế hoạch này.
- Nếu cần giữ gRPC từ Block 03, đó là một nhánh bổ sung **sau khi toàn bộ acceptance test REST đã xanh**; khi đó `UNAUTHENTICATED` thay vì HTTP 401.

---

## 3. Kiến trúc runtime: chính xác 5 process

```text
                       Browser / Demo operator
                                |
                                v
            +--------------------------------------------+
            | P5  SUPERVISOR + DASHBOARD                 |
            | http://127.0.0.1:3000                     |
            | Process manager / test runner / evidence  |
            +------------------+-------------------------+
                      |       |       |       |
       ----------------       |       |       ----------------
       v                       v      v                      v
 +--------------+     +---------------+   +--------------+  +----------------+
 | P1 Order v1  |---->| P2 Inv v1     |   | P3 Order v2  |->| P4 Inv v2      |
 | :3001        |     | :5001         |   | :3002        |  | :5002          |
 | no JWT       |     | no signature  |   | JWT + refresh|  | HMAC/Ed25519   |
 +--------------+     +---------------+   | signer       |  | nonce + kid    |
                                         +--------------+  +----------------+
                  BASELINE                          SECURE + EXTENSIONS
```

| Process | Chức năng thực tế | Database |
|---|---|---|
| P1 — Order v1 | `POST /orders` chưa có JWT; gọi P2 | `data/baseline-order.sqlite` |
| P2 — Inventory v1 | Nhận `/internal/reservations` không chữ ký; lưu tồn kho/reservation | `data/baseline-inventory.sqlite` |
| P3 — Order v2 | Login, JWT, refresh/logout; ký request nội bộ HMAC/Ed25519 | `data/secure-order.sqlite` |
| P4 — Inventory v2 | Kiểm HMAC/Ed25519, `kid`, nonce, timestamp; quản lý tồn kho | `data/secure-inventory.sqlite` |
| P5 — Supervisor | Start/stop/reset workers, runner, UI, gom log và kết quả; không xử lý nghiệp vụ | File evidence; không cần DB riêng |

**Ràng buộc process:** Dashboard React được `vite build` trước và **serve static từ P5**, không chạy Vite dev server trong buổi demo; SQLite embedded không tính là process. CLI chạy test theo yêu cầu là tiến trình ngắn hạn, không phải service nền thứ sáu.

**Tách dữ liệu tuyệt đối:** P1/P2 và P3/P4 dùng DB riêng. Seed cùng SKU và stock ban đầu để so sánh công bằng. Mỗi test có fixture/reset được ghi lại.

**Phạm vi truy cập:** Các process bind `127.0.0.1` trong lab; nếu muốn mô phỏng "máy khác gọi Inventory" thì dùng script gọi trực tiếp cổng P2/P4 từ terminal, **không phải mở cổng lên Internet**.

### 3.1 Hai luồng end-to-end chính

Dashboard và test runner chỉ có **hai flow ID cấp cao**:

| Flow ID | Tên hiển thị | Đường đi | Mục đích |
|---|---|---|---|
| `baseline-e2e` | Baseline End-to-End | Client -> Order v1 -> Inventory v1 -> Order v1 -> Client | Chứng minh nghiệp vụ chạy được nhưng hai boundary chưa được bảo vệ |
| `secure-e2e` | Full Security End-to-End | Login -> JWT -> Order v2 -> HMAC/Ed25519 -> Inventory v2 -> Order v2 -> Client | Chứng minh nghiệp vụ vẫn chạy khi cả user boundary và service boundary đều được bảo vệ |

#### A. Baseline End-to-End

Một lần bấm chạy phải tạo một `runId`/`traceId` và ghi đủ các exchange:

1. `Client -> Order v1`: `POST /orders`, không có `Authorization`.
2. `Order v1 -> Inventory v1`: `POST /internal/reservations`, không có signature headers.
3. `Inventory v1 -> Order v1`: `201` kèm `reservationId`, hoặc `409` nếu thiếu stock.
4. `Order v1 -> Client`: response nghiệp vụ cuối cùng.

Dashboard phải hiện request/response của từng hop, stock/reservation trước và sau, đồng thời gắn nhãn rõ **Security OFF**. Security OFF ở đây có nghĩa là định tuyến sang cặp P1/P2 baseline; **không tắt kiểm tra bảo mật của P3/P4**.

#### B. Full Security End-to-End

Một lần bấm chạy dùng preset signing hiện tại và ghi đủ các exchange:

1. `Browser -> Order v2 /auth/login`: username và password đã redacted trong evidence.
2. `Order v2 -> Browser`: access JWT 120 giây và refresh cookie HttpOnly, đều được mask.
3. `Client -> Order v2 /orders`: gửi access JWT bằng Bearer header.
4. Order v2 xác minh JWT, tạo `orderId`, canonicalize payload và ký request nội bộ.
5. `Order v2 -> Inventory v2 /internal/reservations`: gửi signature metadata theo preset HMAC hoặc Ed25519.
6. Inventory v2 kiểm algorithm, `kid`, timestamp, nonce, signature và replay trước khi mutation.
7. `Inventory v2 -> Order v2`: trả `reservationId` hoặc lỗi nghiệp vụ/xác thực.
8. `Order v2 -> Client`: trả kết quả order cuối cùng.

Dashboard phải gắn nhãn **Security ON**, hiện rõ access JWT dùng ở user boundary và service signature dùng ở internal boundary là hai credential khác nhau.

#### C. Preset thuật toán trong Full Security

`secure-e2e` có hai preset có thể đổi qua lại trước mỗi lần chạy:

| Preset | Order v2 ký bằng | Inventory v2 xác minh bằng | `kid` |
|---|---|---|---|
| `hmac-sha256` | Shared secret HMAC | Cùng shared secret | `hmac-lab-1` |
| `ed25519` | Ed25519 private key | Ed25519 public key | `ed-1` hoặc `ed-2` |

Đây là **đổi thuật toán ký/xác minh**, không gọi là đổi hash key. HMAC-SHA256 là đối xứng; Ed25519 là chữ ký bất đối xứng. Supervisor phải chuyển signer và verifier về cùng preset qua IPC trước khi runner phát request; không được để trạng thái lệch như Order ký HMAC nhưng Inventory chỉ chấp nhận Ed25519.

#### D. Scenario rotation bên trong Full Security

Rotation chỉ áp dụng cho preset Ed25519 và là một scenario stateful của `secure-e2e`:

1. **Initial:** chạy Full Security E2E bằng `ed-1`, phải thành công.
2. **Prepare:** Inventory nạp public key `ed-2`, vẫn trust `ed-1`; chạy lại bằng `ed-1`, phải thành công.
3. **Switch:** Order đổi signer sang private key `ed-2`; chạy lại Full Security E2E, phải thành công và không restart worker.
4. **Retire:** sau grace/in-flight check, Inventory gỡ `ed-1`; request mới ký `ed-1` phải `401`, request `ed-2` vẫn phải `201`.

Timeline rotation phải giữ request/response của từng lần chạy, `activeSigningKid`, `trustedKids`, PID trước/sau và tổng số valid request bị từ chối. Tiêu chí thành công là PID không đổi và **0 valid request bị reject** trong Prepare/Switch.

---

## 4. Hợp đồng API — CHỐT

### 4.1 Order API (baseline và secure)

| Method & route | P1 Baseline | P3 Secure | Response dự kiến |
|---|---|---|---|
| `POST /orders` | Không cần JWT | Bắt buộc `Authorization: Bearer <accessJWT>` | `201` nếu đủ hàng, `409` nếu thiếu hàng, `401` nếu không xác thực |
| `GET /health` | Có | Có | `200` |
| `POST /auth/login` | Không có | Có | `200` + access JWT; set refresh cookie |
| `POST /auth/refresh` | Không có | Có | `200` + access JWT mới; set refresh cookie mới |
| `POST /auth/logout` | Không có | Có | Thu hồi family, clear cookie |
| `GET /auth/me` | Không có | Có | Thông tin công khai của user từ JWT hợp lệ |

Payload `POST /orders`:

```json
{ "sku": "SKU-001", "quantity": 2 }
```

Payload login:

```json
{ "username": "demo", "password": "<password supplied at runtime>" }
```

Body trả về lỗi authentication chỉ nên chứa `code: "UNAUTHORIZED"` và thông báo chung, **không tiết lộ vì sao chữ ký/JWT thất bại**. Chi tiết nằm ở log an toàn phía server.

### 4.2 Inventory (baseline và secure)

- `POST /internal/reservations` với JSON `{ "sku": "SKU-001", "quantity": 2, "orderId": "..." }`.
- P2 **không yêu cầu** chữ ký; P4 **bắt buộc** kiểm chữ ký trước khi tạo reservation.
- `201` reservation mới; `409` hết hàng; `401` authentication failure ở P4.
- `GET /health` cho Supervisor; read-only metrics nội bộ được cung cấp qua test runner hoặc admin IPC, không mở public mutation API.

### 4.3 Route của Supervisor

- `GET /` — Dashboard (bundle static đã build).
- `GET /api/processes` — health + PID + port + mode (không có secret).
- `POST /api/flows/run` — chạy một trong hai flow whitelist `baseline-e2e` hoặc `secure-e2e`; secure nhận preset `hmac-sha256`/`ed25519`.
- `POST /api/tests/run` — chạy riêng một negative/stateful test case đã whitelist; đây là công cụ kiểm tra nâng cao, không thay thế hai flow chính.
- `GET /api/evidence` — danh sách bằng chứng đã xuất (đã redacted).
- `GET /api/logs/stream` — SSE event stream được Supervisor gom từ 4 worker.
- `POST /api/demo/reset` — reset seed dữ liệu lab, chỉ local và có confirm tại UI.
- `POST /api/demo/signing-mode` — đổi preset HMAC/Ed25519 của Full Security, cập nhật đồng bộ signer/verifier bằng **IPC**.
- `POST /api/demo/rotation/*` — chạy Initial/Prepare/Switch/Retire của scenario Ed25519 rotation, qua **IPC**.

Các route admin của Supervisor **chỉ dùng ở lab**: bind localhost, bảo vệ bằng admin session hoặc token ngẫu nhiên cục bộ, kiểm Origin, không bật CORS tùy tiện. Không tạo endpoint công khai ở Inventory để thay khóa.

---

## 5. Request Signing: quy ước canonical và thuật toán

### 5.1 Chốt format

- Chỉ ký các trường đã được schema validate (`sku`, `quantity`, `orderId`). **Cấm unknown fields** ở Inventory.
- Serialize JSON canonical theo **thứ tự cố định**: `JSON.stringify({sku, quantity, orderId})`, không tự trim/biến đổi các giá trị sau khi ký. Client và Inventory dùng **cùng một module** canonicalization.
- `bodyHash = hex(SHA256(UTF8(canonicalBody)))` (lowercase hex).
- `timestamp` là **Unix epoch giây**, dạng số nguyên trong chuỗi ASCII.
- `nonce` = `crypto.randomUUID()` mới cho **mỗi request attempt**, không tái sử dụng.
- `kid` chỉ khóa xác minh; `algorithm` là `hmac-sha256` hoặc `ed25519`.

**Canonical string UTF-8 chính xác** (mỗi dòng kết thúc `\n`, **không thêm newline ở cuối**):

```text
v1
POST
/internal/reservations
<algorithm>
<kid>
<timestamp-seconds>
<nonce>
<bodyHash-hex>
```

Ví dụ dữ liệu mô tả: method `POST`, path `/internal/reservations`, `kid=ed-1`; hash và chữ ký **phải do script thật tạo**, không tự viết giá trị giả vào evidence.

Header truyền P3 -> P4:

```http
X-Auth-Version: v1
X-Signature-Alg: ed25519
X-Key-Id: ed-1
X-Timestamp: 1792020000
X-Nonce: <uuid-generated-at-runtime>
X-Signature: <base64url-signature>
```

- Bên verifier tính lại `bodyHash` từ body **đã parse/validate**, tái tạo canonical string, không tin body hash do client tự báo.
- Từ chối request có security header thiếu, trùng, malformed, alg/kid không được phép.
- Chế độ ký là cấu hình bảo mật được Supervisor chuyển bằng IPC theo test preset; **verifier enforce allowlist tương ứng**, không chấp nhận fallback vô điều kiện từ Ed25519 về HMAC.

### 5.2 HMAC-SHA256

- HMAC secret là biến môi trường **`INTERNAL_HMAC_SECRET_B64`**, random ít nhất 32 bytes; **khác** `ACCESS_JWT_SECRET_B64`.
- P3 dùng `createHmac('sha256', key)` trên canonical string; signature encode base64url.
- P4 decode signature, kiểm length, rồi `timingSafeEqual(expected, received)`; nếu length khác từ chối trước, không so sánh kiểu `===`.
- `kid=hmac-lab-1`, không để `kid` tự động chọn thuật toán khác.

### 5.3 Ed25519 và `kid`

- Sinh **hai cặp** Ed25519: `ed-1`, `ed-2` bằng Node `generateKeyPairSync('ed25519')` hoặc lệnh script dự án.
- P3 chỉ tải private keys thông qua path trong environment; P4 chỉ tải public keys. **Không copy private key sang Inventory**.
- P3 ký `sign(null, UTF8(canonical), privateKey)`; P4 xác minh `verify(null, UTF8(canonical), publicKey, signature)` theo `kid`.
- Thuật toán/kid không có trong allowlist -> 401 trước nghiệp vụ.

### 5.4 Timestamp, nonce, replay, transaction

- P4 từ chối `abs(nowSeconds - timestampSeconds) > 60`.
- Nonce ghi trong bảng `used_nonces` với `nonce PRIMARY KEY`, `seen_at`, `expires_at >= seen_at + 120s`.
- Dùng unique constraint/transaction để chỉ **một** request dùng nonce được ghi nhận; 2 request song song dùng cùng nonce => 1 được xử lý và 1 bị từ chối.
- Chữ ký/timestamp phải hợp lệ **trước** khi consume nonce. Khi xử lý một request đã xác thực, quyết định consume nonce và ghi reservation phải nhất quán/atomic để ngăn race tạo reservation kép.
- Dọn nonce đã hết hạn nhưng không xóa sớm hơn 120 giây. Không nới cửa sổ ±60 giây nhằm dễ demo.
- Log dùng reason codes như `MISSING_SIGNATURE`, `BAD_SIGNATURE`, `BODY_MISMATCH`, `REPLAY_NONCE`, `TIMESTAMP_OUT_OF_WINDOW`, `UNKNOWN_KID`.

---

## 6. Key Rotation không gián đoạn — CHỐT

Làm **4 giai đoạn**, giữ P3/P4 chạy liên tục, không restart worker:

1. **Initial:** P3 active signer `ed-1`; P4 trusted keyring `{ed-1}`. Request `ed-1` thành công.
2. **Prepare:** P4 thêm public key `ed-2` bằng IPC -> keyring `{ed-1, ed-2}`. P3 **vẫn ký `ed-1`**; request không gián đoạn.
3. **Switch:** P3 active signer chuyển sang `ed-2` bằng IPC. P4 vẫn trust hai khóa. Test request mới bằng `ed-2` thành công; request cũ hợp lệ đang in-flight bằng `ed-1` vẫn được nhận.
4. **Retire:** Sau grace period đủ dài để xử lý hết request in-flight và request còn trong timestamp window (**ít nhất >60s hoặc chứng minh không còn request ký `ed-1` trong lab**), P4 xóa `ed-1`. Request mới có `kid=ed-1` bị 401; `ed-2` vẫn thành công.

**Acceptance bổ sung:** phát một luồng request hợp lệ liên tục trong các bước `Prepare`/`Switch`, kết quả **0 request hợp lệ bị từ chối**. `Retire` được chạy sau quãng đệm an toàn; không tuyên bố zero-downtime nếu còn request hợp lệ `ed-1` bị từ chối do gỡ quá sớm.

**Nơi chứa khóa:** `secrets/` và `.env` nằm ngoài git; script `npm run keys:generate` tạo hai cặp và một HMAC secret. `.env.example` chỉ có **tên biến/placeholders**, không có giá trị thật.

---

## 7. Login & Access JWT — CHỐT

- Seed một user demo có mật khẩu **bcrypt**, cost=12 (có thể điều chỉnh theo máy). Không lưu plaintext password trong source/DB.
- `POST /auth/login`: user không tồn tại và password sai **cùng HTTP 401 và cùng response public**, thực hiện dummy hash compare để hạn chế user enumeration bằng timing.
- JWT được phát bằng `jose` với **HS256**; dùng một secret độc lập với HMAC nội bộ.
- Claims bắt buộc: `sub` (user id), `iss=block04-order-api`, `aud=block04-client`, `exp`, và `iat`; có thể thêm `jti` ngẫu nhiên.
- Access TTL **120 giây** theo đề; negative test hết hạn sử dụng **hook cấu hình kiểm thử** để phát token tuổi thọ ngắn, không chỉnh đồng hồ hệ thống và không vô tình nới hạn mặc định.
- P3 xác minh JWT signature và header `alg` allowlist **chỉ `HS256`**, issuer, audience, expiration **trước khi tin claim**. `alg=none` luôn bị từ chối.
- Không dùng JWT của người dùng để ký Order -> Inventory: hai loại credential hoàn toàn độc lập.
- Request có JWT sai/thiếu/hết hạn: HTTP `401` và không gọi Inventory.

---

## 8. Refresh Token, Rotation, Family Revocation, Logout — CHỐT

### 8.1 Định dạng và lưu trữ

- Refresh token = `base64url(randomBytes(32))`, **không phải JWT** (256-bit entropy).
- DB lưu **`SHA256(refreshToken)`**, không lưu raw refresh token. Cần giới hạn log/cookie redaction.
- Cookie refresh: `HttpOnly; SameSite=Lax; Path=/auth; Secure` **khi HTTPS**; lab localhost HTTP có `Secure=false` qua `NODE_ENV=development`, phải ghi rõ đây là ngoại lệ lab.
- Browser giữ access JWT **chỉ trong memory**, gửi dưới Bearer header; **không lưu access/refresh token trong localStorage**.
- Dashboard và trình duyệt truy cập `/api/...` cùng origin P5; Supervisor chỉ proxy/làm trình diễn có kiểm soát, chuyển tiếp `Set-Cookie` chính xác và không ghi token. Script kiểm thử gọi thẳng P3 để không che mất hành vi thực tế.
- Cookie-based refresh/logout phải kiểm `Origin`/CSRF (ngoài SameSite) và chỉ chấp nhận method POST.

### 8.2 Database schema chính

```text
users(id PK, username UNIQUE, password_hash, created_at)
orders(id PK, user_id, sku, quantity, reservation_id, created_at)
refresh_tokens(
  id PK, token_hash UNIQUE, family_id, user_id,
  expires_at, consumed_at NULL,
  revoked_at NULL, replaced_by NULL, created_at
)
used_nonces(nonce PK, seen_at, expires_at)
stock(sku PK, available_qty)
reservations(id PK, sku, quantity, order_id, created_at)
```

`users`, `orders`, `refresh_tokens` đặt tại secure Order DB. `used_nonces`, `stock`, `reservations` đặt tại secure Inventory DB; baseline dùng bảng nghiệp vụ tương đương, không có bảng auth. **Không dùng chung SQLite connection/transaction giữa hai service**; business idempotency và log phải xử lý khả năng Inventory giữ hàng thành công nhưng Order lỗi.

### 8.3 Luồng refresh

1. Login -> Access A + Refresh A (set cookie); DB lưu `hash(A)`, `family_id=F`.
2. `POST /auth/refresh` dùng A -> trong **một transaction** đánh dấu A `consumed_at`, tạo B cùng family F, set `replaced_by=B.id` -> trả Access B + cookie Refresh B.
3. Nếu **A xuất hiện lại** -> trả 401 và `UPDATE ... revoked_at=... WHERE family_id=F AND revoked_at IS NULL`; Refresh B cũng không còn hiệu lực.
4. Nếu request refresh đồng thời dùng cùng A -> chỉ một request thành công (transaction + điều kiện trạng thái), request còn lại trigger reuse logic theo policy.
5. Nếu token unknown/expired/revoked -> 401; không tiết lộ token hash/raw token trong log.

### 8.4 Logout và access JWT sau logout

- `POST /auth/logout` dùng refresh cookie hiện tại -> thu hồi **toàn family**, xóa cookie.
- Thử refresh sau logout -> 401.
- **Policy chốt:** access JWT đã cấp **vẫn hợp lệ đến `exp` tối đa 120 giây** nếu Order chỉ verify offline. Logout không làm access JWT biến mất lập tức. Trình bày rõ trade-off này; không giả vờ access token bị thu hồi tức thời.
- Test logout cần **tạo family mới sau khi test reuse**, tránh nhầm với family đã bị revoke từ test trước.

---

## 9. Supervisor & Dashboard — CHỐT UX

### 9.1 Điều hướng chính chỉ gồm hai flow

1. **Baseline End-to-End — Security OFF**
   - Một nút `Chạy Baseline End-to-End`.
   - Hiện sơ đồ `Client -> Order v1 -> Inventory v1`.
   - Hiện request/response của external hop và internal hop, cùng stock/reservation delta.
2. **Full Security End-to-End — Security ON**
   - Một nút `Chạy Full Security End-to-End`.
   - Có selector `HMAC-SHA256` / `Ed25519` đặt ngay phía trên nút chạy.
   - Có nhóm scenario phụ: negative cases JWT/signature, refresh-family và `Ed25519 Rotation ed-1 -> ed-2`.

Process health, evidence và live log là panel dùng chung, không phải flow/tab cấp cao. Negative test case vẫn có thể chọn và chạy riêng trong phần `Kiểm tra nâng cao` của flow tương ứng.

### 9.2 Trạng thái selector signing

- Chọn `HMAC-SHA256`: Supervisor cấu hình Order v2 ký HMAC và Inventory v2 chỉ xác minh HMAC; dashboard hiện `kid=hmac-lab-1`.
- Chọn `Ed25519`: Supervisor cấu hình Order v2 ký Ed25519 và Inventory v2 chỉ xác minh Ed25519; mặc định `kid=ed-1` nếu chưa chạy rotation.
- Chuyển selector phải có trạng thái `updating`; chỉ cho chạy flow sau khi P3 và P4 cùng báo mode mới.
- Selector không được đổi luồng Baseline và không được làm P3/P4 chấp nhận fallback cả hai thuật toán cùng lúc.
- Sau rotation hoàn tất, selector Ed25519 phải phản ánh `activeSigningKid=ed-2`; chạy lại flow vẫn dùng `ed-2` cho đến khi reset rotation fixture.

### 9.3 Timeline request/response

Mỗi flow result phải có: `runId`, `flowId`, preset, thời gian bắt đầu/kết thúc, state trước/sau và danh sách `exchanges[]` theo thứ tự. Mỗi exchange gồm:

- Số thứ tự và tên bước.
- Request sender -> receiver, method, URL/path, headers/body đã redacted.
- Response sender -> receiver, HTTP status và body đã redacted.
- Expected status, actual status, PASS/FAIL và giải thích ngắn cho các status chủ đích như replay `401`.
- Cùng `traceId` hoặc quan hệ parent/child trace để nối external request với internal reservation request.

Với request lồng nhau, timeline thể hiện rõ `Client -> Order` đang chờ trong lúc `Order -> Inventory` chạy, không gộp hai response vào một mảng HTTP khó hiểu.

### 9.4 Evidence, log và khả năng chạy lại

Toàn bộ log là JSON structured, Supervisor stream SSE ngay trên dashboard; đồng thời có thể ghi `evidence/logs/*.jsonl`. Evidence JSON/Markdown phải nhóm theo hai flow chính, nhưng vẫn giữ Test ID B/S/K/J để truy vết test matrix.

Luồng tự động không chỉ gọi UI; `baseline-e2e`, `secure-e2e --signing=hmac-sha256`, `secure-e2e --signing=ed25519` và rotation phải có script/CLI chạy lại được. Test runner dùng fixture độc lập; không phụ thuộc thứ tự click dashboard, trừ rotation có state machine Initial -> Prepare -> Switch -> Retire đã định nghĩa rõ.

---

## 10. Test matrix đầy đủ — bắt buộc chạy thực tế

> `201/409` là quy ước nghiệp vụ của dự án; `401` là kết quả xác thực thất bại HTTP theo đề. Trước mỗi phép so sánh cần seed cùng stock và lưu số reservation thật. Mỗi test xuất kết quả **actual**, không hardcode PASS.

### 10.1 Baseline (P1/P2)

| ID | Test case | Kỳ vọng |
|---|---|---|
| B01 | `POST /orders`, stock đủ | `201`, tạo order + 1 reservation |
| B02 | `POST /orders`, stock thiếu | `409`, không tạo reservation |
| B03 | Gọi **thẳng P2** từ script, không chữ ký | `201`, stock giảm + reservation tăng (**lỗ hổng**) |
| B04 | Gọi P1 không access JWT | Baseline chấp nhận request đủ hàng |

### 10.2 Internal signing (P4)

| ID | Test case | Kỳ vọng |
|---|---|---|
| S01 | Thiếu chữ ký | `401`, reservation +0 |
| S02 | HMAC signature sai | `401`, reservation +0 |
| S03 | Đổi `quantity` sau khi đã ký | `401`, reservation +0 |
| S04 | Replay **đúng request đã được chấp nhận** (cùng nonce) | Lần 1 `201`, lần 2 `401`, chỉ +1 reservation |
| S05 | Timestamp = now-61s | `401` |
| S06 | Timestamp = now+61s | `401` |
| S07 | HMAC đúng với stock đủ | `201`, +1 reservation |
| S08 | HMAC đúng nhưng stock thiếu | `409`, +0 reservation |
| S09 | Thiếu/trùng security header | `401` |
| S10 | Hai request đồng thời cùng nonce | Tối đa 1 request tạo reservation |
| S11 | Ed25519 đúng `kid=ed-1` | `201`, +1 reservation |
| S12 | `kid` lạ | `401` |
| S13 | `kid=ed-1` nhưng ký bằng private key `ed-2` | `401` |
| S14 | Signature Ed25519 bị sửa | `401` |
| S15 | Alg không được phép/downgrade | `401` |

### 10.3 Key Rotation

| ID | Test case | Kỳ vọng |
|---|---|---|
| K01 | Trước rotation, `ed-1` hợp lệ | Thành công |
| K02 | Nạp public `ed-2`, vẫn ký `ed-1` | Thành công liên tục |
| K03 | Chuyển ký sang `ed-2`, P4 trust cả 2 | Thành công liên tục, 0 rejected valid |
| K04 | Sau grace period, gỡ `ed-1` | `ed-1` -> 401; `ed-2` -> thành công |
| K05 | Trong lúc switch, có request in-flight hợp lệ | Không bị từ chối vì đổi khóa quá sớm |

### 10.4 Login, JWT, Refresh, Logout

| ID | Test case | Kỳ vọng |
|---|---|---|
| J01 | Login đúng | `200`, JWT đủ claims, `exp-iat=120s` (mặc định) |
| J02 | User không tồn tại | `401`, cùng public response với sai password |
| J03 | Sai password | `401` |
| J04 | Gọi P3 `/orders` không bearer | `401`, không gọi P4 |
| J05 | JWT sai chữ ký | `401` |
| J06 | JWT `alg=none` | `401` |
| J07 | JWT hết hạn (test hook) | `401` khi gọi **thẳng P3**, không bị auto refresh |
| J08 | JWT sai `iss` | `401` |
| J09 | JWT sai `aud` | `401` |
| J10 | JWT hợp lệ, stock đủ | `201`, Order dùng chữ ký service hợp lệ để giữ hàng |
| J11 | Refresh A lần 1 | `200`, nhận Access B + Refresh B, A consumed |
| J12 | Replay Refresh A | `401`, cả family F revoked |
| J13 | Dùng Refresh B sau J12 | `401` |
| J14 | Concurrent refresh cùng token | Chỉ 1 thành công, reuse được phát hiện theo policy |
| J15 | Login mới -> logout | Refresh family mới bị revoke, cookie bị xóa |
| J16 | Refresh sau logout | `401` |
| J17 | Access JWT cũ còn hạn sau logout | Còn được nhận tới `exp`, sau `exp` -> 401 (policy offline JWT) |
| J18 | Token hoàn toàn ngẫu nhiên/không biết | `401`, không tiết lộ thông tin |

### 10.5 Acceptance cho hai flow end-to-end

| ID | Flow/scenario | Kỳ vọng |
|---|---|---|
| E2E-B01 | `baseline-e2e` | Client -> Order v1 -> Inventory v1 tạo đúng 1 order và 1 reservation; timeline cho thấy không JWT và không signature |
| E2E-S01 | `secure-e2e`, preset HMAC | Login thành công; JWT hợp lệ; internal request dùng `hmac-sha256/hmac-lab-1`; tạo đúng 1 reservation |
| E2E-S02 | `secure-e2e`, preset Ed25519 | Login thành công; JWT hợp lệ; internal request dùng `ed25519/ed-1` hoặc active kid hiện tại; tạo đúng 1 reservation |
| E2E-S03 | Đổi HMAC -> Ed25519 -> HMAC giữa ba lần chạy độc lập | Cả ba lần thành công; signer/verifier luôn cùng mode; không fallback/downgrade |
| E2E-K01 | Rotation `ed-1 -> ed-2` | Initial/Prepare/Switch không rớt valid request; sau Retire, `ed-1` bị 401 và Full Security E2E bằng `ed-2` vẫn 201 |

Hai flow dùng cùng `sku`, `quantity` và stock seed tương đương, nhưng chạy trên database tách biệt. Evidence phải ghi rõ mỗi request/response thuộc lần chạy nào; không dùng kết quả lịch sử của flow kia để kết luận PASS.

**So sánh trước/sau theo hai boundary:**

- `B03` đối chiếu `S01`: cùng direct call Inventory không chữ ký; baseline giữ hàng, secure không giữ hàng.
- `B04` đối chiếu `J04`: cùng `/orders` không JWT; baseline nhận, secure 401.
- `B01` đối chiếu `J10`: **request hợp lệ** vẫn tạo đúng 1 reservation sau khi thêm xác thực.

---

## 11. Kế hoạch triển khai theo thứ tự (inspect -> plan -> implement -> run -> test -> verify)

### Phase 0 — Inspect & Bootstrap

- [ ] Đọc mã Block 03 hiện có (nếu sử dụng): nghiệp vụ Order/Inventory, Supervisor, log format, fixture.
- [ ] Chốt phạm vi REST-only Block 04 và không phá repo Block 03; tạo branch/thư mục Block 04 riêng.
- [ ] Khởi tạo npm workspace/scripts TypeScript ESM; tsconfig strict; `.env.example`, `.gitignore`, README skeleton.
- [ ] Cài dependencies theo stack; commit lockfile; ghi phiên bản vào evidence (`node -v`, `npm ls --depth=0`).
- [ ] Viết plan này **trước khi sửa code nghiệp vụ**.

**Done when:** `npm ci`, `npm run typecheck`, `npm run build` chạy được trên môi trường demo.

### Phase 1 — Baseline 2 process

- [ ] P2 Inventory v1: stock seed, create reservation, thiếu hàng trả 409.
- [ ] P1 Order v1: POST orders -> gọi P2 -> create order.
- [ ] Script gọi Inventory **bỏ qua Order** và đọc trước/sau stock/reservation.
- [ ] Chụp actual request/response và log B01–B04.

**Done when:** thấy rõ direct call gây +1 reservation ở P2.

### Phase 2 — Secure request signing HMAC

- [ ] Tạo P4 từ business Inventory, P3 từ business Order (tách DB).
- [ ] Cài shared canonicalization, key loading, HMAC signer/verifier.
- [ ] Validate body, signed fields; timestamp ±60s; nonce TTL >=120s; atomic replay guard.
- [ ] Chạy S01–S10; đảm bảo request bị từ chối không mutate stock/reservation.

**Done when:** request hợp lệ giữ hàng 1 lần; replay, sửa body, no-sig đều 401.

### Phase 3 — Login + JWT

- [ ] User store + bcrypt seed; `POST /auth/login`, access JWT 120s.
- [ ] JWT middleware kiểm alg/signature/iss/aud/exp.
- [ ] Bảo vệ `/orders` và `/auth/me`; unified 401 response.
- [ ] Chạy J01–J10, bao gồm `alg=none`, JWT expired bằng test hook.

**Done when:** JWT đúng mới vào business logic; JWT sai không gọi P4.

### Phase 4 — Refresh/Logout (extension)

- [ ] `refresh_tokens` migrations, hash-only storage, random token, cookie policy.
- [ ] Implement rotate transaction, consumed/replaced_by; concurrent refresh.
- [ ] Reuse detection -> family revocation; logout -> family revocation & clear cookie.
- [ ] Kiểm Origin/CSRF; bảo đảm không lưu token trong localStorage/log.
- [ ] Chạy J11–J18.

**Done when:** Refresh A chỉ dùng được một lần, replay A làm B bị revoke; logout và access JWT policy được chứng minh.

### Phase 5 — Ed25519 + kid + key rotation (extensions)

- [ ] Script generate 2 key pairs, load private/public từ environment paths.
- [ ] Ed25519 signer/verifier, `kid` allowlist, strict algorithm mode.
- [ ] Điều khiển keyring và signer bằng IPC, không restart P3/P4.
- [ ] Implement 4-step rotate + safe retire (grace/in-flight tracking).
- [ ] Chạy S11–S15 và K01–K05, xuất timeline.

**Done when:** HMAC và Ed25519 đều chạy; unknown kid sai; switch khóa không rớt request hợp lệ.

### Phase 6 — Supervisor/Dashboard (5th process)

- [ ] Supervisor spawn 4 worker, process ID, health check, restart behavior, graceful shutdown.
- [ ] Phục vụ React bundle với đúng 2 flow chính `Baseline End-to-End` và `Full Security End-to-End` từ port 3000; không cần Vite runtime.
- [ ] Thêm runner `/api/flows/run`, timeline `exchanges[]`, selector HMAC/Ed25519 đồng bộ và scenario rotation Ed25519.
- [ ] Log JSON/SSE, correlation IDs, admin IPC, reset fixture.
- [ ] Gắn nút gọi đúng script test, hiển thị actual expected/status, stock/reservation delta.
- [ ] Export evidence JSON/Markdown **đã mask**; mọi test chạy được từ CLI.

**Done when:** demo người chấm bấm test, thấy kết quả thật và log tương ứng, không phụ thuộc ảnh chụp code.

### Phase 7 — Verify, cleanup, documentation

- [ ] Full run test matrix B/S/K/J; test reset and rerun nhiều lần.
- [ ] Scan `.gitignore`/git diff, không commit secrets, DB chứa token raw, cookie/token trong log.
- [ ] `README.md`: setup, generate keys, env, seed, start, UI, test, rotation, log/evidence, cách reset.
- [ ] Bảng trade-off HMAC vs Ed25519; policy logout; giới hạn lab.
- [ ] Thu thập evidence các testcase thành công **và cả testcase chưa đạt**.
- [ ] Chuẩn bị demo trình bày Problem -> Solution -> Demo -> Evidence -> Trade-off.

**Done when:** clone sạch -> `npm ci` -> generate keys -> seed -> start -> test suite -> evidence khớp dashboard.

---

## 12. Cấu trúc thư mục dự kiến

```text
block-04/
├── Plan.md
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── secrets/                      # gitignored, chỉ chứa key lab sinh tại máy
├── data/                         # gitignored, SQLite runtime
├── src/
│   ├── shared/
│   │   ├── contracts/           # zod DTO, response types
│   │   ├── canonical/           # canonical body, canonical signature string
│   │   ├── signing/             # hmac, ed25519, verifier interfaces
│   │   ├── config/              # zod env validation
│   │   └── logging/             # trace id, redaction
│   ├── baseline/
│   │   ├── order/main.ts
│   │   └── inventory/main.ts
│   ├── secure/
│   │   ├── order/
│   │   │   ├── main.ts
│   │   │   ├── orders.ts
│   │   │   ├── auth/{login,jwt,refresh,logout}.ts
│   │   │   └── signer/key-manager.ts
│   │   └── inventory/
│   │       ├── main.ts
│   │       ├── reservations.ts
│   │       ├── verify-request.ts
│   │       ├── nonce-store.ts
│   │       └── verifier/keyring.ts
│   ├── supervisor/
│   │   ├── main.ts
│   │   ├── process-manager.ts
│   │   ├── test-runner.ts
│   │   ├── evidence-writer.ts
│   │   └── log-stream.ts
│   └── dashboard/
│       ├── index.html
│       ├── main.tsx
│       ├── flows/                    # baseline-e2e và secure-e2e
│       └── components/
├── scripts/
│   ├── generate-keys.ts
│   ├── seed.ts
│   ├── reset-fixtures.ts
│   └── export-evidence.ts
├── tests/
│   ├── baseline.test.ts
│   ├── signing.test.ts
│   ├── key-rotation.test.ts
│   ├── jwt.test.ts
│   └── refresh.test.ts
└── evidence/
    ├── versions.json
    ├── baseline.json
    ├── signing.json
    ├── jwt.json
    ├── refresh.json
    ├── key-rotation.json
    ├── logs/                   # *.jsonl, redacted
    └── summary.md
```

> **Lưu ý:** Tên và đường dẫn trên là **kế hoạch sẽ triển khai**, không hàm ý các file đã có sẵn.

---

## 13. NPM scripts mục tiêu (sẽ implement)

```json
{
  "scripts": {
    "dev": "tsx src/supervisor/main.ts",
    "build": "tsc -p tsconfig.json && vite build",
    "start": "node dist/supervisor/main.js",
    "typecheck": "tsc --noEmit",
    "keys:generate": "tsx scripts/generate-keys.ts",
    "db:seed": "tsx scripts/seed.ts",
    "db:reset": "tsx scripts/reset-fixtures.ts",
    "test": "vitest run",
    "test:evidence": "tsx scripts/export-evidence.ts",
    "demo:all": "tsx scripts/export-evidence.ts"
  }
}
```

Các lệnh này là **giao diện CLI cam kết sẽ hỗ trợ**, chưa phải lệnh đã chạy được. Khi build cần cấu hình riêng để `dist/supervisor/main.js` đúng output của TypeScript và Vite build vào thư mục static được P5 serve. `start` phải spawn P1–P4 từ JS đã compile, **không spawn thêm `tsx` worker khi chạy production build**.

---

## 14. Evidence & sản phẩm cần nộp

| Artifact | Cách tạo/kiểm chứng |
|---|---|
| `README.md` | Lệnh clone, install, key generate, env, seed, start, test, reset, demo |
| `Plan.md` | File này, các quyết định đã chốt **trước implementation** |
| Source code + lockfile | 5 process, các module security, migration, scripts; versions ghi bằng npm |
| Canonical string + ví dụ HMAC/Ed25519 | Script in fixture đầu vào giả + hash + signature được **sinh thật** với key lab (không lộ key) |
| HMAC vs Ed25519 comparison | Nêu ai có thể ký, khả năng giả mạo khi verifier bị lộ khóa, chi phí rotation |
| Negative test evidence | Request metadata đã mask, actual status, timestamp, server reason code, test ID |
| JWT evidence | Payload claims không nhạy cảm và mốc `iat`/`exp`, JWT raw phải mask |
| Reservation before/after | DB query snapshot trước/sau (baseline và secure), stock change |
| Refresh & logout policy | Token A/B dạng **nhãn**, family state, reuse/revoke, access JWT expiry |
| Trade-off & limitations | Offline JWT logout window, SQLite single node, local only, demo hooks, replay cache |
| Slide/demo script | Problem / Solution / Demo / Evidence / Trade-off, chạy request thực |

**Giới hạn bảo mật khi xuất evidence:** Không nộp HMAC secret, JWT secret, private keys, raw JWT, raw refresh tokens; không log password, cookie hoặc đầy đủ `Authorization`. Dùng `token A`, `token B`, `family F`, `kid`, timestamp, hash rút gọn nếu cần.

---

## 15. Checklist nghiệm thu cuối (Definition of Done)

### Runtime và nghiệp vụ
- [ ] Đúng **5 process thường trực**; port 3000/3001/5001/3002/5002, process health xanh.
- [ ] Hệ thống Baseline và Secure có dữ liệu tách biệt, reset/seed được.
- [ ] Đủ hàng tạo đúng 1 reservation; thiếu hàng không trừ stock.

### Bảo mật nội bộ
- [ ] HMAC và Ed25519 có thể chạy theo mode đã chọn, không downgrade ngoài ý muốn.
- [ ] Method/path/timestamp/nonce/body hash/kid/alg đều gắn vào signature.
- [ ] ±60s clock window, nonce >=120s, constant-time HMAC comparison.
- [ ] Thực hiện S01–S15 và K01–K05, có status, log, reservation delta.
- [ ] Rotation thay key live, không restart process và không reject valid in-flight request.

### Xác thực người dùng và session
- [ ] Password bcrypt, login trả lỗi 401 đồng nhất cho user/password sai.
- [ ] JWT HS256, TTL 120s, check `sub/iss/aud/exp` và `alg` allowlist.
- [ ] Refresh random 256-bit, DB hash-only, rotate transaction, replay -> revoke family.
- [ ] Logout -> family revoke; access JWT cũ còn hạn tới `exp` theo policy đã công bố.
- [ ] J01–J18 có kết quả actual.

### Trình bày và nộp
- [ ] Dashboard có đúng 2 flow end-to-end; mỗi flow hiện đầy đủ từng request/response, status và reservation before/after.
- [ ] Full Security đổi qua lại được HMAC/Ed25519; rotation `ed-1 -> ed-2` chạy lại được và không restart worker.
- [ ] Export được JSON/Markdown evidence đã redacted, test scripts chạy độc lập.
- [ ] README, versions, policy, canonical example, trade-offs đầy đủ.
- [ ] Không có key/secret/token raw trong git, log hoặc evidence.
- [ ] Trình diễn **cùng request** trước/sau xác thực ở **cả hai boundary**.

---

## 16. Trade-off/giới hạn cần chủ động giải thích

| Quyết định | Lợi ích | Hạn chế |
|---|---|---|
| REST nội bộ | Ký/đọc HTTP headers và demo dễ | Không demo trực tiếp gRPC metadata của Block 03 |
| HMAC | Rẻ, nhanh, đơn giản | Inventory giữ cùng secret; lộ verifier secret có thể giả mạo signer |
| Ed25519 | Inventory chỉ cần public key; hỗ trợ `kid` và rotation | Phải quản lý hai cặp khóa/keyring/cửa sổ chuyển tiếp |
| JWT HS256 TTL 120s | Đơn giản, xác minh offline | Access JWT không bị revoke ngay khi logout, tối đa còn hiệu lực đến exp |
| Refresh family | Phát hiện reuse, ngăn tiếp tục dùng session bị nghi lộ | Concurrent refresh có thể trigger family revoke; client phải chống double refresh |
| SQLite embedded | Không phát sinh DB process thứ sáu, transactions đủ cho lab | Không phù hợp lưu nonce/token phân tán nhiều replica nếu không có shared store |
| Supervisor local-only | Demo tập trung, đủ log và compare | Admin IPC và test hooks là cơ chế lab, không được bật trên production |

**Nguyên tắc triển khai:** Không đánh đổi việc test có thật để có dashboard đẹp. Kết thúc mỗi phase phải có test và evidence trước khi sang phase tiếp theo.

---

## 17. Quy tắc làm việc với coding agent

1. Đọc `Plan.md` và đề gốc trước, không thay đổi tech stack / số process / canonical string nếu chưa cập nhật plan.
2. Implement từng phase nhỏ, có diff và script test; không viết toàn bộ dự án trong một lần không kiểm chứng.
3. Sau mỗi phase: `typecheck -> test -> run -> lưu evidence actual`. Báo rõ test nào pass/fail, nguyên nhân, bước sửa.
4. Không paste secret/private key/JWT/refresh token vào prompt; agent chỉ cần tên env var và fixtures giả.
5. Khi source hiện có không khớp plan, báo khác biệt và đề xuất patch tối thiểu; không xóa code Block 03 vô điều kiện.
6. Không tự tuyên bố hoàn thành khi chưa thấy process thật, status thật, timestamp và reservation delta.

**Thứ tự ưu tiên nếu thiếu thời gian:** Baseline -> HMAC + replay guard -> Access JWT -> Refresh family -> Ed25519/key rotation -> Supervisor polish -> Evidence đầy đủ. Vì đã chốt làm cả extension, thiếu extension nào phải ghi **chưa đạt** chứ không được ghi là không nằm trong phạm vi.
