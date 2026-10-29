# Task Authorization Minilab

Ứng dụng quản lý công việc local với giao diện tiếng Việt, dữ liệu SQLite và năm phiên bản policy **Starter → V1 → V2 → V3 → V4**. Người dùng thao tác qua danh sách project, bảng task và form; request/response và authorization trace nằm trong phần **Chi tiết kỹ thuật**.

## Chạy

Yêu cầu Node.js **22.13 trở lên**. Dùng SQLite tích hợp `node:sqlite`; Node 22 có thể in ExperimentalWarning.

```powershell
npm.cmd install
npm.cmd start
```

Mở **http://127.0.0.1:3000**. Server chỉ bind loopback; đổi port bằng biến môi trường `PORT`.

```powershell
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:idor -- --version=v1
npm.cmd run evidence
npm.cmd run db:reset
```

File `data/lab.sqlite` được tạo và seed khi chạy lần đầu. Restart giữ dữ liệu; **Khôi phục dữ liệu mẫu** mới nạp lại seed. Mọi version dùng chung database. Không commit database hoặc các file phụ SQLite.

`test:ui` dùng database tạm riêng và Chrome/Edge headless trên Windows, lưu screenshot desktop/mobile/đăng nhập trong `.local-check/` (Git ignore). Đặt `LAB_BROWSER` nếu trình duyệt ở đường dẫn khác. Test không sửa database đang demo.

## Sử dụng web app

1. Chọn tài khoản trên màn hình đăng nhập demo rồi bấm **Vào ứng dụng**.
2. Thanh trên cùng cho đổi Starter–V4 hoặc đổi tài khoản. Danh sách chung hiển thị ID/tên mọi project đang tồn tại để thử truy cập.
3. Bấm **Mở project** để xem bảng công việc. Quyền đọc nội dung được kiểm tra ở server theo version; danh mục có tên project không cấp quyền xem task/members.
4. Bấm **Xem** để đọc task hoặc **Sửa** để sửa tiêu đề, mô tả, trạng thái. Thành công cập nhật dữ liệu thật; từ chối hiển thị lý do và không lưu bản nháp.
5. Tab **Thành viên** hỗ trợ xem, thêm, đổi role Viewer/Member và xóa. Khi bị từ chối xem danh sách, form User ID vẫn cho thử các thao tác khác. Owner được giữ cố định; đổi/xóa Owner trả 409.
6. **Xóa project** cần xác nhận và cascade task/membership. Khôi phục dữ liệu mẫu trước mỗi lần so sánh thao tác xóa.
7. Mở **Chi tiết kỹ thuật** để xem kết quả thao tác vừa bấm, chọn các request gần đây và đọc trace server. Request tải lại sau mutation không thay kết quả đang xem.
8. **Công cụ demo nâng cao** có preset, token tùy chỉnh/Anonymous, query/header, JSON body và so sánh GET Starter/V1. Chỉ GET được so sánh tự động.

Các nút vẫn hiện khi thiếu quyền để demo request thật. Đổi tài khoản/version xóa dữ liệu bảo vệ, bản nháp và lịch sử kỹ thuật cũ; response đến muộn của ngữ cảnh cũ bị bỏ qua. Không thêm tạo project/task hoặc xóa task trong lần đổi UI này.

Khi server từ chối quyền truy cập, ứng dụng mở popup giải thích thân thiện: chưa tham gia dự án, thiếu quyền vai trò, khác tổ chức, không được giao công việc hoặc công việc đã đóng. Popup hướng dẫn bước tiếp theo; bấm **Đã hiểu** để trở lại, bản nháp trong form vẫn được giữ nguyên. HTTP status và mã lỗi đầy đủ có trong Chi tiết kỹ thuật.

Các thao tác ghi thành công (lưu task, thêm/đổi/xóa thành viên, xóa project, reset và request ghi tùy chỉnh) có popup xác nhận kết quả sau khi server xử lý. Các thao tác xem không hiện popup thành công.

Nút **Đổi role** ở mỗi thành viên mở hộp thoại chọn vai trò và **Lưu vai trò**. Lỗi quyền và nghiệp vụ như không thể đổi/xóa Owner, không tìm thấy thành viên hoặc thành viên đã tồn tại mở popup; form không lặp lại thông báo. Riêng lỗi nhập liệu 400 trong form sửa task/thành viên hiện cạnh trường cần sửa, không mở popup. Trang bị chặn chỉ giữ trạng thái không thể truy cập và nút quay lại sau khi popup đã giải thích lý do.

## Thử nhanh khác biệt giữa version

- Alice → Starter → Beta: mở được project và đọc B1. Chuyển V1–V4: bị từ chối, không còn bảng task Beta cũ.
- Vera → Alpha → sửa A1: Starter/V1 lưu được; V2–V4 từ chối do Viewer.
- Bob → Alpha → sửa A2 Closed: V2 lưu được; V3/V4 từ chối. Sửa A1 Open được; A3/A4 bị từ chối do không phải assignee.
- Admin Alpha chưa có membership → Alpha: V1–V3 từ chối, V4 được. Beta vẫn bị V4 từ chối do khác tenant.
- Bob xóa Alpha/quản lý members: Starter/V1 được; V2–V4 bị từ chối. Reset giữa các ca destructive.

Chi tiết các bước trình bày trong [DEMO.md](DEMO.md).

## API

Token demo: `demo-alice`, `demo-bob`, `demo-vera`, `demo-charlie`, `demo-admin-alpha`, `demo-admin-beta`. Đây là adapter mô phỏng authentication, không có JWT/OAuth2 hoặc mật khẩu mới.

| Method | Path sau `/api/:version` | Policy |
| --- | --- | --- |
| GET | `/projects` | Token hợp lệ; danh mục lab chỉ có ID/tên mọi project đang tồn tại |
| GET | `/projects/:id` | Quyền đọc nội dung project theo version |
| GET | `/projects/:id/tasks` | Quyền đọc project theo version; trả task trong project |
| GET/PATCH | `/tasks/:id` | Đọc/sửa task theo version |
| DELETE | `/projects/:id` | Xóa project theo version |
| GET/POST | `/projects/:id/members` | Quản lý members theo version |
| PATCH/DELETE | `/projects/:id/members/:userId` | Quản lý members theo version |

```powershell
curl.exe -i http://127.0.0.1:3000/api/starter/projects/beta/tasks -H "Authorization: Bearer demo-alice"
curl.exe -i http://127.0.0.1:3000/api/v1/projects/beta/tasks -H "Authorization: Bearer demo-alice"
```

PATCH task nhận `title`, `description`, `status` (Open/Closed). POST member nhận `userId`, `role`; PATCH member nhận `role` (Viewer/Member). Mutation thành công trả 200, tạo membership trả 201.

Response API có `{ data, error, trace, requestId }`. 401: token thiếu/sai; 403: thiếu quyền; 404: tài nguyên/version/route không tồn tại; 400: payload sai; 409: membership trùng hoặc sửa Owner cố định. Payload có thể bị kiểm tra sau bước authorization. Response từ chối không có nội dung tài nguyên bị chặn; trace không chứa token.

## Cấu trúc và giới hạn

- `src/auth.js`: principal từ token và SQLite.
- `src/policy.js`: PDP chung; `src/app.js`: routes, validation và PEP trước read/write.
- `src/db.js`, `src/schema.sql`: schema/seed/reset, prepared statements, foreign keys; mutation authorize và write trong cùng transaction.
- `public/`: UI HTML/CSS/JavaScript, điều hướng và form, kiểm soát response cũ khi đổi ngữ cảnh.
- `test/authorization.test.js`: HTTP permission matrix, API danh mục/chi tiết/list, validation/spoofing và persistence/reset/cascade.
- `scripts/ui-smoke.js`: luồng browser thật qua nút và form, xử lý từ chối, response cũ và mobile.

Đây là lab local: Starter cố ý có lỗ hổng, reset public có kiểm tra Origin, danh mục project cố ý discoverable. Bộ evidence tự động có trong [evidence/README.md](evidence/README.md): response IDOR trước/sau, regression đỏ/xanh, log test và diff tái dựng có kiểm chứng. Chạy `npm.cmd run evidence` để tái tạo bằng SQLite tạm; không chạm database demo. Chưa có authentication thật, concurrent load hoặc deployment. Xem [POLICY.md](POLICY.md), [UI-PLAN.md](UI-PLAN.md) và [plan.md](plan.md).
