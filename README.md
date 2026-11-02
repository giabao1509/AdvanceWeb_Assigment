# Task Authorization Minilab

Ứng dụng quản lý công việc local với giao diện tiếng Việt, dữ liệu SQLite và năm phiên bản policy **Starter → V1 → V2 → V3 → V4**. V1–V4 dùng **OpenFGA** với quan hệ lưu thật; Starter cố ý bỏ qua object authorization. Request/response và authorization trace nằm trong phần **Chi tiết kỹ thuật**.

## Chạy

Yêu cầu Node.js **22.17 trở lên**, Docker Engine và Docker Compose đang chạy. Dùng SQLite tích hợp `node:sqlite`; Node 22 có thể in ExperimentalWarning. Compose dựng OpenFGA **v1.22.1** với datastore **SQLite** bền trên Docker volume; không cần PostgreSQL.

```powershell
npm.cmd ci
docker compose up -d --wait
npm.cmd run fga:init
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

## OpenFGA và đồng bộ quyền

OpenFGA HTTP ở `http://127.0.0.1:8080`. Có hai database riêng: `data/lab.sqlite` lưu nghiệp vụ; `/home/nonroot/openfga.sqlite` trong volume `block6-advance_openfga-sqlite` lưu store/model/tuples của OpenFGA. Có thể sao chép `.env.example` thành `.env` để đổi cấu hình. Node nạp `.env` cho start/init/sync/reset; khi chạy test với URL khác, đặt `$env:FGA_API_URL` tương ứng. Store/model ID được pin trong từng SQLite database. Restart không reset dữ liệu; `docker compose down` giữ volume. Không dùng `down -v` nếu muốn giữ graph.

Đây là **stored tuples trên SQLite**, không dùng contextual tuples. OpenFGA có schema/migration riêng, không đọc trực tiếp bảng `project_memberships`; projection/outbox vẫn cần vì có hai database. Compose dùng một connection tới SQLite và busy timeout 3 giây, phù hợp lab một instance; chưa kiểm chứng tải lớn hoặc nhiều engine cùng file.

Lượt chuyển từ PostgreSQL đã giữ store/model ID, tuple/condition và dữ liệu nghiệp vụ. Container PostgreSQL cũ đã ngừng/gỡ; volume nguồn và bản export local vẫn được giữ để khôi phục. Đây là chuyển dữ liệu một lần theo schema v1.22.1, không phải lệnh migration đa phiên bản. Khi xem/backup file SQLite của OpenFGA, dừng engine sạch hoặc dùng cơ chế backup hiểu WAL; không xóa các file phụ `-wal`/`-shm`.

```powershell
npm.cmd run fga:build
npm.cmd run fga:sync
npm.cmd run test:fga:model
npm.cmd run test:fga:integration
```

`fga:init` và `fga:sync` dùng chung quy trình: tạo store/model nếu chưa có binding rồi đối chiếu tuple với SQLite. Chạy lặp không tự tạo store mới. Model DSL thay đổi phải chạy build và thực hiện migration/binding có chủ đích; runtime từ chối hash khác. Chưa có lệnh tự động thay model của database demo đã pin.

Tests/browser smoke yêu cầu OpenFGA thật, tạo SQLite/store riêng và chỉ dọn tài nguyên fixture. Thiếu engine là lỗi kiểm thử. Sync dùng lease SQLite 30 giây; sau khi process bị kill giữa sync, chờ lease hết hạn rồi sync/restart. Chưa hỗ trợ nhiều app instances.

Nếu engine chưa sẵn sàng, Starter và danh mục tên project vẫn dùng được; V1–V4 trả 503. Khi engine phục hồi, chọn **Đồng bộ lại** ở UI pending hoặc restart app. CLI `fga:sync` sửa graph; nếu app chưa từng khởi tạo được binding, restart app sau khi CLI thành công.

Mutation quan hệ đã lưu nhưng sync lỗi trả **202** với `{ operationId, committed: true, authorizationSync: 'pending' }`. UI báo **Đã lưu thay đổi, đang cập nhật quyền truy cập**, cho kiểm tra trạng thái/đồng bộ lại. Không gửi lại mutation. Khi pending, V1–V4 bị chặn để tránh dùng quyền cũ; 200/201 chỉ trả sau sync hoàn tất.

HTTP bổ sung: **409 `AUTHORIZATION_CONTEXT_CHANGED`** nếu dữ liệu đổi trong lúc Check; **503** nếu engine lỗi/graph chưa ready. `GET /lab/operations/:id` xác thực và chỉ cho caller của operation xem trạng thái. `POST /lab/sync` yêu cầu token demo và kiểm tra Origin như reset; hai route nằm ngoài `/api/:version`.

SDK pin **0.9.7**; override Axios **1.21.0** để tránh advisory trong dependency 1.19.0 mà SDK pin sẵn. Nếu npm lỗi CA trên Windows, thử `$env:NODE_OPTIONS='--use-system-ca'` trước `npm.cmd ci`; không tắt kiểm tra TLS.

Báo cáo HTML đọc offline được tạo từ Markdown bằng `python scripts/render-report.py` (Python 3.12+); bộ render nhúng sẵn 4 sơ đồ SVG, gồm cơ chế OpenFGA Check. Kết quả local mới và giới hạn nghiệm thu được tóm tắt trong [OPENFGA-PROGRESS.md](OPENFGA-PROGRESS.md).

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
- `src/policy.js`: input validation, Starter và PDP adapter async; `src/app.js`: routes, validation và PEP với snapshot/revision trước read/write.
- `src/openfga/`: SDK client, tuple projection, outbox/sync/lease/readiness. Model ở `openfga/model.fga`; JSON sinh bằng `fga:build`.
- `src/db.js`, `src/schema.sql`: schema/seed/reset, foreign keys, revision triggers, outbox và operations. Không giữ transaction SQLite trong lúc chờ OpenFGA; revalidate trong transaction ngắn trước read/write.
- `public/`: UI HTML/CSS/JavaScript, điều hướng và form, kiểm soát response cũ khi đổi ngữ cảnh.
- `test/authorization.test.js`: HTTP permission matrix, API danh mục/chi tiết/list, validation/spoofing và persistence/reset/cascade.
- `scripts/ui-smoke.js`: luồng browser thật qua nút và form, xử lý từ chối, response cũ và mobile.

Đây là lab local: Starter cố ý có lỗ hổng, reset public có kiểm tra Origin, danh mục project cố ý discoverable. Evidence mới ghi vào `evidence/openfga/`; artifact trực tiếp trong `evidence/` thuộc bản PDP nội bộ trước tích hợp. Xem [evidence/README.md](evidence/README.md), [POLICY.md](POLICY.md), [UI-PLAN.md](UI-PLAN.md) và [OPENFGA-PLAN.md](OPENFGA-PLAN.md). Chưa có authentication thật, concurrent load, nhiều app instances hoặc hosted deployment.
