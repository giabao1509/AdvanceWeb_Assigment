# Task Authorization Minilab

Ứng dụng local để thử cùng request qua Starter → V1 → V2 → V3 → V4. Dữ liệu lưu trong **SQLite**, UI hiển thị HTTP response và các check server thực sự đã chạy.

## Chạy

Yêu cầu Node.js **22.13 trở lên** (đã chạy trên 22.17.1). Dùng SQLite tích hợp `node:sqlite`; Node 22 có thể in ExperimentalWarning.

```powershell
npm.cmd install
npm.cmd start
```

Mở **http://127.0.0.1:3000**. Server chỉ bind loopback. Có thể đổi port bằng biến môi trường `PORT`.

```powershell
npm.cmd test       # HTTP tests, mỗi test dùng SQLite tạm riêng
npm.cmd run test:ui # Smoke test bằng Chrome/Edge headless đã cài trên Windows
npm.cmd run db:reset
```

File `data/lab.sqlite` tự tạo và seed ở lần đầu. Restart giữ dữ liệu; nút **Reset dữ liệu** hoặc lệnh reset mới khôi phục seed. Các version dùng chung database. Không commit database và các file phụ SQLite.

`test:ui` dùng database tạm, kiểm tra UI desktop/mobile và lưu screenshot tại `.local-check/ui.png` (được Git ignore). Nếu trình duyệt nằm ở đường dẫn khác, đặt biến `LAB_BROWSER` trỏ đến executable Chrome/Edge.

## Thử nhanh trên UI

1. Giữ Starter, chọn **IDOR · Alice đọc B1**, bấm **So sánh Starter / V1**: Starter 200 có dữ liệu Beta; V1 403 không có nội dung task.
2. Chọn V1, thử **Alice đọc A1** và **Charlie đọc B1**: cả hai 200. Anonymous nhận 401.
3. Chọn V2, thử **Bob sửa A2 · Closed**: 200 vì mới kiểm tra role Member. Chuyển V3, gửi lại: 403 vì task Closed.
4. Ở V3, Bob sửa A1 được; Bob sửa A3/A4 bị từ chối. Alice là Owner vẫn sửa A2 được.
5. Ở V4, Admin Alpha đọc A1 được, đọc B1 bị từ chối. Preset giả mạo Admin không làm Bob có quyền xóa project.
6. Thử các endpoint quản lý members bằng Alice. Bob/Vera không được quản lý members. Khi thêm member, body mẫu dùng `admin-alpha` làm user đích chưa có membership.

Chọn preset chỉ thay request, giữ nguyên version đang chọn. Chỉ so sánh tự động GET task để tránh gửi mutation hai lần. Ô token và header/query tùy chỉnh nằm trong phần mở rộng. Sửa JSON body để thử status, validation hoặc giả mạo field. Request không hợp lệ có thể bị từ chối quyền trước khi kiểm tra payload.

## API trực tiếp

Token demo: `demo-alice`, `demo-bob`, `demo-vera`, `demo-charlie`, `demo-admin-alpha`, `demo-admin-beta`. Đây là adapter mô phỏng authentication đã có; không xây JWT/OAuth2 mới.

```powershell
curl.exe -i http://127.0.0.1:3000/api/starter/tasks/B1 -H "Authorization: Bearer demo-alice"
curl.exe -i http://127.0.0.1:3000/api/v1/tasks/B1 -H "Authorization: Bearer demo-alice"
curl.exe -i http://127.0.0.1:3000/api/v3/tasks/A1 -H "Authorization: Bearer demo-bob"
```

| Method | Path sau `/api/:version` | Có từ |
| --- | --- | --- |
| GET | `/tasks/:id` | Starter |
| PATCH | `/tasks/:id` | V2 |
| DELETE | `/projects/:id` | V2 |
| GET/POST | `/projects/:id/members` | V2 |
| PATCH/DELETE | `/projects/:id/members/:userId` | V2 |

PATCH task nhận `title`, `description`, `status` (Open/Closed). POST member nhận `userId`, `role`; PATCH member nhận `role` (Viewer/Member). Owner cố định, không được xóa/hạ quyền. Xóa project cascade tasks/memberships. Mutation thành công trả 200, riêng tạo membership trả 201.

Mọi response API có `{ data, error, trace, requestId }`. 401: token thiếu/sai; 403: thiếu quyền; 404: không tồn tại/version hoặc endpoint chưa có; 400: dữ liệu sai; 409: membership trùng hoặc sửa Owner. Không trả task trong response từ chối. Trace chỉ có kết quả check và mã lý do, không có token hoặc nội dung task bị chặn.

## Code và giới hạn

- `src/auth.js`: resolve principal từ token và users trong SQLite.
- `src/policy.js`: PDP chung cho các version; `src/app.js`: PEP trước read/write, các route và validation.
- `src/db.js`, `src/schema.sql`: SQLite, seed/reset, foreign keys, prepared statements; mutation authorize và write trong cùng transaction.
- `public/`: UI thuần; fixture catalog chỉ là metadata cố định cho bài học, không đọc live data để vượt authorization.
- `test/authorization.test.js`: permission matrix, positive/negative HTTP cases, spoofing, state không đổi khi deny, persistence/reset/cascade.

Đây là lab local với Starter cố ý có lỗ hổng và endpoint reset public. Trace hỗ trợ học tập; chính sách từ chối dùng 403 nên có thể suy ra ID tồn tại. Không dùng ứng dụng này như cấu hình production. Chưa làm bộ evidence tự động, xác thực thật, concurrent load hoặc deployment. Chi tiết policy trong [POLICY.md](POLICY.md), kế hoạch trong [plan.md](plan.md).
