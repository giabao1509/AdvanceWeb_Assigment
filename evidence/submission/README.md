# Evidence nộp — Block 04

Mở **summary.md** trước để xem kết quả của lần chạy hiện tại. Tất cả artifact có cùng `runId`; `manifest.json` giữ SHA-256 của từng artifact và source liên quan.

| Yêu cầu nộp | Bằng chứng |
|---|---|
| Chạy lại, sinh/nạp khóa và test | README ở root, `.env.example`, script `keys:generate` và `evidence:submission` |
| Quyết định thiết kế | Plan và REPORT; lịch sử Git hiện không tự chứng minh Plan được viết trước source |
| Source và library/phiên bản | Source trong repo; `versions.json` ghi Node/OpenSSL, phiên bản dependency thực tế đang cài và hash source |
| Canonical và ví dụ tính | `canonical-example.json`: body/hash/chuỗi tám dòng, HMAC và Ed25519 tính bằng khóa lab, verify thật; timestamp đã quá hạn |
| So sánh đối xứng/bất đối xứng | Mục HMAC–Ed25519 trong REPORT, gồm quyền ký và hậu quả khi verifier lộ khóa |
| Các case từ chối | `negative-cases.json`, request/status/log cùng trace; JWT có `iat`, `exp` và thời điểm gửi |
| Reservation trước/sau | `reservations.json`, `cases.json`; S04 có check chỉ một reservation qua hai lần gửi |
| Token và logout | `logout-timeline.json`; J15 logout/xóa cookie, J16 refresh bị từ chối, J17 dùng cùng JWT trước/sau exp; J11–J14 thể hiện refresh/reuse/concurrency |
| Trade-off/giới hạn | REPORT, summary và phạm vi trong `rotation.json`; không khẳng định zero downtime production |

## Chạy lại

Tại root, sau khi cài dependency và tạo khóa lab:

```powershell
npm.cmd run evidence:submission
```

Không cần mở dashboard trước. Runner dùng port trống và database riêng trong `data/submission-*`; không thay `.env`, không sinh lại khóa và không reset database demo. Cần chờ JWT login hết hạn thật, mặc định khoảng hai phút. Một lần chạy mới sẽ thay bộ artifact hiện tại; nếu check thất bại, summary ghi FAIL và lệnh trả exit code khác 0.

## Cách đọc

- Các case nhiều lần gọi có hậu tố: `S04-1`/`S04-2` là lần đầu/replay; `J17-before-exp`/`J17-after-exp` dùng cùng access JWT.
- `checks` là các điều kiện đã quan sát; `pass` chỉ đúng khi mọi điều kiện của request đó đạt. `concurrency.json` bổ sung điều kiện cả nhóm khi thứ tự response không cố định.
- `logs.jsonl` chỉ xuất các field audit được chọn: service, trace ID, event, reason, claim và status. Không dùng đoạn log gần nhất của request khác làm bằng chứng.
- `internalExchange` là message IPC sau HTTP call thật của Order; không suy diễn response Inventory từ response Client.
- Signature ví dụ canonical được công bố với timestamp quá hạn. Signature của request HTTP đang test, bearer JWT, refresh token, password và private key được che hoặc không xuất.

## Giới hạn phải đọc cùng kết quả

- Phiên bản runtime ghi đúng thực tế trong `versions.json`. Nếu `runtimeMeetsDeclaredMinimum=false`, bộ này chưa chứng minh đã chạy trên mức Node khai báo trong package; không sửa trường version để che khác biệt.
- JWT sai chữ ký/issuer/audience/expired dùng fixture ký trong runner để nhắm đúng nhánh; timeline logout dùng token thật từ login và đồng hồ thật.
- Rotation kiểm overlap nhỏ và đợi toàn bộ request do runner phát hoàn tất trước Retire. Nó không chứng minh cơ chế retire của dashboard tự theo dõi mọi request in-flight ngoài runner.
- Không bao gồm kiểm thử browser-cookie, tải lớn, mạng lỗi hoặc phục hồi cấu hình sau restart.

Không đưa thư mục `secrets/`, `.env`, database hoặc toàn bộ runtime log vào gói nộp. Không thay artifact FAIL bằng nội dung PASS viết tay; sửa nguyên nhân rồi chạy lại script.
