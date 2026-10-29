# Kịch bản demo Task Authorization Minilab

Thời lượng gợi ý: **10–15 phút** cho phần chính. Phần mở rộng dùng khi cần trình bày quản lý members, xóa project và lưu SQLite.

Mục tiêu: cho thấy cùng một danh tính và tài nguyên có thể nhận kết quả khác nhau khi policy được nâng cấp từ Starter → V1 → V2 → V3 → V4. Luôn demo cả request thành công và bị từ chối.

## 1. Chuẩn bị

Chạy trong thư mục project:

```powershell
npm.cmd install
npm.cmd start
```

Nếu server đã chạy thì không mở thêm một server trên cùng port. Mở **http://127.0.0.1:3000**, bấm **Reset dữ liệu** trước khi bắt đầu.

Giải thích ngắn:

> “Lab mô phỏng ứng dụng đã có authentication. Token demo chỉ giúp server xác định caller. Nội dung thực hành là server kiểm tra caller được thao tác trên tài nguyên nào.”

Giới thiệu ba vùng trên UI:

- **Request:** chọn version, tình huống, danh tính, thao tác và ID.
- **Response:** HTTP status, dữ liệu hoặc mã lỗi.
- **Authorization trace:** các check thực tế đã chạy tại server, gồm PASS/FAIL/SKIPPED và ALLOW/DENY.

Lưu ý khi thao tác:

- Chọn tình huống nhanh **không tự đổi version**; luôn kiểm tra tab đang chọn.
- Khi đổi thao tác, UI có thể đặt lại ID và JSON body; nhập ID/body sau khi chọn thao tác.
- Các version dùng chung SQLite. Mutation ảnh hưởng các bước sau; restart không reset dữ liệu.
- Mọi version có cùng bộ endpoint, chỉ khác policy. Starter cho mọi caller có token thao tác trên mọi project; V1 yêu cầu membership nhưng chưa phân biệt Viewer/Member/Owner. Validation và quy tắc Owner cố định vẫn áp dụng.
- Mỗi lần gửi chỉ hiển thị kết quả mới. Nút **So sánh Starter / V1** dành cho GET task để giữ hai kết quả cạnh nhau.
- Kết quả trong tài liệu là **kết quả mong đợi** trên seed ban đầu, không phải bộ evidence đã ghi sẵn.

### Dữ liệu cần nhớ

| Project | User và vai trò | Task |
| --- | --- | --- |
| Alpha | Alice = Owner; Bob = Member; Vera = Viewer | A1: Bob/Open; A2: Bob/Closed; A3: chưa assign/Open; A4: Alice/Open |
| Beta | Charlie = Owner | B1: Charlie/Open; B2: chưa assign/Open |

`admin-alpha` và `admin-beta` là tenant admin, có đặc quyền từ **V4**. Ban đầu họ chưa có project membership.

## 2. Starter → V1: tái hiện và sửa IDOR — khoảng 3 phút

### Bước 1: Cho thấy lỗ hổng

1. Chọn tab **Starter**.
2. Trong **Tình huống nhanh**, chọn **IDOR · Alice đọc B1**.
3. Bấm **Gửi request**.

**Mong đợi:** HTTP **200**, có dữ liệu B1 thuộc Project Beta. Trace có Authentication PASS và Object authorization SKIPPED.

Lời trình bày:

> “Alice có token hợp lệ nhưng chỉ là Owner của Alpha. Starter chỉ xác thực token nên Alice đổi task ID thành B1 và đọc được dữ liệu của Beta. Đây là IDOR/BOLA.”

### Bước 2: So sánh cùng request với V1

Giữ nguyên Alice/B1, bấm **So sánh Starter / V1**.

**Mong đợi:**

| Version | Status | Nội dung |
| --- | --- | --- |
| Starter | 200 | Có dữ liệu B1 |
| V1 | 403 | `data: null`, lỗi `NOT_PROJECT_MEMBER` |

Chỉ vào trace V1: Authentication PASS → Project membership FAIL → Decision DENY.

Lời trình bày:

> “V1 kế thừa authentication và thêm object-level authorization. Server lấy project của task từ dữ liệu rồi kiểm tra membership của caller. Không tin project hoặc role tự khai từ request.”

### Bước 3: Chứng minh bản sửa vẫn cho request đúng đi qua

Chọn tab **V1**, lần lượt chọn preset và bấm **Gửi request**:

| Tình huống nhanh | Status mong đợi | Ý nghĩa |
| --- | --- | --- |
| Hợp lệ · Alice đọc A1 | 200 | Alice vẫn đọc được task trong Alpha |
| Hợp lệ · Charlie đọc B1 | 200 | Charlie vẫn đọc được task trong Beta |
| Anonymous đọc A1 | 401 | Thiếu authentication bị chặn trước policy tài nguyên |

> “401 là chưa xác thực hợp lệ. 403 là đã xác thực nhưng không có quyền. Bản sửa phải chặn request sai và giữ request đúng hoạt động.”

## 3. V2: RBAC theo project — khoảng 2 phút

Trước khi vào bảng dưới, chọn preset **Viewer thử sửa A1**, gửi lần lượt ở **Starter → V1 → V2**. Mong đợi **200 → 200 → 403**: cùng endpoint PATCH, V1 cho phép vì Vera có membership; V2 mới từ chối do role Viewer. Body mặc định chỉ sửa title nên không ảnh hưởng status/assignee ở các bước sau.

Chọn tab **V2**. Trong bước này chỉ sửa title, không đổi status.

| Thứ tự | Tình huống/thao tác | Mong đợi |
| --- | --- | --- |
| 1 | Preset **Viewer thử sửa A1** | 403, `ROLE_DENIED` |
| 2 | Giữ Vera, đổi thao tác thành **GET · Đọc task**, ID `A1`, gửi | 200 |
| 3 | Preset **Bob sửa A1 · assigned + Open**, gửi | 200, title được cập nhật |
| 4 | Preset **Bob thử xóa Project Alpha**, gửi | 403, project còn nguyên |
| 5 | Preset **Alice quản lý members Alpha**, gửi | 200, danh sách Alice/Bob/Vera |

Chỉ vào check **Project role** trong trace.

Lời trình bày:

> “V2 giữ kiểm tra membership của V1 rồi bổ sung quyền theo role trong từng project. Viewer đọc, Member đọc và sửa, Owner thêm quyền xóa project và quản lý thành viên. Là Owner của Alpha không tạo quyền ở Beta.”

Nếu muốn so sánh DELETE: với preset **Bob thử xóa Project Alpha**, bấm Reset trước mỗi request, thử ở Starter/V1/V2. Mong đợi **200/200/403**. Reset sau cùng để tiếp tục demo. Không gửi liên tiếp trên project đã bị xóa, vì 404 khi đó là tài nguyên không còn tồn tại.

## 4. V2 → V3: thêm quan hệ assignee và trạng thái — khoảng 3 phút

### Bước 1: Cùng Bob/A2 nhưng policy khác nhau

1. Ở tab **V2**, chọn **Bob sửa A2 · Closed**.
2. Giữ body mặc định chỉ cập nhật `title`, bấm **Gửi request**.
3. Chuyển tab **V3**, giữ cùng request, gửi lại.

| Version | Mong đợi | Lý do |
| --- | --- | --- |
| V2 | 200 | Bob là Member nên có quyền sửa theo RBAC |
| V3 | 403, `TASK_CLOSED` | Bob đúng assignee nhưng trạng thái hiện tại là Closed |

Trace V3 phải cho thấy membership và role PASS, assignee PASS, status FAIL.

> “Role Member chưa đủ để quyết định sửa task. V3 kế thừa V2 và kiểm tra thêm quan hệ user–task cùng trạng thái task đang lưu trên server.”

### Bước 2: Kiểm tra đủ các điều kiện

Ở **V3**, lần lượt chọn preset và gửi:

| Tình huống nhanh | Mong đợi | Giải thích |
| --- | --- | --- |
| Bob sửa A1 · assigned + Open | 200 | Đúng project, đúng assignee, task Open |
| Bob sửa A3 · chưa assign | 403, `NOT_ASSIGNEE` | Chưa assign không có nghĩa ai cũng được sửa |
| Bob sửa A4 · assign Alice | 403, `NOT_ASSIGNEE` | Cùng project nhưng assign người khác |
| Owner sửa A2 · Closed | 200 | Policy cho Owner sửa task Closed trong project mình |

Để thử task khác project: chọn preset **Bob sửa A1 · assigned + Open**, đổi **Task ID** thành `B1`, gửi. Mong đợi **403**, `NOT_PROJECT_MEMBER`.

### Bước 3: Caller không thể tự khai trạng thái để vượt policy

1. Ở V3, chọn **Bob sửa A2 · Closed**.
2. Thay JSON body bằng:

```json
{"status":"Open"}
```

3. Gửi request.

**Mong đợi:** 403, `TASK_CLOSED`. Server kiểm tra trạng thái hiện tại trước khi áp dụng payload.

Nếu còn thời gian, chọn **Bob sửa A1 · assigned + Open**, gửi body `{"status":"Closed"}`: lần đầu **200**. Đổi body thành `{"status":"Open"}` rồi gửi tiếp: **403**. Bấm **Reset dữ liệu** sau phần này.

## 5. V4: tenant boundary và giả mạo quyền — khoảng 2 phút

Bấm **Reset dữ liệu** để đảm bảo admin chưa được thêm membership ở bước demo khác. Chọn tab **V4**.

| Tình huống nhanh | Mong đợi | Trace cần chỉ ra |
| --- | --- | --- |
| Admin Alpha đọc A1 · cùng tenant | 200 | Tenant boundary PASS → Tenant admin PASS |
| Admin Alpha đọc B1 · khác tenant | 403, `TENANT_MISMATCH` | Tenant boundary FAIL, không xét quyền admin tiếp |

> “Tenant admin có quyền rộng trong tenant của mình. Tenant boundary được kiểm tra trước đặc quyền admin, nên Admin Alpha không trở thành admin toàn hệ thống.”

### Thử giả mạo tenant và role

1. Giữ Admin Alpha đọc B1 ở V4.
2. Mở **Token và request tùy chỉnh**.
3. Ô Query nhập:

```text
tenantId=beta&role=Admin
```

4. Ô Headers bổ sung nhập:

```json
{"X-Tenant-Id":"beta","X-Role":"Admin"}
```

5. Gửi: vẫn **403**, `TENANT_MISMATCH`.
6. Chọn preset **Giả mạo role=Admin · Bob xóa Alpha**, gửi: **403**, `ROLE_DENIED`.

> “Role và tenant của caller được server resolve từ principal và dữ liệu. Query/header tự khai không tăng quyền.”

Để thử body giả mạo: chọn preset **Owner sửa A2 · Closed**, thay body thành `{"title":"Attempt","role":"Admin"}`, gửi ở V4. Mong đợi **400**, `INVALID_FIELDS`. Dùng Owner cho tình huống này để request qua bước kiểm tra quyền và đi đến validation body.

## 6. Request trực tiếp và automated tests — khoảng 1–2 phút

Mở terminal thứ hai trong project; giữ server đang chạy. Gọi API trực tiếp, không qua UI:

```powershell
curl.exe -i "http://127.0.0.1:3000/api/starter/tasks/B1" -H "Authorization: Bearer demo-alice"
curl.exe -i "http://127.0.0.1:3000/api/v1/tasks/B1" -H "Authorization: Bearer demo-alice"
curl.exe -i "http://127.0.0.1:3000/api/v4/tasks/B1?tenantId=beta&role=Admin" -H "Authorization: Bearer demo-admin-alpha" -H "X-Tenant-Id: beta" -H "X-Role: Admin"
```

**Mong đợi theo thứ tự:** 200, 403, 403. Response từ chối có `data: null`.

> “Ẩn nút trên giao diện không ngăn được HTTP request trực tiếp. Enforcement nằm ở server nên UI và curl đều chịu cùng policy.”

Chạy tests:

```powershell
npm.cmd test
```

Chỉ vào kết quả pass/fail thực tế. Bộ test có characterization cho Starter cố ý có IDOR; các case của V1–V4 kiểm tra cả cho phép và từ chối. Test dùng SQLite tạm riêng, không reset database đang demo.

Nếu cần kiểm tra trình duyệt tự động:

```powershell
npm.cmd run test:ui
```

Lệnh này cần Chrome/Edge local, dùng database tạm riêng. Không bắt buộc chạy trong bài demo ngắn.

## 7. Phần mở rộng: quản lý thành viên — khoảng 3 phút

Bấm **Reset dữ liệu**, chọn **V2**. Chọn danh tính `alice`, rồi thao tác theo bảng. Nhập lại Project ID `alpha` nếu đổi thao tác làm UI đặt lại giá trị.

| Bước | Thao tác và dữ liệu | Mong đợi |
| --- | --- | --- |
| 1 | **GET · Xem members**, project `alpha` | 200; Alice Owner, Bob Member, Vera Viewer |
| 2 | **POST · Thêm member**, project `alpha`, body `{"userId":"admin-alpha","role":"Viewer"}` | 201 |
| 3 | **PATCH · Đổi role member**, project `alpha`, User ID của member `admin-alpha`, body `{"role":"Member"}` | 200 |
| 4 | **GET · Xem members**, project `alpha` | 200; `admin-alpha` có role Member |
| 5 | **DELETE · Xóa member**, project `alpha`, User ID của member `admin-alpha` | 200 |
| 6 | Giữ thao tác DELETE member, User ID của member `alice` | 409, `OWNER_IS_FIXED` |
| 7 | Chọn danh tính `bob`, thao tác **GET · Xem members**, project `alpha` | 403 |

Giải thích: `role` trong API membership là role **của user đích**. Caller vẫn phải có quyền quản lý members trước khi server chấp nhận thay đổi đó. Ở V2, tên `admin-alpha` không tạo đặc quyền tenant admin; đặc quyền này chỉ được bật từ V4.

Nếu cần minh họa thu hồi quyền: ở V3, Alice xóa membership của Bob khỏi Alpha; sau đó dùng preset Bob sửa A1. Task vẫn assign Bob nhưng request bị **403** do mất membership. Reset sau khi thử.

## 8. Phần mở rộng: xóa project và kiểm tra SQLite — khoảng 2 phút

### Xóa project

1. **Reset dữ liệu**, chọn V2.
2. Chọn **Bob thử xóa Project Alpha**, gửi: **403**.
3. Chỉ đổi danh tính thành `alice`, giữ DELETE project `alpha`, gửi: **200**, `deleted: "alpha"`.
4. Chọn preset **Hợp lệ · Alice đọc A1**, gửi ở V2: **404**, task đã bị xóa theo project.
5. **Reset dữ liệu**, gửi lại Alice/A1: **200**.

### Dữ liệu tồn tại qua restart

1. Reset, chọn V3, preset **Bob sửa A1 · assigned + Open**.
2. Sửa body thành `{"title":"SQLite persistence demo"}`, gửi: **200**.
3. Dừng server bằng `Ctrl+C`, chạy lại `npm.cmd start`.
4. Reload UI, chọn V1 và preset **Hợp lệ · Alice đọc A1**, gửi.
5. Mong đợi **200**, title vẫn là `SQLite persistence demo`.
6. Bấm Reset rồi gửi lại: title về dữ liệu seed.

## 9. Lời kết và câu hỏi phản biện

> “Các version giữ cùng endpoint. Starter chỉ biết caller là ai. V1 bổ sung membership trên object cho mọi thao tác. V2 tổ chức quyền theo role trong project. V3 thêm quan hệ assignee và thuộc tính trạng thái. V4 đặt tenant boundary trước các quyền còn lại. Mọi quyết định đều được enforce tại server.”

| Câu hỏi | Ý trả lời ngắn |
| --- | --- |
| Scope `tasks:read` đủ để Alice đọc B1 không? | Không. Scope cho phép loại thao tác, vẫn cần quyền trên đúng task/project/tenant. Lab không triển khai OAuth scope thực tế. |
| Member cần thêm điều kiện gì để sửa ở V3? | Membership hiện tại trong project chứa task, đúng assignee, task đang Open. |
| Vì sao ẩn Delete không đủ? | Caller gọi HTTP trực tiếp được; server phải kiểm tra quyền trước mutation. |
| Policy lớn nên tổ chức thế nào? | Dùng policy dùng chung, PEP nhất quán ở các API, mô hình quan hệ rõ ràng và tests theo matrix; cân nhắc PDP chuyên dụng khi quy mô tăng. |

Nếu kết quả lệch mong đợi, kiểm tra tab version, danh tính/token, ID, JSON body và query/header tùy chỉnh; sau đó Reset seed và chạy lại. Task không tồn tại trả 404, không thể dùng nó để chứng minh policy từ chối tài nguyên đang tồn tại.
