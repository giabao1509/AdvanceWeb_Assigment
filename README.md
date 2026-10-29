# Wallet Lab — Block 5

Dashboard minh họa OAuth2 giữa **Taxi**, **Wallet AS** và **Wallet API**, có hai luồng **Baseline / Full security** chạy song song. Chạy HTTP localhost theo yêu cầu; không cần chứng chỉ hay Docker.

## Chạy ứng dụng

Cần Node.js **22.17+** và npm. Đã kiểm chứng trên Windows với Node **22.17.1**, npm **10.9.2**. Từ PowerShell:

```powershell
Set-Location E:\AdvanceWeb\Block-5\AdvanceWeb_Assigment
npm.cmd ci --include=dev
npm.cmd run dev
```

`dev` tự setup lần đầu, sinh khóa/secret, seed Alice/Bob và mở **6 process**. Khi thấy đủ 6 dòng địa chỉ, mở:

- **Full security:** [http://localhost:5103](http://localhost:5103)
- **Baseline:** [http://localhost:4103](http://localhost:4103)

Giữ terminal chạy, dừng bằng **Ctrl+C**. Luôn dùng hostname `localhost` đúng như callback đăng ký, tránh đổi sang `127.0.0.1` trong browser.

Cài đầy đủ devDependencies bằng `--include=dev` để có TypeScript (`tsc`) và `tsx`. Khi clone về, chưa cần có sẵn database: lệnh `dev` tự tạo thư mục `.local/`, các database SQLite và dữ liệu mẫu trong lần chạy đầu.

## Dùng dashboard

1. Chọn chuyến và bấm **Đặt vé từ đầu đến cuối**. Nếu chưa đăng nhập Taxi, dùng `alice / Taxi-alice-2026!` (hoặc `bob / Taxi-bob-2026!`). Taxi xác minh mật khẩu và tạo session riêng.
2. Browser chuyển sang Wallet AS. Đăng nhập Wallet `alice / Alice-demo-2026!` (hoặc `bob / Bob-demo-2026!`), đọc scope và bấm **Đồng ý liên kết**. Mỗi vé mới đều đi qua consent; nếu đã đăng nhập Wallet, AS vẫn hiện consent.
3. Chỉ sau callback và đổi code thành công, **API chính** `/api/bookings` mới tạo vé và gọi `/wallet/charges`. Gọi tạo vé trực tiếp khi chưa consent bị 403. Từ chối consent không tạo booking hoặc charge.
4. Xem sequence diagram: login → consent → callback → token → tạo vé → charge. Bấm mũi tên để xem payload đã che credential. **Đặt lại cùng vé / chuyến** giữ nguyên ticket/trip/key và không trừ thêm tiền; có thể chọn vé cũ trong lịch sử để gửi lại đúng vé đó.
5. Chạy sáu case bảo mật. Bộ chạy case gửi HTTP đến chính `/authorize`, `/login`, `/consent`, `/token` và Wallet API. Grant kiểm thử được cấp qua login/consent thật để thử replay mà không phá grant của vé. Không có API `/demo/*` hoặc response giả. Contract chi tiết: [API_FLOW.md](docs/API_FLOW.md).
6. Bấm **Đặt job sau khi token hết hạn**: hoàn tất consent, tạo vé chờ thanh toán rồi **Đăng xuất Taxi**. Job chờ token hết hạn thật, refresh và thanh toán bằng quyền đã cấp. Đăng nhập lại để xem vé; browser đã đăng xuất không được đọc ví/vé.
7. Mở **Quản lý / gỡ quyền tại Wallet AS**, gỡ consent rồi thử refresh. Full nhận `invalid_grant` và chuyển chưa liên kết. Access token còn hạn tuân theo policy đã công bố.

Số dư và lịch sử charge trên dashboard lấy qua **API có Bearer guard**, theo sub/client trong token. Polling không tự refresh để giữ đúng case offline. Endpoint thu thập log/trace giữa service có xác thực riêng; không thay thế API nghiệp vụ. Tài khoản Taxi và Wallet được xác thực ở hai ứng dụng độc lập.

## Các server

| Thành phần | Baseline | Full security | Vai trò |
|---|---|---|---|
| Wallet AS | `http://localhost:4101` | `http://localhost:5101` | Login, consent, `/authorize`, `/token`, JWKS, gỡ quyền |
| Wallet API | `http://localhost:4102` | `http://localhost:5102` | Balance, charges, rates; verify JWT và quyền |
| Taxi/dashboard | `http://localhost:4103` | `http://localhost:5103` | OAuth client library, session, vault, job và UI |

Cả sáu process chỉ bind `127.0.0.1`. Baseline và secure có issuer, key, secret, database và cookie name riêng. Có thể chạy từng mode bằng `npm.cmd run dev:baseline` / `npm.cmd run dev:secure`; tab mode còn lại chỉ hoạt động khi mode đó cũng đang chạy.

## Kiểm tra vừa đủ và tạo evidence

Để `npm.cmd run dev` chạy trong terminal thứ nhất. Trong terminal thứ hai:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run attacks -- --target baseline
npm.cmd run attacks -- --target secure
```

`test` là một smoke script kiểm luồng chính và idempotency trên hai mode. `attacks` chạy 8 tình huống nhanh; thêm `--all` để có tình huống thứ 9 chờ code hết hạn **61 giây thật**.

```powershell
npm.cmd run attacks -- --target secure --all
npm.cmd run test:e2e
npm.cmd run evidence:submission
```

- `test:e2e`: browser xuyên suốt kiểm login Taxi bằng mật khẩu, sáu case trên API thật, consent trước tạo vé, chọn chuyến, charge/retry và mobile; chụp ảnh vào `evidence/ui/`. Dùng Edge headless đã cài trên Windows. Nếu không có Edge: `npx.cmd playwright install msedge`.
- `evidence:submission`: tự khởi động lab riêng ở cổng **6101–6103 / 7101–7103**, data `.local/evidence/<run-id>/`; không cần dev đang chạy và không sửa dữ liệu demo. Chạy khoảng 2–3 phút vì giữ TTL thật. Xuất `REPORT.html`, JSON trước/sau, redirect trace, log offline job, grant table, source hashes và manifest vào `evidence/<run-id>/`.
- `build` chỉ typecheck TypeScript; app chạy bằng `tsx`, không có bundle frontend.

Không cần thêm hàng loạt unit test để sử dụng dashboard. Các script tập trung vào luồng demo và những kiểm tra đề yêu cầu. Kết quả chạy và giới hạn được ghi tại [PROGRESS.md](PROGRESS.md).

## Dữ liệu và reset

`npm.cmd run setup:local` chạy lại an toàn, không đổi key, secret, số dư hay job đang có. `.local/` chứa private key, client secret, AES vault key và SQLite; đã gitignore. Runner nạp config nhạy cảm qua biến môi trường `LAB_CONFIG` cho từng process. Không commit hoặc gửi thư mục này.

Để trở về số dư mẫu 1.000.000đ và xóa job/session/consent thử nghiệm, **dừng dev bằng Ctrl+C**, rồi:

```powershell
npm.cmd run reset:demo
npm.cmd run dev
```

Reset giữ key/client secrets, chỉ xóa bốn database của mỗi mode và seed lại dữ liệu giả. Evidence đã xuất không bị xóa.

## Stack và bảo mật

| Thư viện | Phiên bản đã dùng |
|---|---|
| Fastify | 5.12.7 |
| `openid-client` | 6.8.8 |
| `jose` | 6.2.13 |
| Argon2 | 0.44.0 |
| `better-sqlite3` | 12.11.1 |
| TypeScript / tsx | 5.9.3 / 4.23.15 |
| Playwright | 1.64.1 |

Full: exact redirect match, scope/grant allowlist, PKCE S256, Basic client auth, hashed one-time code, ES256/JWKS, token TTL, refresh rotation/reuse detection, consent checks, principal guard, transactional idempotency, CSRF, opaque server session và AES-GCM token vault. Chi tiết tại [AS_CHECKLIST](docs/AS_CHECKLIST.md), [TOKEN_CONTRACT](docs/TOKEN_CONTRACT.md), [REVOCATION_POLICY](docs/REVOCATION_POLICY.md), [TRADEOFFS](docs/TRADEOFFS.md).

HTTP là lựa chọn chủ động cho bài local theo yêu cầu. Cookie dùng HttpOnly + SameSite=Lax, không có Secure; library OAuth chỉ cho phép HTTP trong cấu hình loopback này. “Full security” mô tả kiểm tra OAuth của bài, không có nghĩa đã đạt tiêu chuẩn hệ thống tiền thật.

## Cấu trúc

```text
apps/       wallet-as.ts, wallet-api.ts, taxi.ts — ba entrypoint/process
shared/     config, SQL, crypto, HTTP/session, OAuth library, fixtures và cases
public/     dashboard HTML/CSS/JS; không phụ thuộc CDN
scripts/    setup, supervisor, smoke, UI, attacks, evidence, reset
docs/       contract, checklist, policy, demo và trade-offs
evidence/   kết quả đã che và ảnh browser
Plan.md     thiết kế trước implementation + điều chỉnh theo yêu cầu mới
```

Nguồn đề: [Block 5 — Ủy quyền OAuth2 Taxi / Wallet](https://pub.nndkhoa9.win/webadv/w3/block-05-assignment.html), có snapshot tại `assignment-block-05.html`.
