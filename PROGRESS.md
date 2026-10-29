# Tiến độ Block 5

## Hai tab kết quả và popup payload — 22/10/2026

- Mỗi kết quả mới mặc định mở tab Thông báo; Sequence diagram nằm ở tab kế bên. Payload dùng popover cạnh mũi tên được chọn, bám vị trí khi cuộn, giới hạn trong màn hình nhỏ. Hỗ trợ đổi tab bằng bàn phím, Escape/×/bấm ngoài để đóng, trả focus về bước khi đóng bằng Escape/×.
- TypeScript, cú pháp JS và UI Edge headless PASS; UI kiểm tab mặc định/ẩn panel, popup request/response, Escape và focus, nút đóng, tab bằng phím, mobile popup trong viewport, không lỗi JS/CSP/token leak. Smoke API baseline/secure vẫn PASS. Ảnh desktop/mobile popup tại `evidence/ui-booking/secure-payload-popup.png` và `mobile-payload-popup.png`.
- Chỉ đổi renderer/CSS và bộ kiểm tra UI; không đổi backend OAuth/API trong lượt này. Không chạy lại evidence TTL đầy đủ; manifest bảo mật ở phần dưới thuộc snapshot trước thay đổi giao diện này. Chưa commit/push.

## OAuth và API nghiệp vụ chính — 22/10/2026

- Taxi đăng nhập bằng mật khẩu riêng, Argon2id + session rotation; không còn đăng nhập Alice tự động hoặc route `/demo/*`. Đã bỏ `/lab/*`; log/trace nội bộ yêu cầu xác thực giữa service.
- Thêm catalog chuyến, booking intents và bảng bookings riêng. API tạo vé kiểm login, CSRF, intent đúng user/session, còn hạn và đã hoàn tất consent/code exchange. Mỗi vé mới hỏi consent tại AS; deny không tạo vé hoặc charge. Giá/tuyến lấy từ database. Gửi lặp cùng intent trả cùng booking/job; retry kiểm chủ vé và giữ nguyên key.
- Trace lấy từ HTTP thực tế tại AS, ghi authorize/login/consent, callback chứa token exchange; API tạo vé chỉ xuất hiện sau consent. Sơ đồ vẫn mở payload bằng chuột/bàn phím, một bước nội bộ tạo vé, credential che phía server. Dashboard đọc số dư/lịch sử charge qua Wallet API có Bearer guard; logout không lộ ví/vé.
- Bộ chạy case chỉ gửi HTTP tới API AS/Wallet chính. Smoke kiểm 12 nhóm hành vi ở baseline và thêm nhánh retry sau revoke ở secure: no-login/sai mật khẩu, chưa consent/deny, CSRF/session binding, booking confirmed, invalid trip, lặp intent, idempotent retry, quyền user khác, callback replay và route demo 404. Retry thất bại không đổi vé đã thanh toán từ confirmed sang payment_failed.
- Đã quan sát UI + smoke hai mode PASS trên data/cổng riêng. Browser kiểm sáu case trên API thật, login Taxi, consent trước tạo vé và payload allow, đổi chuyến/giá, retry vé cũ, mobile, không JS/CSP error/token leak. Kết quả tại `evidence/ui-booking/result.json`.
- `evidence:submission` PASS trên mã cuối: [`evidence/2026-10-22T14-26-06-069Z/REPORT.html`](evidence/2026-10-22T14-26-06-069Z/REPORT.html), manifest PASS và secret_scan PASS. Hai mode có code expiry 61 giây thật, job sau access-token TTL 120 giây thật với active Taxi sessions=0, refresh/charge, revoke và grant table; secure race checks PASS. Source/lockfile không đổi trong lượt chạy. UI + smoke mới nhất cũng PASS, gồm nhánh retry thất bại sau revoke vẫn giữ booking confirmed.
- Lượt `2026-10-22T14-21-59-394Z` FAIL do xung đột cổng khi chạy UI/evidence đồng thời; giữ failure.json làm lịch sử, không dùng làm evidence đạt. Bộ UI đã chuyển sang dải cổng độc lập; lượt mã cuối ở trên chạy thành công và supervisor đã thoát. Các lượt PASS trước đó là snapshot trước điều chỉnh cuối, không thay manifest hiện tại.
- Contract và flow tại `docs/API_FLOW.md`; README/DEMO/TOKEN_CONTRACT/TRADEOFFS đã cập nhật. Chưa commit/push.

## Lịch sử: cải thiện kết quả case và flow đặt vé ban đầu — 22/10/2026

- Kết quả case có thông báo tiếng Việt theo tình huống; request/response hiển thị bằng sequence diagram. Bấm mũi tên hoặc dùng Tab/Enter/Space để mở payload/body; mặc định không bung JSON. Các trường credential được che phía server trước khi gửi về browser.
- Điều chỉnh cách vẽ thao tác nội bộ: tạo vé/chuyến chỉ có một mũi tên quay về Taxi, nhãn “Đã tạo vé và chuyến mẫu”; bấm mở input và kết quả cùng bước. Trước đó renderer vẽ thành cặp request/response nên dễ hiểu nhầm là tạo hai lần.
- Flow đặt vé mẫu: chuyến Bến Thành → sân bay, session Taxi mẫu → liên kết ví nếu cần → tạo mã vé/chuyến → thanh toán → xác nhận. Sau consent, browser tự tiếp tục thao tác đặt vé đã bắt đầu. Vé lưu trong detail của job, không thay schema hoặc thêm hệ thống điều phối/tồn chỗ.
- Đặt lại dùng đúng job/vé/chuyến đã chọn; có thể chọn vé cũ từ lịch sử. Vé đã thanh toán trả duplicate và không trừ thêm tiền. Lần đặt vé mới sinh mã vé/chuyến mới. Giữ route charge cũ cho smoke/evidence tương thích.
- Đã chạy Edge headless với dữ liệu và cổng riêng: cả sáu case trên hai mode, thông báo, mở request/response, bàn phím, đặt vé từ chưa có session qua consent, đặt lại giữ mã vé/chuyến và counter, tạo vé mới, chọn lại vé cũ, mobile không tràn trang, không JS/CSP error hoặc token leak. UI và smoke baseline/secure PASS; kết quả tại `evidence/ui-booking/result.json`, ảnh trong cùng thư mục. TypeScript và cú pháp dashboard JS PASS.
- Các báo cáo security/TTL/race trước đây vẫn là evidence của snapshot trước; chưa chạy lại toàn bộ `evidence:submission` cho thay đổi này. Sequence diagram chỉ hiển thị các bước được ghi nhận; không tái dựng HTTP login/consent chưa được capture. Chưa commit/push.

Cập nhật: 22/10/2026. Phạm vi: baseline + full security + dashboard HTTP loopback theo yêu cầu.

## Đã triển khai

- Sáu process: AS, API, Taxi cho mỗi mode; data/key/issuer/cookies riêng, restart giữ dữ liệu.
- Dashboard desktop/mobile: hai tab, ba thẻ giải thích thành phần, liên kết ví, số dư, charge/retry, lịch job, sáu case, response Taxi/AS/API, nhật ký live.
- Wallet AS: Alice/Bob Argon2id, confidential clients, code + PKCE S256, Basic auth, ES256/kid/JWKS, refresh rotation/reuse, consent revoke, Client Credentials.
- Wallet API: JWT/scope/principal guard, ví theo sub, transactional/idempotent charge; revocation lookup cho code/refresh replay.
- Taxi: openid-client, opaque SQLite session, CSRF, AES-GCM token vault, refresh lock theo user, durable jobs và offline worker.
- README, token contract, AS checklist, revocation policy, demo script và trade-offs. Có lệnh reset dữ liệu giả, không xóa keys hoặc evidence.

## Kết quả đã quan sát

- `npm.cmd run build`: TypeScript strict PASS trên mã cuối.
- `npm.cmd test`: cả hai mode đã đạt link bằng library → balance → charge → retry không tăng counter; M2M kiểm scope/principal.
- `npm.cmd run test:e2e`: Edge headless đã đạt hai dashboard, case PKCE trước/sau, browser login/consent/callback, charge/retry, mobile không tràn ngang; không JS/CSP errors và không raw token trả về browser. Ảnh và kết quả tại `evidence/ui/`.
- Evidence lượt `2026-10-22T02-37-23-514Z` đã PASS các luồng chính, chín attack cases, code hết hạn 60 giây thật, job sau access-token exp 120 giây thật, active Taxi sessions=0, counter tăng một lần, consent revoke và grant table. Đây là lượt trước điều chỉnh UI response và bổ sung race checks; không coi nó là snapshot của mã cuối.
- Lượt đầu `2026-10-22T02-36-56-474Z` lỗi do harness đọc config trước khi setup. Đã sửa thứ tự; giữ `failure.json` làm lịch sử, không dùng làm evidence đạt.

## Kiểm chứng cuối — PASS

Lượt cuối: [`evidence/2026-10-22T02-53-03-457Z/REPORT.html`](evidence/2026-10-22T02-53-03-457Z/REPORT.html). Lab/data/cổng riêng; process supervisor đã thoát sạch sau khi hoàn tất.

- Chín attack cases mỗi mode: baseline chấp nhận; secure chặn đúng lỗi/status, gồm code hết hạn 61 giây thật.
- Offline job hai mode: chờ access token TTL 120 giây thật; active Taxi sessions=0; refresh 200 → charge 201, counter tăng đúng một.
- Gỡ consent: access token còn hạn đọc ví 200; secure refresh invalid_grant và Taxi unlinked; baseline còn chấp nhận.
- Grant table quan sát: authorization code có/không offline_access, refresh, Client Credentials; đúng presence refresh token, sub/aud/scope/principal/expires_in.
- Ba race checks full: code exchange 200/400 rồi token cũ bị API 401; refresh 200/400 rồi family bị revoke; charge song song 201/200, counter tăng một.
- Source/lockfile không đổi trong lượt chạy; manifest ghi versions/source hashes/artifact hashes; secret scan PASS. Không có raw code/token/secret được xuất trong artifacts.
- UI test và smoke hai mode trên mã cuối đều PASS. Kết quả UI ở [`evidence/ui/result.json`](evidence/ui/result.json).
- Reset đã từ chối khi server đang chạy và chạy được sau khi stop. Dữ liệu demo chính đã reset về 1.000.000đ mỗi ví, counter=0, chưa link/chưa job. Sáu server demo đang chạy ở 4101–4103 và 5101–5103.

## Điều chỉnh và giới hạn

- Dùng HTTP theo chỉ đạo người dùng, không có TLS/cookie Secure. Chỉ bind loopback. Không còn phụ thuộc/cài đặt certificate trong source.
- Node thực tế 22.17.1; một package root, không npm workspaces; session adapter SQLite ngắn thay plugin session. Chi tiết tại docs/TRADEOFFS.md.
- Baseline/full cùng nguồn, so sánh policy chạy lại được; không có commit lịch sử baseline-only.
- Kiểm chứng concurrency là HTTP song song với một process mỗi service; chưa kiểm power-loss hay nhiều AS process. Không có HA, KMS/key rotation, distributed worker hoặc chứng nhận production.
- Diagnostic routes là riêng cho lab; số dư trên dashboard qua kênh quan sát, nút đọc số dư qua guard thực.
- Chưa commit/push. Không có đánh giá production hoặc nghiệm thu bên ngoài.
