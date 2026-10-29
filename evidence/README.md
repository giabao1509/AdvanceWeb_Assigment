# Evidence bài nộp Task Management API

Bộ evidence được tạo từ request HTTP và test chạy thật trên code trong workspace. Không chỉnh tay các JSON response hoặc log để tạo kết quả mong muốn. Thời điểm chạy, phiên bản Node, exit code, commit nền, trạng thái working tree và SHA-256 nằm trong `manifest.json`; chỉ coi lần thu thập hoàn tất khi `status` là `PASS`.

## Tái tạo

Tại thư mục gốc repo, dùng Node.js >=22.13, Git và Chrome/Edge local:

```powershell
npm.cmd install
npm.cmd run evidence
```

Lệnh dùng file SQLite tạm riêng và cổng loopback tạm, không cần chạy server trước, không mở/reset `data/lab.sqlite`. Browser test cũng có database tạm riêng. Có thể đặt `LAB_BROWSER` nếu Chrome/Edge nằm ngoài đường dẫn mặc định.

Chạy riêng cùng regression an toàn cho cả hai version:

```powershell
npm.cmd run test:idor -- --version=starter  # exit 1 là kết quả RED mong đợi
npm.cmd run test:idor -- --version=v1       # exit 0, GREEN
npm.cmd test                              # bộ mặc định phải xanh
```

Regression có cùng oracle cho mọi version: Alice/B1 phải bị chặn và không lộ nội dung; Alice/A1 và Charlie/B1 vẫn đọc được. Starter cố ý vi phạm oracle đầu tiên: 1 fail, 2 positive pass. V1 phải đạt cả 3. Regression riêng nằm ngoài `test/` nên không làm bộ mặc định đỏ; script evidence kiểm tra exit code và số pass/fail, không che lỗi bất ngờ.

## Các artifact và cách đọc

| Artifact | Nội dung |
| --- | --- |
| `starter-idor.json` | Alice đọc B1 ở Starter: response thật 200 chứa nội dung Beta giả lập |
| `v1-idor.json` | Cùng actor/task ở V1: 403, data null, không có nội dung Beta |
| `verification-matrix.json` | 11 request thật: IDOR trước/sau, Anonymous, legitimate reads, assignee/Closed, spoof role/tenant, admin cùng/khác tenant và mutation hợp lệ |
| `regression-starter.txt` / `regression-v1.txt` | Cùng security regression chạy trên current app: RED ở Starter, GREEN ở V1; legitimate reads đều pass |
| `tests-after.txt` | Output stdout/stderr và exit code toàn bộ `node --test` sau sửa |
| `ui-after.txt` | Output browser smoke qua UI thật, popup, form, stale response và mobile |
| `authorization.diff` | Diff tái dựng thể hiện nơi PEP gọi PDP và chặn trước khi chạy nghiệp vụ |
| `snapshots/before/src/` / `snapshots/after/src/` | Hai snapshot thực thi được để đối chiếu diff, không phải hai commit lịch sử |
| `regression-snapshot-before.txt` / `regression-snapshot-after.txt` | Cùng URL V1, cùng oracle: wrapper thiếu object authorization RED; wrapper hiện tại GREEN |
| `manifest.json` | Provenance, môi trường, các lệnh/exit code và SHA-256 để đối chiếu code/artifact |

Các JSON chỉ lưu actor, đường dẫn và headers đã bỏ bearer token; response giữ nguyên dữ liệu/trace/requestId nhận từ server. Mọi nội dung task trong evidence là fixture giả của lab. Request bị từ chối được assert `data: null` và database không đổi; ca sửa A1 hợp lệ được đọc lại trực tiếp trong database tạm để xác nhận ghi thực sự.

## Diff này chứng minh điều gì?

Đây là **diff tái dựng có kiểm chứng**, không phải lịch sử Git trước/sau sửa IDOR. Snapshot `after/src/app.js` sao chép nguyên code hiện tại. Snapshot `before/src/app.js` được tạo từ đó bằng cách bỏ đúng khối tải membership, gọi `authorize()`, ghi authorization trace và chặn 403 trong `endpoint()`, cùng import `authorize`. Những phần xác thực, load resource, validation và transaction được giữ nguyên; wrapper trước ghi rõ bước object authorization bị bỏ qua.

`policy.js` được sao chép giống nhau vào hai snapshot; wrapper before không gọi hàm authorize. Các module khác giữ nguyên để không đưa khác biệt fixture/route vào so sánh. Vì vậy snapshot before tái hiện **ranh giới auth-only**, không khẳng định đây là source Starter gốc của giảng viên. Các rule nghiệp vụ như Owner cố định vẫn giữ nguyên.

Diff bổ sung membership lookup từ database, truyền version/principal/action/context vào PDP và thực thi `if (!decision.allowed) fail(403, ...)` trước `work(...)`. Quy tắc membership V1 nằm trong `src/policy.js` của snapshot after. Hai regression snapshot chọn `--version=v1` trên cùng route, lần lượt thất bại/thành công. Script còn chạy `git apply --check -p2 ../../authorization.diff` từ thư mục `evidence/snapshots/before` để xác nhận patch áp dụng được; không sửa snapshot sau khi kiểm tra.

## Đối chiếu yêu cầu bài nộp

- Bảng quyền: `../POLICY.md` (roles/actions, ngoại lệ Owner và tenant admin).
- Automated positive/negative tests: `../test/authorization.test.js`, `../scripts/idor-regression.js` và `../scripts/ui-smoke.js`.
- Evidence trước/sau: JSON response và regression logs trong thư mục này.
- Code diff enforcement: `authorization.diff`, hai snapshot và log regression tương ứng.
- Giải thích ACL/RBAC/ABAC/ReBAC, trust boundary và giới hạn: `../report.md`, `../report.html`, `../POLICY.md`.

## Giới hạn

Đây là kiểm chứng local trên working tree có thể chưa commit. SHA-256 xác định chính xác code được chạy; commit nền một mình không đại diện cho toàn bộ thay đổi. Không coi kết quả này là hosted CI, deployment, test tải/concurrency nhiều process hoặc xác thực production. Snapshot không mô phỏng migration schema qua từng version: mọi policy dùng cấu trúc dữ liệu chung đã có tenant, chỉ V4 enforce tenant boundary. Screenshots UI tạo trong `.local-check/` vẫn là artifact local bị Git ignore; log UI được lưu ở đây để nộp.
