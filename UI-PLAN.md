# Kế hoạch chuyển UI lab thành web app quản lý công việc

Ngày chốt yêu cầu: 2026-10-29. Trạng thái: đã triển khai và kiểm tra local bằng HTTP tests, browser smoke và screenshot. Chưa có nghiệm thu trực tiếp từ người dùng/giảng viên.

## 1. Các quyết định đã chốt

- Giao diện tiếng Việt, nền sáng, luồng project → bảng task → chi tiết/form sửa.
- Hiển thị mọi project trong một danh sách chung để thử truy cập project ngoài membership.
- Giữ các nút thao tác khi thiếu quyền; gửi request thật và hiển thị kết quả server trong app.
- Màn hình đăng nhập chọn tài khoản demo; thanh trên cùng cho đổi Starter–V4 và đổi tài khoản.
- Hoàn thiện luồng cho API hiện có, bổ sung API đọc cần cho UI. Chưa thêm tạo project, tạo task hoặc xóa task.
- Response và authorization trace là phần phụ, mở bằng nút “Chi tiết kỹ thuật”.

## 2. Màn hình và luồng sử dụng

### Đăng nhập demo

- Chọn Alice, Bob, Vera, Charlie, Admin Alpha hoặc Admin Beta rồi vào ứng dụng; ghi rõ đây là tài khoản demo.
- Giữ adapter token hiện tại, không thêm mật khẩu hoặc hệ thống xác thực mới.
- Đưa thử Anonymous/token sai vào tiện ích kiểm thử mở rộng để vẫn demo được 401.

### Danh sách project

- Hiện toàn bộ project đang tồn tại từ SQLite trong một danh sách chung, với ID, tên và nút “Mở project”.
- Danh mục ID/tên là thông tin cố ý cho phép khám phá trong lab ở mọi version sau xác thực. Đây là ngoại lệ của API danh sách, không cấp quyền đọc nội dung project.
- Không kèm task, số task, danh sách thành viên hoặc nội dung được bảo vệ trong API danh mục.
- Không tự gọi API chi tiết của mọi project khi tải danh sách để tránh thông báo từ chối hàng loạt.
- Alice mở Beta: Starter hiện project và task; V1–V4 hiện trạng thái từ chối, có nút về danh sách.

### Chi tiết project và bảng task

- Sau khi API cho phép, hiện thông tin project và tab “Công việc”, “Thành viên”.
- Bảng task: ID, tiêu đề, người được giao, trạng thái và nút “Xem”, “Sửa”.
- “Xem” gọi API đọc task và hiển thị nội dung; “Sửa” mở form title, description, trạng thái Open/Closed.
- Nhãn trạng thái hiển thị tiếng Việt; payload vẫn dùng Open/Closed.
- Không sửa assignee/project/tenant vì API hiện tại không hỗ trợ các field này.
- Lưu thành công: cập nhật nội dung và bảng bằng dữ liệu server; bị từ chối: giữ dữ liệu đã lưu, giữ bản nháp để người dùng đọc/sửa, hiện lý do rõ ràng.
- Có nút “Xóa project” và hộp thoại xác nhận; xóa thành công quay về danh sách và tải lại danh mục.

### Thành viên

- Mở tab mới gọi API xem members; không dùng quyền đọc task để suy ra quyền xem members.
- Với V2 trở lên, Member/Viewer vẫn có thể vào project để đọc task nhưng tab thành viên có thể bị từ chối.
- Có form thêm thành viên, đổi role Viewer/Member và nút xóa thành viên.
- Khi danh sách bị từ chối, vẫn có khu vực thao tác theo user ID để thử POST/PATCH/DELETE trực tiếp; không cần tải lén danh sách để dựng nút.
- Giữ Owner cố định. Thao tác đổi/xóa Owner hiện lỗi 409 từ server.
- Thêm, đổi role hoặc xóa thành công phải tải lại danh sách; lỗi không làm thay đổi state hiển thị như đã thành công.

### Chi tiết kỹ thuật và tiện ích demo

- Nút mở panel phụ: method/URL, HTTP status, response, requestId và authorization trace thực tế.
- Lưu các thao tác gần đây trong ngữ cảnh tài khoản/version để chọn xem; request tải nền không ghi đè kết quả thao tác người dùng vừa bấm.
- Thông báo chính dùng ngôn ngữ ứng dụng, chẳng hạn “Đã lưu thay đổi”, “Bạn không có quyền sửa task này”, “Task không còn tồn tại”.
- Không dựng kết quả thành công/thất bại từ một bảng expected behavior ở frontend. Kết quả luôn lấy từ server.
- Đưa preset, token/query/header tùy chỉnh và so sánh GET vào phần công cụ demo thu gọn; preset điều hướng đến tài nguyên tương ứng.
- Không tự phát lại mutation khi so sánh version.
- Reset có xác nhận, giải thích các version dùng chung SQLite; thành công thì bỏ dữ liệu cũ và tải lại từ server.

## 3. Hợp đồng API cần bổ sung

Mọi đường dẫn dưới đây nằm sau `/api/:version`, dùng envelope `{ data, error, trace, requestId }` hiện tại.

| API | Dữ liệu và quy tắc |
| --- | --- |
| GET `/projects` | Danh mục project đang tồn tại, chỉ ID/tên, yêu cầu token ở mọi version; cố ý cho khám phá toàn bộ project trong lab |
| GET `/projects/:id` | Chi tiết project; áp dụng policy đọc theo version trước khi trả dữ liệu |
| GET `/projects/:id/tasks` | Task trong project; áp dụng policy đọc theo version trước khi truy vấn/trả nội dung |

Hai API đọc nội dung dùng action đọc hiện tại, không dùng action quản lý members. Không tự tạo API lấy toàn bộ task xuyên project để tránh thêm một đường đọc có semantics khác.

Giữ nguyên các API đọc/sửa task, xóa project, xem/thêm/đổi/xóa member. Không thay permission matrix hiện có. Cập nhật tài liệu policy để phân biệt danh mục project có thể khám phá với nội dung project cần được authorize.

## 4. Hành vi cần giữ đúng

Các trường hợp dưới đây xét trên seed ban đầu, token hợp lệ và payload đúng. Reset giữa các ca destructive hoặc khi mutation trước đó thay đổi điều kiện policy.

| Tình huống | Starter | V1 | V2 | V3 | V4 |
| --- | --- | --- | --- | --- | --- |
| Alice mở Beta/đọc B1 | Hiện nội dung | Từ chối | Từ chối | Từ chối | Từ chối |
| Vera đọc A1 | Cho phép | Cho phép | Cho phép | Cho phép | Cho phép |
| Vera sửa A1 | Lưu được | Lưu được | Từ chối | Từ chối | Từ chối |
| Bob sửa A1, được giao và Open | Lưu được | Lưu được | Lưu được | Lưu được | Lưu được |
| Bob sửa A2, Closed | Lưu được | Lưu được | Lưu được | Từ chối | Từ chối |
| Bob sửa A3/A4, không được giao | Lưu được | Lưu được | Lưu được | Từ chối | Từ chối |
| Bob xóa Alpha/quản lý members | Cho phép | Cho phép | Từ chối | Từ chối | Từ chối |
| Admin Alpha mở Alpha, chưa có membership | Cho phép | Từ chối | Từ chối | Từ chối | Cho phép |
| Admin Alpha mở Beta | Cho phép | Từ chối | Từ chối | Từ chối | Từ chối |

- 401: hiện yêu cầu chọn lại tài khoản; 403: thông báo thiếu quyền; 404: tài nguyên không còn tồn tại; 400/409: hiện lỗi tại form hoặc thao tác liên quan.
- Member đóng task Open của mình ở V3/V4 được; sửa tiếp hoặc tự mở lại bị từ chối. Owner hợp lệ vẫn mở lại được.
- Xóa membership có hiệu lực từ request tiếp theo, kể cả task vẫn assign cho người đó.
- Đổi tài khoản/version phải xóa nội dung được bảo vệ, bản nháp và lịch sử kỹ thuật cũ rồi tải lại qua API mới. Bỏ response đến muộn của ngữ cảnh cũ để không render dữ liệu sai tài khoản/version.
- Nếu đang ở project không có quyền sau khi đổi version, hiện trạng thái từ chối thay vì giữ bảng task cũ.

## 5. Thứ tự triển khai và file dự kiến

| Bước | Công việc | File chính | Điều kiện hoàn tất |
| --- | --- | --- | --- |
| 1 | Bổ sung API danh mục/chi tiết/task theo project và test quyền | `src/app.js`, `test/authorization.test.js`, `POLICY.md` | Danh mục chỉ trả ID/tên; nội dung theo đúng version; deny không lộ dữ liệu |
| 2 | Dựng đăng nhập demo, navigation, danh sách project, bảng task | `public/index.html`, `public/app.js`, `public/styles.css` | Đi được từ tài khoản đến task bằng nút và danh sách |
| 3 | Hoàn thiện form sửa, members và xóa project | `public/` | Mutation thật, cập nhật state sau thành công, xử lý lỗi rõ ràng |
| 4 | Panel kỹ thuật, preset, reset, đổi ngữ cảnh | `public/` | Trace đúng thao tác; dữ liệu cũ không tồn tại sau đổi ngữ cảnh |
| 5 | Kiểm tra API/browser và cập nhật hướng dẫn | `scripts/ui-smoke.js`, `test/authorization.test.js`, `README.md`, `DEMO.md`, `plan.md` | Kết quả kiểm tra thực tế và kịch bản demo khớp UI mới |

Giữ stack HTML/CSS/JavaScript, Express và SQLite hiện tại. Có thể tách module frontend khi cần để quản lý state, API và render; chưa cần thêm framework.

## 6. Tiêu chí nghiệm thu

- [x] Màn hình mặc định là ứng dụng project/task; không cần nhập URL, ID hoặc JSON để dùng luồng thông thường.
- [x] Danh sách chung hiển thị các project đang tồn tại; project bị xóa biến mất, reset khôi phục lại.
- [x] Cùng Alice/Beta: Starter hiện nội dung, V1–V4 từ chối và không hiển thị task cũ.
- [x] Có UI tương ứng cho toàn bộ API hiện có; nút thiếu quyền vẫn thử được request thật.
- [x] Thành viên không có quyền xem members vẫn đọc task được khi policy cho phép.
- [x] Kiểm tra 401/403/404/400/409, state không đổi khi deny và đọc lại sau mutation.
- [x] Đổi version/tài khoản trong khi request đang chạy không render response của ngữ cảnh cũ.
- [x] Browser tests đi qua đăng nhập → project → task → sửa và quản lý members/xóa, không chỉ kiểm tra JSON.
- [x] Giao diện desktop/mobile không tràn ngang, form có label, thông báo có live/status role; Escape đóng modal đã kiểm tra qua browser. Chưa audit accessibility hoặc toàn bộ luồng bàn phím bằng tay.
- [x] Chạy `npm.cmd test` và `npm.cmd run test:ui`; ghi kết quả thực tế, không đánh dấu hoàn tất trước khi chạy.
- [x] README/DEMO mô tả UI mới, ngoại lệ khám phá danh mục và việc mọi version dùng chung SQLite.

## 7. Quan hệ với kế hoạch cũ

Tài liệu này thay định hướng UI request/response trong mục 6 của `plan.md`. Phần “UI quản trị hoàn chỉnh” từng nằm ngoài phạm vi được mở rộng theo yêu cầu mới đến mức hỗ trợ API hiện có; tạo project, tạo task, xóa task và authentication thật tiếp tục ngoài phạm vi. Khi triển khai sẽ cập nhật các mục liên quan trong `plan.md`, không dùng trạng thái UI cũ làm bằng chứng nghiệm thu UI mới.

## 8. Kết quả triển khai và xác minh local

Ngày kiểm tra: 2026-10-29.

- `npm.cmd test`: PASS 46/46 tests, gồm policy matrix cũ và hai nhóm regression mới cho directory/detail/task list, data leakage, state sau mutation/revoke/delete/reset.
- `npm.cmd run test:ui`: PASS trên Chrome/Edge headless với SQLite tạm. Browser cần quyền chạy ngoài sandbox của phiên làm việc này; lần thử trong sandbox timeout ở CDP Runtime.enable. Không sửa database demo.
- Browser test đi qua tài khoản/project/task/form; sửa thành công và từ chối; Member edit Closed/unassigned; thêm/đổi/xóa member; Owner 409; xóa project/cascade/reset; Anonymous, spoofing, GET compare, JSON lỗi và 404.
- Regression giữ response thật rồi giải phóng sau khi đổi version hoặc tài khoản xác nhận không render dữ liệu cũ. Form mutation giữ response đang xem sau refresh.
- Screenshot đã xem: `.local-check/login.png`, `.local-check/ui.png`, `.local-check/mobile.png`, `.local-check/task-form-mobile.png`. Mobile dùng bảng chuyển thành hàng có nhãn để giữ nút thao tác trong khung nhìn.
- Các ảnh `.local-check/` là artifact local bị Git ignore. Không thêm dependency hoặc thay policy PDP hiện có.
- Chưa commit/push; chưa nghiệm thu trực tiếp bởi giảng viên, audit accessibility đầy đủ hoặc kiểm thử load/deployment.

### Bổ sung popup từ chối quyền

- Mọi response 403 trong ngữ cảnh hiện tại mở popup riêng có tiêu đề, lý do dễ hiểu và hướng xử lý; không dùng mã lỗi/HTTP làm nội dung chính.
- Bao phủ thiếu membership, role, tenant, assignee, task Closed và user đích khác tenant. Nút Đã hiểu đóng popup, giữ form và bản nháp bên dưới.
- Browser smoke PASS sau thay đổi: kiểm tra popup ngoài project/khác tenant, từ chối sửa của Viewer, bản nháp và modal sửa còn nguyên sau khi đóng popup; screenshot mobile `.local-check/permission-popup.png` đã xem.

### Bổ sung popup ghi thành công

- Lưu task, thêm/đổi/xóa thành viên, xóa project, reset và request ghi tùy chỉnh có popup thành công với nút Đã hiểu; thao tác xem không hiện popup thành công.
- Browser smoke kiểm tra popup sau các thao tác ghi thành công, không hiện khi đọc hoặc ghi bị từ chối; screenshot `.local-check/success-popup.png`.

### Hoàn thiện đổi role/xóa thành viên

- Đổi role trên từng hàng mở modal chọn vai trò, gọi PATCH khi bấm Lưu vai trò và hiện popup kết quả. Xóa thành viên giữ bước xác nhận và popup kết quả.
- Bổ sung popup cho mọi HTTP error của thao tác ghi, không chỉ 403. Owner cố định (409), membership trùng (409), thành viên không tồn tại (404) có thông báo và hướng xử lý riêng.
- Browser smoke PASS sau khi kiểm tra trực tiếp nút Đổi role, thành công đổi/xóa member, lỗi đổi/xóa Owner, membership không tồn tại và membership trùng.

### Tách quyết định quyền và kết quả request

- Đổi tên Decision thành Authorization decision. Thêm trace kiểm tra Owner cố định và Request outcome cuối response để không nhầm ALLOW của PDP với mutation thành công.
- Regression xác nhận PATCH/DELETE Owner ở Starter–V4 trả 409, Authorization ALLOW nhưng Business rule FAIL và Request outcome REJECTED; membership giữ nguyên. Kiểm tra thêm 200 thành công, 400 validation, 401 và 403 authorization.
- Local verification: `npm.cmd test` PASS 47/47; `npm.cmd run test:ui` PASS. Cần restart server đang chạy bằng npm start để nạp backend mới.

### Bỏ thông báo thất bại trùng lặp

- Khi popup đã trình bày lỗi quyền/nghiệp vụ, form và banner không lặp lại cùng thông báo. Trang project bị chặn chỉ giữ trạng thái và nút quay lại; danh sách members bị chặn giữ trạng thái và hướng dẫn dùng form demo.
- Validation 400 trong form task/thành viên hiển thị cạnh trường liên quan, có aria-invalid/aria-describedby, giữ bản nháp và xóa lỗi khi người dùng sửa hoặc gửi lại.
- Browser smoke PASS: lỗi Viewer, task Closed, Owner cố định không lặp trong form; lỗi truy cập không lặp trên trang/banner; tiêu đề toàn khoảng trắng báo tại ô tiêu đề và không mở popup. Backend không thay đổi trong lần sửa này.

### Hoàn thiện evidence bài nộp

- Đã thêm `scripts/idor-regression.js`, `scripts/lab-fixture.js`, `scripts/collect-evidence.js`, các lệnh `test:idor` và `evidence`.
- `npm.cmd run evidence` PASS: 11 ca HTTP, Starter regression RED (1 fail/2 pass), V1 GREEN (3 pass), cùng kết quả trên hai snapshot, toàn bộ HTTP tests 47/47 và browser smoke PASS.
- `evidence/` chứa JSON response thật đã bỏ bearer token, logs stdout/stderr, diff tái dựng, snapshots thực thi được và manifest SHA-256. Xác nhận integrity 14 file code và 21 artifact, patch qua git apply --check.
- report.md/report.html cập nhật kết quả 47/47 và liên kết evidence. Kiểm tra report HTML: 9 trang in, không chồng footer, không tràn mobile, liên kết local hợp lệ; không request ngoài hoặc lỗi JS.
- Evidence dùng SQLite tạm riêng; không commit/push và không nghiệm thu thay giảng viên/hosted CI.
