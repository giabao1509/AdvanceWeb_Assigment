# Block 04 — Server-to-Server Authentication & JWT

Lab này triển khai song song hai hệ thống để so sánh trực tiếp:

- **Baseline:** `Order v1 :3001 -> Inventory v1 :5001`, không JWT và không request signature.
- **Secure:** `Order v2 :3002 -> Inventory v2 :5002`, access JWT cho người dùng và HMAC/Ed25519 cho service.
- **Supervisor + Dashboard:** process thứ 5 tại `http://127.0.0.1:3000`, quản lý worker, IPC rotation, evidence và log.

```text
Browser -> P5 Supervisor/Dashboard :3000
              |-- P1 Order v1 :3001 -> P2 Inventory v1 :5001
              `-- P3 Order v2 :3002 -> P4 Inventory v2 :5002
                    user JWT             service signature
```

## Chạy dự án

Yêu cầu Node.js `>=24.10` và npm 10+ theo target runtime trong `Plan.md`.

```powershell
npm.cmd install
npm.cmd run keys:generate
npm.cmd run db:seed
npm.cmd run build
npm.cmd start
```

Mở `http://127.0.0.1:3000`. Dashboard production được P5 serve trực tiếp; Vite không chạy thành process thứ sáu.

Dashboard dùng giao diện light-mode **Security Lab**, với hai luồng End-to-End:

- `Baseline End-to-End`: chọn **Đặt hàng thành công** hoặc **Kho không đủ hàng** để chạy Client → Order v1 → Inventory v1.
- `Full Security End-to-End`: chọn **Đăng nhập và đặt hàng**, **Thiếu access token**, **Access token giả**, **JWT hợp lệ nhưng kho thiếu hàng** hoặc **Đổi refresh token A → B**.
- Trong Full Security, đổi preset chữ ký giữa **HMAC-SHA256** và **Ed25519**. Case **Đổi ed-1 → ed-2** chạy Initial/Prepare/Switch/Retire rồi kiểm tra lại request.
- Inspector hiển thị riêng request và response của mỗi hop, gồm cả request nội bộ Order → Inventory lồng trong lúc Order chờ phản hồi; password, token, cookie và chữ ký được che.
- Mỗi lần chạy lưu timeline vào `evidence/end-to-end-runs.json`; log runtime hiển thị trực tiếp và lọc được theo service.
- Khung nhật ký chỉ hiển thị event của phiên runtime hiện tại và có thể lọc theo service. Evidence là dữ liệu lịch sử, không đổi khi chỉ chuyển luồng trên UI.
- Dashboard lấy health ngay khi mở trang và tự kiểm tra lại mỗi 5 phút.
- Chọn luồng ở hai tab phía trên; sơ đồ có mũi tên request/response và nhãn xác thực trên từng chặng. Chọn case bên trái rồi bấm **Chạy case đã chọn**, xem dữ liệu thực tế bên phải.
- Response chỉ hiển thị HTTP status và nội dung nhận được, không hiển thị status mong đợi hay nhãn PASS/FAIL. Các phần rotation, trạng thái dữ liệu và nhật ký có thể mở/thu gọn.

Tài khoản lab do `keys:generate` ghi vào `.env`:

```text
username: demo
password: <random value generated locally>
```

Đọc password trong `.env` tại máy demo hoặc tự thay giá trị rồi chạy `npm.cmd run db:seed`. Password plaintext không nằm trong source/DB; DB chỉ giữ bcrypt hash. `secrets/`, `.env`, `data/` và evidence JSON runtime đều bị gitignore.

## Lệnh chính

```powershell
npm.cmd run typecheck       # kiểm tra TypeScript
npm.cmd run build           # build server và React dashboard
npm.cmd test                # unit test ngắn cho canonical/HMAC
npm.cmd run demo:all        # 10 HTTP scenarios đại diện, cần npm start đang chạy
npm.cmd run db:reset        # reset cả baseline và secure khi service đang dừng
```

`demo:all` xuất kết quả thực tế vào:

- `evidence/smoke-results.json`
- `evidence/summary.md`
- `evidence/versions.json`
- `evidence/logs/runtime.jsonl`

Smoke suite có chủ ý không chạy toàn bộ matrix trong `Plan.md`; nó tập trung vào các boundary và state transition quan trọng: B03, S01, S04, B04, J04, J01, J10, J11, J12, J13. Các negative case còn lại có thể chạy thủ công hoặc bổ sung vào runner mà không thay đổi API.

## Hợp đồng bảo mật nội bộ

Body reservation được Zod kiểm tra strict và serialize cố định:

```json
{"sku":"SKU-001","quantity":2,"orderId":"..."}
```

Canonical string gồm đúng tám dòng, không có newline cuối:

```text
v1
POST
/internal/reservations
<algorithm>
<kid>
<timestamp-seconds>
<nonce>
<sha256-canonical-body>
```

P4 kiểm tra duplicate/missing header, algorithm allowlist, `kid`, timestamp ±60 giây, chữ ký, rồi mới consume nonce trong transaction. Nonce tồn tại ít nhất 120 giây. Transaction nonce + stock + reservation ngăn replay/race tạo reservation kép.

- **HMAC-SHA256:** `kid=hmac-lab-1`, so sánh bằng `timingSafeEqual`.
- **Ed25519:** Order chỉ đọc private key; Inventory chỉ đọc public key.
- Secret access JWT và HMAC nội bộ là hai giá trị random độc lập.

## JWT, refresh và logout

- Access JWT: HS256, `sub`, `iss=block04-order-api`, `aud=block04-client`, `iat`, `exp`, `jti`; TTL mặc định 120 giây.
- Refresh token: 32 byte random; SQLite chỉ lưu SHA-256 hash.
- Mỗi refresh consume token A và tạo token B trong một transaction.
- Tái sử dụng A thu hồi toàn bộ family, nên B cũng bị từ chối.
- Logout thu hồi family và clear cookie.
- Access JWT đã cấp vẫn hợp lệ tới `exp`; logout không thu hồi tức thời access token offline.
- Cookie là `HttpOnly`, `SameSite=Lax`, `Path=/auth`; `Secure=false` chỉ trong lab HTTP development.

## Rotation Ed25519 qua IPC

Trong phần **Đổi key ed-1 → ed-2** bên trong Full Security, nút chạy trọn case sẽ:

1. Chạy Full Security E2E bằng `ed-1`.
2. Nạp public `ed-2`, chạy tiếp bằng `ed-1`.
3. Chuyển signer sang `ed-2`, chạy Full Security E2E.
4. Gỡ `ed-1`, xác minh request dùng key cũ nhận `401`, rồi chạy lại E2E bằng `ed-2`.

Timeline giữ lại kết quả của các lần kiểm tra. Không worker nào restart trong flow.

## Supervisor và API lab

P5 sinh admin session ngẫu nhiên lúc start và đặt cookie HttpOnly khi tải `/`. Các endpoint `/api/*` yêu cầu cookie này và kiểm Origin. Chúng bind `127.0.0.1`, chỉ phục vụ lab:

- `GET /api/processes`
- `POST /api/tests/run`
- `GET /api/evidence`
- `GET /api/logs/stream`
- `POST /api/demo/reset`
- `POST /api/demo/signing-mode`
- `POST /api/demo/rotation/{initial,prepare,switch,retire}`

P1–P4 nhận reset/mode/keyring bằng IPC; không có public endpoint thay khóa ở Inventory.

## Evidence và redaction

Fastify/Pino log JSON theo service và trace ID. Logger redact `Authorization`, cookie, `Set-Cookie`, password và token. Evidence chỉ lưu claim không nhạy cảm, nhãn `token A/B`, status và snapshot stock/reservation; không lưu raw JWT, refresh token, private key hoặc secret.

## Trade-off và giới hạn

| Quyết định | Lợi ích | Giới hạn |
|---|---|---|
| HMAC | Nhanh, dễ triển khai | Inventory giữ secret và có khả năng giả signer nếu secret bị lộ |
| Ed25519 | Verifier chỉ cần public key, rotation rõ ràng | Keyring và grace period phức tạp hơn |
| JWT offline 120s | Verify nhanh, không cần auth server | Logout có cửa sổ access còn hiệu lực tối đa 120s |
| SQLite WAL | Không phát sinh process DB thứ sáu | Chỉ phù hợp lab/single node, không phải replay store phân tán |
| Local supervisor | Demo tập trung, quan sát tốt | Admin/test hooks không được đem sang production |

Nếu npm trong mạng doanh nghiệp báo lỗi certificate, nên cài CA nội bộ qua `NODE_EXTRA_CA_CERTS`; không lưu cấu hình tắt TLS verification vào dự án.
