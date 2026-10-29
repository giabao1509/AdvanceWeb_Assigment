# Các kiểm tra Wallet AS

“Full” là policy `mode=secure`. Baseline cố ý bỏ các gate OAuth liệt kê dưới đây; hashing, signing, API guards và token vault vẫn có ở cả hai bản.

| Endpoint / bước | Kiểm tra full | Sai thì trả | Tấn công bị chặn |
|---|---|---|---|
| `/authorize` parse | Security parameters không lặp | 400 `invalid_request` tại AS | Parameter pollution |
| `/authorize` trust callback | Client tồn tại, URI exact-match | 400 tại AS, **không Location** | Open redirect, code exfiltration |
| `/authorize` grant/response | Client được phép, response_type=code | Callback đã xác minh: `unauthorized_client` / `unsupported_response_type` | Grant confusion |
| `/authorize` scope | Không rỗng, thuộc client allowlist | 302 callback `invalid_scope` | Scope escalation |
| `/authorize` PKCE | Challenge hợp lệ, chỉ S256 | 302 callback `invalid_request` | Code interception/downgrade |
| Login/consent/revoke | CSRF token và Origin, user session | 403 tại AS | Form CSRF |
| `/login` | Argon2id password hash | 401 trang login, thông báo chung | Password guessing / plaintext storage |
| `/consent` | Request server-side gắn session, hết hạn 10 phút | 400 tại AS | Sửa scope/client/redirect qua form |
| `/consent` deny | Không cấp code | Callback `access_denied`, state nguyên giá trị | Cấp quyền khi chưa đồng ý |
| `/token` parse | POST form, không tham số lặp / auth methods lặp | 400 `invalid_request` | Ambiguous request |
| `/token` client auth | HTTP Basic + Argon2id secret | **401 `invalid_client`**, Basic challenge | Mạo danh client |
| `/token` grant | Grant hỗ trợ và được client cho phép | 400 `unsupported_grant_type` / `unauthorized_client` | Dùng sai grant |
| Code binding | Hash code, client, redirect, verifier syntax và challenge | 400 `invalid_grant` | Đổi code của client khác / verifier sai |
| Code expiry | Chưa hết 60 giây | 400 `invalid_grant` | Dùng code cũ |
| Code one-time | Consume trong transaction; replay thu hồi grant | 400 `invalid_grant`; API từ chối token cũ | Replay/race |
| Refresh ownership | Token cấp đúng client đang xác thực | 400 `invalid_grant`; không thu hồi family người khác | Cross-client use / DoS |
| Refresh validity | Family/token/consent chưa revoked, chưa quá 7 ngày | 400 `invalid_grant` | Dùng token sau gỡ quyền |
| Refresh reuse | Token cũ chưa dùng; rotate atomically | Replay → 400 `invalid_grant`, revoke family/grant | Refresh replay |
| Refresh scope | Không rộng hơn token hiện hành | 400 `invalid_scope` | Scope escalation |
| Client Credentials | taxi-m2m grant allowlist, rates:read | 400 `invalid_scope` nếu xin wallet:charge | Client có quyền user |

Thứ tự `/token`: parse → client auth → grant hỗ trợ → với code/refresh, ownership trước grant allowlist → kiểm tra còn lại trong transaction. Nhờ vậy client khác có secret đúng vẫn nhận `invalid_grant` đúng đoạn contract của đề, thay vì chỉ dừng ở grant gate.

Mọi redirect về client giữ state gốc; không redirect tới callback chưa tin cậy. Code/refresh chỉ lưu SHA-256, không plaintext. Token response có `no-store` và `no-cache`.

Các case thực thi: `shared/cases.ts`. HTTP status và OAuth error thật nằm trong `evidence/<run-id>/<mode>/attacks.json` và `code-expiry.json`. Kiểm tra không có evidence riêng chưa được coi là chứng nhận đã kiểm thử độc lập.
