# API nghiệp vụ và OAuth2

Taxi, Wallet Authorization Server và Wallet API là ba process riêng. UI, smoke và evidence dùng cùng các endpoint nghiệp vụ. Không còn route `/demo/*` hoặc `/lab/*`.

## Flow đặt vé

1. Chọn chuyến từ `GET /api/trips`. Đăng nhập Taxi bằng `GET /login` → `POST /login`. Taxi kiểm mật khẩu Argon2id, rotate session; mật khẩu Taxi khác mật khẩu Wallet.
2. `POST /api/booking-intents` với `{csrf, trip_id, payment_mode}`. Taxi xác minh chuyến và lưu ý định gắn user/session, TTL 10 phút. **Chưa tạo vé, chuyến riêng hoặc charge.** `payment_mode` là `immediate` hoặc `offline`.
3. Browser chuyển đến Wallet AS `GET /authorize` với state + PKCE S256. Khi chưa có session AS, user đăng nhập bằng `POST /login`; tiếp theo `GET /consent` → user chọn `POST /consent` với `decision=allow` hoặc `deny`.
4. AS chỉ phát code sau allow; deny trả `access_denied`. Browser đi qua `GET /oauth/callback`. Taxi kiểm state/session/attempt dùng một lần rồi đổi code qua `POST /token` bằng openid-client, Basic client auth và PKCE verifier.
5. Khi đổi code thành công, intent chuyển sang `authorized`. Browser gọi `POST /api/bookings` với `{csrf, intent_id}`. Server chỉ chấp nhận intent còn hạn, đúng user/session và đã authorized. Gọi trực tiếp hoặc chưa consent trả 403; chưa đăng nhập trả 401. Client không tự quyết định giá vé hoặc hành khách.
6. Taxi tạo record trong bảng `bookings` và job thanh toán trong cùng transaction. Giá/tuyến lấy từ catalog phía server. Với thanh toán ngay, Taxi gọi Wallet `POST /wallet/charges` bằng access token và key cố định theo chuyến. Charge thành công mới chuyển booking sang `confirmed`; thất bại là `payment_failed`. Vé offline giữ `pending_payment` đến khi job hoàn tất.
7. `GET /api/bookings` và `GET /api/bookings/:id` chỉ trả vé của user hiện tại. `POST /api/bookings/:id/retry` cũng kiểm chủ vé, giữ nguyên ticket/trip/key. Wallet charge idempotent; yêu cầu lặp cùng intent không tạo thêm booking hoặc job. Nếu lần gửi lại thất bại vì quyền đã bị thu hồi, vé đã thanh toán trước đó vẫn giữ `confirmed`; lỗi của lần gửi lại không hủy kết quả thanh toán gốc.

Mỗi **vé mới** yêu cầu consent mới theo quy tắc giao diện này, kể cả đã có liên kết ví. AS có thể dùng session đăng nhập hiện hữu, nhưng vẫn hiện màn hình consent. Gửi lại cùng vé và job offline dùng quyền đã được cấp; không yêu cầu user quay lại màn hình consent. OAuth2 cho phép dùng grant đã được chấp thuận; việc yêu cầu consent lại mỗi vé là lựa chọn nghiệp vụ của ứng dụng, không phải yêu cầu chung của giao thức. Tham chiếu: [RFC 6749, Authorization Code](https://www.rfc-editor.org/rfc/rfc6749#section-4.1).

## Endpoint chính

| Service | Endpoint | Điều kiện / kết quả |
|---|---|---|
| Taxi | GET/POST `/login`, POST `/session/logout` | Mật khẩu Taxi, opaque session, CSRF |
| Taxi | GET `/api/trips` | Danh sách tuyến/giá từ database |
| Taxi | POST `/api/booking-intents` | Session + CSRF; trả URL OAuth và intent |
| Taxi | POST `/oauth/start`, GET `/oauth/callback` | Liên kết ví riêng / callback chung |
| Taxi | POST `/api/bookings` | Intent đã được cấp quyền, session + CSRF |
| Taxi | GET `/api/bookings`, GET `/api/bookings/:id` | Session; kiểm chủ vé |
| Taxi | POST `/api/bookings/:id/retry` | Chủ vé + CSRF, giữ key cũ |
| Taxi | POST `/api/wallet/balance`, POST `/api/wallet/refresh` | Session + CSRF; Taxi dùng token phía server |
| AS | GET `/authorize`, GET/POST `/login`, GET/POST `/consent` | Đăng nhập, cấp quyền, code |
| AS | POST `/token`, GET `/.well-known/jwks.json` | Code/refresh/client credentials, public JWKS |
| AS | GET `/account`, POST `/account/revoke` | Quản lý/gỡ consent |
| Wallet API | GET `/wallet/balance`, GET `/wallet/charges` | JWT + wallet:read + user principal; dữ liệu theo sub/client |
| Wallet API | POST `/wallet/charges` | JWT + wallet:charge + user principal + idempotency key |
| Wallet API | GET `/public/rates` | JWT + rates:read |

## Case kiểm thử chạy ở đâu

`POST /testing/cases/:id/runs` là bộ điều khiển kiểm thử từ dashboard, yêu cầu đăng nhập và CSRF. Nó không tạo response giả và không có implementation thanh toán riêng. Mỗi case gửi HTTP đến chính `/authorize`, `/login`, `/consent`, `/token`, `/wallet/balance`, `/wallet/charges`, `/public/rates`. Dùng grant riêng được cấp qua login/consent thật để thử replay mà không thu hồi nhầm grant đang dùng cho vé của user. Script `attacks` gọi cùng HTTP client trực tiếp, không cần endpoint testing.

`scripts/smoke.ts` kiểm trực tiếp API đặt vé: chưa login, sai mật khẩu, chưa consent, deny, CSRF, session binding, code callback replay, quyền đọc/gửi lại vé, request cùng intent, idempotent charge. SQLite chỉ được đọc độc lập để đối chiếu số booking/charge; không chỉnh DB để bỏ qua OAuth. Evidence TTL vẫn chờ thời gian thật.

Dashboard lấy số dư/lịch sử charge qua Wallet API có Bearer guard; polling không tự refresh, nên không làm sai case offline. `/api/state` chỉ trả ví và vé của user có session. Đăng xuất không trả ví/vé cho browser. Các endpoint `/internal/events` và `/internal/oauth-traces/:id` chỉ phục vụ thu thập trace/log, có xác thực secret giữa service, không trả raw token và không quyết định kết quả nghiệp vụ.

## Sequence diagram

Kết quả có hai tab cạnh nhau: **Thông báo** mở mặc định với kết luận và vé; **Sequence diagram** hiển thị trace. Bấm mũi tên để mở popup payload cạnh bước được chọn. Popup bám theo bước khi cuộn, giới hạn trong viewport trên mobile; đóng bằng ×, Escape, bấm ngoài hoặc đổi tab. Tab hỗ trợ phím mũi tên/Home/End; Escape/× trả focus về bước vừa chọn.

Trace AS được ghi từ request/response thực tế tại route login/authorize/consent, liên kết bằng hash state. Callback Taxi thêm bước đổi code thực tế và kết quả. Trace của intent được nối với API tạo vé; sơ đồ hiển thị consent trước tạo vé. Callback chứa bước đổi token ở bên trong, thay vì vẽ response callback trước khi đổi code. Một xử lý nội bộ tạo vé chỉ có một mũi tên quay về Taxi. Request/response giữa các service là hai mũi tên riêng, popup mở payload đã che mật khẩu, CSRF, code, verifier, state và token.

## Chạy và dữ liệu

Chạy lại `npm.cmd run dev` để setup tự thêm bảng/cột mới; không cần reset dữ liệu cũ. Session cũ từ route tự đăng nhập bị vô hiệu hóa; user phải đăng nhập bằng mật khẩu. Vé mới lưu trong `bookings`; job mẫu lịch sử vẫn được giữ nhưng không xuất hiện như vé mới qua API nghiệp vụ.

Taxi: `alice / Taxi-alice-2026!`, `bob / Taxi-bob-2026!`. Wallet AS: `alice / Alice-demo-2026!`, `bob / Bob-demo-2026!`. Đây là tài khoản seed của bài thực hành; hai loại mật khẩu được kiểm bởi hai ứng dụng riêng.
