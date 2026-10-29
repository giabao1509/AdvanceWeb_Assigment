# Contract token và tài nguyên

## Access token

JWT ES256/P-256, header `kid` và `typ=at+jwt`. Issuer là origin AS của mode; audience `wallet-api`. TTL 120 giây. Claims: `sub`, `client_id`, `scope`, `principal_type`, `iat`, `exp`, `jti`, `grant_id`. JWKS chỉ chứa public key tại `/.well-known/jwks.json`.

API cấu hình cố định issuer/JWKS, chỉ nhận ES256, yêu cầu đầy đủ claims, kiểm expiry và scope/principal. Không dùng `jku` từ token. Secure còn tra read-only revocation store theo grant_id sau khi verify.

| Grant | sub | principal_type | Refresh token |
|---|---|---|---|
| Authorization Code | ID user Wallet (`alice` / `bob`) | `user` | Có nếu consent có `offline_access` |
| Refresh Token | User của family | `user` | Full xoay token mới; baseline trả token cũ |
| Client Credentials | `taxi-m2m` | `client` | Không |

Response `/token`: `access_token`, `token_type=Bearer`, `expires_in=120`, `scope`, có `refresh_token` theo bảng. HTTP header `Cache-Control: no-store`, `Pragma: no-cache`. `openid-client` có thể chuẩn hóa token_type thành `bearer` trong kết quả library; cùng ý nghĩa, không phải AS đổi response.

**Bảng trên là contract.** Bảng quan sát thực nằm trong `grants.json`, được trích từ response thật và JWT đã verify. Không lưu compact JWT trong evidence.

## Code và refresh token

- Code: CSPRNG 256-bit, DB hash SHA-256, hạn 60 giây, gắn client/redirect/user/scope/challenge/consent/grant.
- Refresh: opaque CSPRNG 256-bit, không JWT; AS chỉ lưu hash. Family tuyệt đối 7 ngày; rotation không gia hạn vô hạn. `used_at`, `revoked_at`, `replaced_by` phục vụ reuse detection.
- Taxi mã hóa token cần dùng lại bằng AES-256-GCM, nonce mới mỗi lần, AAD gắn mode/user/client. Khóa tách khỏi DB.

## API

| Endpoint | Quyền | Thành công |
|---|---|---|
| `GET /wallet/balance` | wallet:read + principal user | 200 số dư ví theo sub |
| `GET /wallet/charges` | wallet:read + principal user | 200 lịch sử charge theo sub/client |
| `POST /wallet/charges` | wallet:charge + principal user | 201 tạo charge; 200 khi cùng key/payload |
| `GET /public/rates` | rates:read | 200 bảng giá |

Charges body: `{amount: integer > 0, trip_id: string}`; tiền VND nguyên, không float. Header `Idempotency-Key` bắt buộc. Key unique theo user/client/key. Cùng key khác amount/trip → 409; thiếu tiền → 409; update số dư và insert charge trong một transaction. Counter là số row charges thật.

Token thiếu/sai/hết hạn/revoked → 401 `invalid_token`. Token hợp lệ nhưng scope/principal không đúng → 403 `insufficient_scope`. `/public/rates` vẫn cần token dù tên route có `public`.

Dashboard đọc ví/lịch sử charge qua API Bearer ở trên. Không còn `/lab/state` hoặc `/lab/events`. `/internal/events` và `/internal/oauth-traces/:id` có xác thực giữa service, chỉ thu thập log/trace. Contract Taxi login/intent/booking và guard consent tại [API_FLOW.md](API_FLOW.md).
