# Bộ evidence nộp Block 04

Run: `a968e249-c062-4e3c-98a0-2061c8a13020`  
Tạo: 2026-10-15T16:18:27.035Z  
Kết quả: **56/56 request checks đạt**, 0 thất bại.

Mỗi request có trace ID riêng, status thực, log theo đúng trace và snapshot reservation/stock. JWT lưu iat/exp và thời điểm gửi, không lưu raw token. Data/port của runner độc lập với dashboard; không sửa khóa hay reset dữ liệu demo.

Runtime thực tế: **v22.17.1**, yêu cầu khai báo: **>=22.17.1**. Runtime đáp ứng mức khai báo.

| Case | Tình huống | HTTP | Reservation trước → sau | Lý do log | Kết quả |
|---|---|---:|---|---|---|
| B01 | Baseline đặt hàng đủ tồn kho | 201 | 0 → 1 | — | PASS |
| B02 | Baseline thiếu tồn kho | 409 | 1 → 1 | — | PASS |
| B03 | Gọi thẳng Inventory baseline không chữ ký | 201 | 1 → 2 | — | PASS |
| B04 | Baseline nhận đơn không JWT | 201 | 2 → 3 | — | PASS |
| S01 | Thiếu chữ ký service | 401 | 0 → 0 | MISSING_SIGNATURE | PASS |
| S02 | HMAC sai | 401 | 0 → 0 | BAD_SIGNATURE | PASS |
| S03 | Sửa quantity sau khi ký | 401 | 0 → 0 | BAD_SIGNATURE | PASS |
| S04-1 | Nonce được dùng lần đầu | 201 | 0 → 1 | — | PASS |
| S04-2 | Replay cùng body và nonce | 401 | 1 → 1 | REPLAY_NONCE | PASS |
| S05 | Timestamp ngoài cửa sổ cho phép | 401 | 1 → 1 | TIMESTAMP_OUT_OF_WINDOW | PASS |
| S06 | Timestamp ngoài cửa sổ cho phép | 401 | 1 → 1 | TIMESTAMP_OUT_OF_WINDOW | PASS |
| S07 | HMAC hợp lệ | 201 | 1 → 2 | — | PASS |
| S08 | Chữ ký đúng nhưng thiếu hàng | 409 | 2 → 2 | — | PASS |
| S09 | Header bảo mật bị trùng | 401 | 2 → 2 | DUPLICATE_SECURITY_HEADER | PASS |
| S10-2 | Hai request đồng thời cùng nonce | 201 | 2 → 3 | — | PASS |
| S10-1 | Hai request đồng thời cùng nonce | 401 | 2 → 3 | REPLAY_NONCE | PASS |
| S11 | Ed25519 ed-1 hợp lệ | 201 | 3 → 4 | — | PASS |
| S12 | Key ID không được tin cậy | 401 | 4 → 4 | UNKNOWN_KID | PASS |
| S13 | Khai ed-1 nhưng ký bằng private ed-2 | 401 | 4 → 4 | BAD_SIGNATURE | PASS |
| S14 | Chữ ký Ed25519 bị thay đổi | 401 | 4 → 4 | BAD_SIGNATURE | PASS |
| S15 | Gửi HMAC khi verifier chỉ cho Ed25519 | 401 | 4 → 4 | ALGORITHM_NOT_ALLOWED | PASS |
| S16 | Nonce sai định dạng | 401 | 4 → 4 | MALFORMED_NONCE | PASS |
| J01 | Đăng nhập bằng tài khoản lab | 200 | 4 → 4 | — | PASS |
| J02 | Username không tồn tại | 401 | 4 → 4 | BAD_CREDENTIALS | PASS |
| J03 | Sai mật khẩu | 401 | 4 → 4 | BAD_CREDENTIALS | PASS |
| J04 | Thiếu bearer JWT | 401 | 4 → 4 | MISSING_BEARER | PASS |
| J05 | JWT sai chữ ký | 401 | 4 → 4 | JWSSignatureVerificationFailed | PASS |
| J06 | JWT alg=none | 401 | 4 → 4 | JOSEAlgNotAllowed | PASS |
| J07 | JWT đã hết hạn (fixture ký bằng khóa lab) | 401 | 4 → 4 | JWTExpired:exp | PASS |
| J08 | JWT sai issuer | 401 | 4 → 4 | JWTClaimValidationFailed:iss | PASS |
| J09 | JWT sai audience | 401 | 4 → 4 | JWTClaimValidationFailed:aud | PASS |
| J10 | JWT đúng đi qua Order → Inventory HMAC thật | 201 | 4 → 5 | — | PASS |
| J11 | Refresh A đổi thành B | 200 | 5 → 5 | — | PASS |
| J12 | Dùng lại refresh A làm revoke family | 401 | 5 → 5 | TOKEN_REUSE | PASS |
| J13 | Refresh B bị từ chối sau family revoke | 401 | 5 → 5 | INVALID_TOKEN | PASS |
| J14-login | Đăng nhập bằng tài khoản lab | 200 | 5 → 5 | — | PASS |
| J14-1 | Hai refresh đồng thời dùng token A | 200 | 5 → 5 | — | PASS |
| J14-2 | Hai refresh đồng thời dùng token A | 401 | 5 → 5 | TOKEN_REUSE | PASS |
| J18 | Refresh token ngẫu nhiên không biết | 401 | 5 → 5 | INVALID_TOKEN | PASS |
| J19 | Refresh từ Origin không được phép | 403 | 5 → 5 | FORBIDDEN_ORIGIN | PASS |
| J20 | Không gửi refresh cookie | 401 | 5 → 5 | MISSING_REFRESH_COOKIE | PASS |
| K-login | Đăng nhập bằng tài khoản lab | 200 | 5 → 5 | — | PASS |
| K01 | Trước rotation: E2E ed-1 | 201 | 5 → 6 | — | PASS |
| K02 | Prepare ed-2 nhưng vẫn ký ed-1 | 201 | 6 → 7 | — | PASS |
| K05-3 | Request ed-1 trong cửa sổ overlap | 201 | 7 → 10 | — | PASS |
| K05-1 | Request ed-1 trong cửa sổ overlap | 201 | 7 → 10 | — | PASS |
| K05-2 | Request ed-1 trong cửa sổ overlap | 201 | 7 → 10 | — | PASS |
| K03 | Sau Switch: E2E ed-2 | 201 | 10 → 11 | — | PASS |
| K04-old | Sau Retire: ed-1 bị từ chối | 401 | 11 → 11 | UNKNOWN_KID | PASS |
| K04-new | Sau Retire: E2E ed-2 còn hợp lệ | 201 | 11 → 12 | — | PASS |
| J15-login | Đăng nhập bằng tài khoản lab | 200 | 12 → 12 | — | PASS |
| J15-before | Access JWT dùng được trước logout | 200 | 12 → 12 | — | PASS |
| J15 | Logout thu hồi family và xóa cookie | 204 | 12 → 12 | — | PASS |
| J16 | Refresh sau logout bị từ chối | 401 | 12 → 12 | INVALID_TOKEN | PASS |
| J17-before-exp | Access JWT cũ còn hạn sau logout vẫn dùng được | 200 | 12 → 12 | — | PASS |
| J17-after-exp | Cùng access JWT bị từ chối sau exp | 401 | 12 → 12 | JWTExpired:exp | PASS |

## Cách chạy lại

`npm.cmd run evidence:submission` (không cần mở server trước). Cần dependencies, .env và khóa lab có sẵn. Runner chờ JWT login hết hạn thật (~120s), không giả lập đồng hồ. Mỗi lần chạy ghi đè bộ submission bằng một run ID mới; log và database thử nghiệm ở data/submission-* được gitignore.

## Phạm vi

- canonical-example.json: canonical/body hash và HMAC/Ed25519 tính thật với timestamp đã quá hạn; không công bố secret.
- negative-cases.json + logs.jsonl: các nhánh từ chối và lý do audit.
- reservations.json: dữ liệu trước/sau; S04 chứng minh hai lần gửi chỉ tạo một reservation.
- logout-timeline.json: login, logout, refresh bị từ chối, cùng access JWT trước/sau exp.
- rotation.json: state và HTTP nội bộ thật ở từng phase, old key bị từ chối sau retire. Đây là demo overlap nhỏ, không phải chứng minh zero downtime dưới tải.
- concurrency.json: hai request cùng nonce; hai refresh đồng thời và family revocation.
- versions.json + manifest.json: phiên bản đang cài và hash source/artifact, không suy ra thời điểm viết Plan.

Kết quả này không bao gồm mọi kiểu lỗi mạng, restart hoặc browser-cookie test. Plan là mục tiêu thiết kế; không biến checklist chưa chạy thành PASS.
