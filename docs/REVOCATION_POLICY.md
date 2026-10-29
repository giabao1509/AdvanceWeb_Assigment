# Policy thu hồi

## 1. Alice/Bob gỡ consent

AS yêu cầu session và CSRF hợp lệ. Trong transaction: đánh dấu consent và mọi refresh family/token của cặp user + taxi-web revoked. Full từ chối refresh tiếp theo bằng 400 `invalid_grant`; Taxi xóa vault và chuyển `unlinked`. Baseline cố ý chưa enforce cờ revoked khi refresh.

Access token còn hạn vẫn được API nhận tới **exp ban đầu**, vì consent revoke không ghi grant vào denylist. Tối đa còn phần thời gian chưa dùng của TTL 120 giây. Evidence kiểm đọc số dư ngay sau revoke còn 200, sau đó refresh full thất bại.

## 2. Code bị dùng lại

AS trước tiên kiểm đúng client, redirect và verifier, rồi mới nhận diện replay để không cho request sai binding thu hồi grant người khác. Replay đúng binding:

1. Ghi grant_id vào `revocations.sqlite.revoked_grants`.
2. Thu hồi mọi refresh family phát từ code đó.
3. Commit rồi trả 400 `invalid_grant`.
4. Wallet API tra store read-only sau verify JWT; token cùng grant nhận 401 ngay trên các request kiểm tra sau commit.

AS dùng SQLite ATTACH, main/store là file thật, `journal_mode=DELETE`, `synchronous=FULL`; không WAL. API lỗi đọc store → 503, không fail open. Đây là thiết kế một host, không phải distributed introspection. Không đảo ngược charge đã hoàn tất trước thu hồi.

## 3. Refresh reuse

Kiểm đúng client, family/consent/hạn rồi mới xem used_at. Token cũ xuất hiện lại → revoke cả family và grant, commit rồi trả invalid_grant. Token mới cùng family cũng không dùng được nữa. Token đưa bởi client khác bị từ chối mà không phá family hợp lệ.

Hai refresh đồng thời có một winner; request còn lại được coi là reuse và thu hồi family. Vì vậy Taxi serialize mọi refresh theo user, kể cả đường web và job. Không blind-retry refresh sau network timeout; yêu cầu liên kết lại nếu không xác định được kết quả rotation.

## Giới hạn

Một worker Taxi, một AS process và một API process mỗi mode. Có evidence HTTP song song; chưa chứng minh power-loss/multi-process transaction trên mọi filesystem. Chia sẻ revocation DB chỉ phù hợp lab cùng máy; production cần AS được kiểm chứng và cơ chế thu hồi phân tán có SLA rõ ràng.
