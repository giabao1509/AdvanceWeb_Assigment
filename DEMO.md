# Demo web app quản lý công việc và authorization

## Chuẩn bị

```powershell
npm.cmd install
npm.cmd start
```

Mở http://127.0.0.1:3000. Đăng nhập bằng tài khoản demo, bấm **Khôi phục dữ liệu mẫu → Xác nhận**. Các version dùng chung SQLite; reset trước mỗi ca xóa và trước khi cần quay về seed. Restart không reset dữ liệu.

Giao diện chính là ứng dụng quản lý công việc. **Chi tiết kỹ thuật** và **Công cụ demo nâng cao** chỉ mở khi cần giải thích API. Đổi tài khoản bằng nút trên thanh trên cùng; version hiện tại được giữ khi đổi tài khoản.

## 1. Starter → V1: người ngoài mở project

1. Đăng nhập Alice, chọn Starter.
2. Danh sách chung hiện Alpha và Beta. Danh mục lab chỉ công khai ID/tên sau xác thực, không phải quyền xem nội dung.
3. Bấm **Mở project** ở Beta: thấy bảng B1/B2. Bấm **Xem** ở B1: thấy mô tả Private Beta.
4. Đóng chi tiết task, chuyển V1 ngay tại project Beta: ứng dụng hiện thông báo không phải thành viên, bảng task cũ biến mất.
5. Mở **Chi tiết kỹ thuật**: GET project bị 403, membership FAIL. Chuyển V4 để thấy tenant boundary FAIL.
6. Về danh sách, mở Alpha ở V1: vẫn xem/đọc task được.
7. Đổi tài khoản Charlie, mở Beta: đọc được ở V1.

Điểm trình bày: Starter xác thực được caller nhưng thiếu object authorization. V1 kiểm tra membership ở server. Danh mục để thử truy cập không làm lộ nội dung task khi bị chặn.

## 2. V1 → V2: Viewer và quyền thao tác

1. Đổi tài khoản Vera, chọn V1, mở Alpha.
2. Bấm **Sửa** A1, sửa tiêu đề rồi **Lưu thay đổi**: thành công, bảng cập nhật.
3. Chuyển V2, sửa A1 tiếp: hiện lý do vai trò không có quyền; form giữ bản nháp, database không đổi.
4. Đóng form, bấm **Xem** A1: vẫn đọc được.
5. Mở tab **Thành viên**: không được xem danh sách. Form theo User ID vẫn cho thử thêm/đổi/xóa; server vẫn từ chối từng request.
6. Bấm **Xóa project → Xác nhận**: bị từ chối; project còn nguyên.

Điểm trình bày: V1 mới kiểm tra membership, chưa phân biệt role. V2 thêm RBAC. Nút vẫn tồn tại nhưng quyền được enforce ở server.

## 3. V2 → V3: assignee và trạng thái task

1. Đổi tài khoản Bob, chọn V2, mở Alpha.
2. Sửa tiêu đề A2 đang Closed: lưu được.
3. Chuyển V3, sửa A2: bị từ chối do task đã đóng, kể cả chọn trạng thái Đang mở trong form.
4. Sửa A3 hoặc A4: bị từ chối vì không được giao cho Bob.
5. Sửa A1 đang Open: lưu được.
6. Sửa A1 thành Đã đóng: lưu được; mở form lại để đổi sang Đang mở: bị từ chối.
7. Đổi tài khoản Alice ở V3, mở Alpha, sửa A1 thành Đang mở: Owner được phép.

Điểm trình bày: policy xét dữ liệu hiện tại trong database trước khi áp dụng payload. Quan hệ assignee và trạng thái bổ sung cho role Member.

## 4. V4: tenant admin

1. Khôi phục dữ liệu mẫu để admin chưa có membership.
2. Đổi tài khoản Admin Alpha, chọn V3, mở Alpha: bị từ chối vì chưa có membership.
3. Chuyển V4: xem được Alpha và task do admin trong cùng tenant.
4. Về danh sách, mở Beta: từ chối do khác tenant.
5. Mở Công cụ demo nâng cao, để GET `tasks/B1`, token `demo-admin-alpha`, query `tenantId=beta&role=Admin`, headers `{"X-Role":"Admin","X-Tenant-Id":"beta"}`.
6. Gửi: vẫn từ chối. Đọc tenant check trong Chi tiết kỹ thuật.

## 5. Quản lý thành viên

1. Alice, V2, Alpha, tab Thành viên.
2. Thao tác Thêm, User ID `admin-alpha`, role Viewer: thành công 201, danh sách cập nhật.
3. Bấm Đổi role ở hàng admin-alpha, chọn Member và Thực hiện: role thay đổi.
4. Bấm Xóa ở hàng admin-alpha, xác nhận: thành viên biến mất.
5. Bấm Xóa ở hàng Alice, xác nhận: 409, Owner cố định.
6. Thử thêm Bob vốn đã có membership: 409, trùng membership.
7. Thử User ID không tồn tại: 404.
8. Để demo thu hồi quyền: ở V3, Alice xóa Bob; đổi tài khoản Bob rồi mở Alpha: bị từ chối dù task vẫn assign Bob. Reset sau khi thử.

## 6. Xóa project, reset và persistence

1. Reset; Bob ở V2 thử xóa Alpha: từ chối.
2. Alice ở V2 xóa Alpha: quay về danh sách chỉ còn Beta. Tasks/memberships Alpha đã cascade.
3. Reset: Alpha và task được khôi phục.
4. Sửa tiêu đề A1, dừng server và chạy lại. Đăng nhập lại, đọc A1: tiêu đề đã lưu vẫn còn. Reset mới đưa dữ liệu về seed.

## 7. Response, Anonymous và so sánh

- Sau thao tác, mở Chi tiết kỹ thuật để xem method/URL, status, response, requestId và trace. Chọn lịch sử nếu cần xem request khác.
- Công cụ nâng cao: token trống hoặc sai → 401. POST/PATCH với JSON hỏng báo lỗi trước khi gửi.
- GET `tasks/B1`, token `demo-alice`, bấm So sánh GET Starter / V1: thông báo 200 → 403; chọn từng request trong lịch sử để xem hai response.
- Chỉ so sánh GET, không tự gửi mutation qua nhiều version.

## 8. Kiểm tra trực tiếp

```powershell
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:idor -- --version=starter
npm.cmd run test:idor -- --version=v1
npm.cmd run evidence
curl.exe -i http://127.0.0.1:3000/api/starter/projects/beta/tasks -H "Authorization: Bearer demo-alice"
curl.exe -i http://127.0.0.1:3000/api/v1/projects/beta/tasks -H "Authorization: Bearer demo-alice"
```

Hai curl lần lượt 200 và 403. Tests dùng database tạm riêng; đọc output thực tế để báo kết quả. Browser test đi qua đăng nhập, project/task, forms, members, xóa/reset, các version, response đến muộn và layout mobile. Screenshot ở `.local-check/`.

Regression riêng cùng oracle cố ý đỏ ở Starter (exit 1, một lỗi Alice/B1, hai legitimate reads pass) và xanh ở V1 (exit 0, ba pass). `npm.cmd run evidence` thu response/log thực tế vào `evidence/`, dùng SQLite tạm; xem `evidence/README.md`. Diff và hai snapshot trong bộ evidence là tái dựng có kiểm chứng, không phải hai commit lịch sử.

Nếu kết quả khác mong đợi, kiểm tra tài khoản, version và trạng thái dữ liệu hiện tại. Tài nguyên đã bị xóa trả 404; không dùng nó để chứng minh 403 do policy.
