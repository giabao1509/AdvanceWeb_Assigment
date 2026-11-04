# Task Authorization Minilab

Ứng dụng quản lý dự án và công việc để học cách kiểm tra quyền truy cập. Bạn có thể đổi giữa **Starter, V1, V2, V3, V4**, dùng cùng một tài khoản và dữ liệu để thấy vì sao một thao tác được phép hoặc bị từ chối.

Ứng dụng web dùng Node.js và SQLite. **OpenFGA** là service kiểm tra quyền cho V1–V4, chạy bằng Docker và có SQLite riêng. Starter cố ý thiếu kiểm tra quyền trên từng tài nguyên để minh họa lỗi truy cập bằng ID của người khác.

## 1. Chạy bằng start.bat trên Windows

Cài **Node.js từ 22.17 trở lên** (kèm npm) và **Docker Desktop có Docker Compose**. Mở Docker Desktop, đợi Linux engine sẵn sàng. Lần đầu cần mạng để tải thư viện và image Docker.

Sau khi clone, nhấp đúp `start.bat`, hoặc chạy trong PowerShell tại thư mục dự án:

```powershell
.\start.bat
```

Script sẽ thực hiện lần lượt:

1. Kiểm tra Node.js, npm và Docker.
2. Sao chép `.env.example` thành `.env` nếu chưa có. File `.env` đã có sẽ được giữ nguyên.
3. Chạy `npm.cmd ci` để cài đúng dependency trong `package-lock.json`.
4. Chạy Docker Compose và chờ OpenFGA qua healthcheck.
5. Chạy `fga:init` để tạo cấu hình quyền lần đầu, hoặc đồng bộ với dữ liệu hiện có.
6. Chạy web app và in địa chỉ truy cập, mặc định **http://127.0.0.1:3000**.

**Những lần sau vẫn chỉ chạy `start.bat`.** Script cài lại dependency mỗi lần nên có thể mất thời gian và cần truy cập npm nếu cache chưa đủ. Script không khôi phục dữ liệu mẫu, không ghi đè `.env`, không tạo store/model mới nếu database đã lưu ID hợp lệ. Hãy dừng web app cũ trước khi chạy lại.

Giữ cửa sổ mở trong lúc dùng ứng dụng. Nhấn **Ctrl+C** để dừng web app; nếu Windows hỏi kết thúc batch job, chọn `Y`. OpenFGA vẫn chạy nền. Muốn dừng cả OpenFGA, chạy `docker compose down`.

Nếu có lỗi, script dừng tại bước đó và giữ cửa sổ để bạn đọc thông báo. Sửa nguyên nhân rồi chạy lại `start.bat`. Script không tự cài Node/Docker hoặc tự mở Docker Desktop.

## 2. Cấu hình .env

Khi chạy thủ công, tạo `.env` **trước khi khởi động service**:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Cấu hình mặc định đủ để chạy local, không cần điền token hoặc store/model ID:

```dotenv
FGA_API_URL=http://127.0.0.1:8080
FGA_TIMEOUT_MS=3000
PORT=3000
```

| Biến | Ý nghĩa |
| --- | --- |
| `FGA_API_URL` | Địa chỉ OpenFGA mà ứng dụng gọi. Compose hiện mở cố định cổng `8080` trên máy local. |
| `FGA_TIMEOUT_MS` | Thời gian chờ mỗi lời gọi OpenFGA, tính bằng mili giây; nhận từ `100` đến `10000`. |
| `PORT` | Cổng web app. Ví dụ `3001` thì mở `http://127.0.0.1:3001`. |

Các lệnh `start`, `fga:init`, `fga:sync`, `db:reset` tự đọc `.env`. Biến đã đặt trong môi trường của terminal được ưu tiên hơn giá trị trong file. Không commit `.env`.

Đổi `FGA_API_URL` không làm Compose tự đổi cổng. Nếu muốn chuyển cổng OpenFGA, phải sửa cả `ports` trong `compose.yaml` và URL tương ứng. Database đã khởi tạo còn lưu URL/store/model đang dùng; trỏ sang engine khác cần xử lý cấu hình và dữ liệu có chủ đích, không chỉ đổi URL rồi chạy lại.

## 3. Khởi động thủ công từng service

Các lệnh dưới đây chạy từ thư mục dự án. Trên macOS/Linux dùng `npm` thay cho `npm.cmd` và `cp .env.example .env` nếu chưa có `.env`.

### Bước 1: Tạo .env và cài thư viện

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci
```

### Bước 2: Chạy OpenFGA bằng Docker

```powershell
docker compose up -d --wait
```

Compose chạy service `migrate` để chuẩn bị schema SQLite của OpenFGA. Sau khi bước này thành công, service `openfga` mới chạy. Đây là quá trình chuẩn bị database của engine, không phải khôi phục dữ liệu mẫu của ứng dụng. OpenFGA dùng image `openfga/openfga:v1.22.1`, HTTP tại `http://127.0.0.1:8080`.

Kiểm tra trạng thái hoặc đọc log khi có lỗi:

```powershell
docker compose ps -a
docker compose logs --tail=100 migrate openfga
```

### Bước 3: Khởi tạo hoặc đồng bộ quyền

```powershell
npm.cmd run fga:init
```

Lần đầu, lệnh tạo SQLite ứng dụng, nạp dữ liệu mẫu, tạo store/model trong OpenFGA rồi đồng bộ quan hệ quyền. Những lần sau, lệnh dùng lại store/model đã lưu trong database và đối chiếu quan hệ với dữ liệu hiện có. `fga:sync` dùng cùng quy trình với `fga:init`.

### Bước 4: Chạy web app

```powershell
npm.cmd start
```

Mở địa chỉ server in ra, mặc định **http://127.0.0.1:3000**. Server chỉ nhận kết nối từ máy local. `node:sqlite` trên Node 22 có thể in `ExperimentalWarning`; riêng thông báo này không có nghĩa khởi động thất bại.

### Dừng, chạy lại và khôi phục dữ liệu mẫu

Nhấn **Ctrl+C** tại terminal chạy web app. Sau đó, nếu cần dừng OpenFGA:

```powershell
docker compose down
```

`down` giữ Docker volume. Lần sau chạy lại bước 2–4, hoặc dùng `start.bat`. File `data/lab.sqlite` giữ các chỉnh sửa của bạn; OpenFGA lưu store/model và quan hệ trong volume `block6-advance_openfga-sqlite`.

Chỉ dùng lệnh sau khi muốn **xóa dữ liệu nghiệp vụ hiện tại và nạp lại dữ liệu mẫu**; OpenFGA cần đang chạy:

```powershell
npm.cmd run db:reset
```

Giao diện cũng có nút **Khôi phục dữ liệu mẫu**. Mọi phiên bản dùng chung dữ liệu, vì vậy cần reset giữa các ca demo xóa dự án. Không dùng `docker compose down -v` nếu muốn giữ dữ liệu OpenFGA. Không xóa file SQLite hoặc các file `-wal`/`-shm` trong lúc service đang chạy.

## 4. Sử dụng và thử khác biệt giữa các phiên bản

Chọn tài khoản demo rồi bấm **Vào ứng dụng**. Thanh trên cùng cho đổi tài khoản và phiên bản. Danh mục hiển thị ID/tên mọi dự án để thử truy cập; quyền xem nội dung vẫn do server kiểm tra.

Mở dự án để xem công việc. Các nút xem, sửa, quản lý thành viên và xóa dự án vẫn hiện để bạn thử cả trường hợp bị từ chối. Mở **Chi tiết kỹ thuật** để xem request, response, kết quả kiểm tra quyền và HTTP status. Phần **Công cụ demo nâng cao** cho gửi request tùy chỉnh; chỉ request GET được so sánh tự động.

| Tình huống với dữ liệu mẫu | Kết quả cần quan sát |
| --- | --- |
| Alice mở Beta | Starter cho xem; V1–V4 từ chối vì không có quyền tại Beta. |
| Vera sửa A1 trong Alpha | V1 cho sửa; V2–V4 từ chối vì Vera là Viewer. |
| Bob sửa A2 đang Closed | V2 cho sửa; V3–V4 từ chối. Bob chỉ sửa được A1 đang Open và được giao cho mình. |
| Admin Alpha mở Alpha khi chưa có membership | V1–V3 từ chối; V4 cho phép. V4 vẫn chặn Admin Alpha ở Beta vì khác tổ chức. |
| Bob quản lý thành viên hoặc xóa Alpha | V1 cho phép; V2–V4 từ chối vì Bob không phải Owner. Reset sau ca xóa. |

Owner không thể bị xóa hoặc đổi vai trò qua API thành viên. Xem/thêm/đổi/xóa thành viên đều là quyền quản lý thành viên; quyền đọc công việc không bao gồm quyền xem danh sách này. Chi tiết trình bày nằm trong [DEMO.md](DEMO.md).

Tab **Thành viên** hiển thị danh sách và nút đổi vai trò/xóa ở từng hàng. Để thêm thành viên, gửi POST tới `projects/:id/members` trong **Công cụ demo nâng cao** với body như `{"userId":"admin-alpha","role":"Viewer"}`.

## 5. Khi gặp lỗi

| Hiện tượng | Cách xử lý |
| --- | --- |
| Không tìm thấy Node/npm | Cài Node.js từ 22.17, mở terminal mới rồi chạy lại. Trên PowerShell dùng `npm.cmd` để tránh lỗi execution policy của `npm.ps1`. |
| Không kết nối Docker | Mở Docker Desktop và Linux engine. Kiểm tra `docker info`, sau đó chạy lại. |
| Cổng 3000 hoặc 8080 đang được dùng | Dừng tiến trình cũ. Muốn đổi cổng web, sửa `PORT`; muốn đổi cổng OpenFGA, xem mục cấu hình `.env`. |
| npm báo lỗi chứng chỉ CA | `start.bat` đã bật dùng kho CA hệ thống. Khi chạy thủ công, có thể thử `$env:NODE_OPTIONS='--use-system-ca'` trước `npm.cmd ci`. Nếu vẫn lỗi, kiểm tra chứng chỉ/proxy của máy; không tắt kiểm tra TLS. |
| V1–V4 trả 503 | Xem log OpenFGA. Khi engine hoạt động lại, chọn **Đồng bộ lại** ngay tại màn hình không mở được nội dung; nút này vẫn có sau khi về danh sách hoặc tải lại trang. Chỉ đồng bộ quyền, không gửi lại thao tác đã lưu. Cũng có thể dừng web app, chạy `fga:sync` rồi khởi động lại. |
| Thông báo đã lưu nhưng đang cập nhật quyền, HTTP 202 | Dữ liệu đã được lưu. Kiểm tra trạng thái hoặc đồng bộ lại; không gửi lại thao tác thêm/xóa. Trong lúc chờ, các API được bảo vệ ở V1–V4 bị chặn để tránh dùng quyền cũ. |
| `AUTHORIZATION_SYNC_BUSY` sau khi tiến trình bị tắt đột ngột | Quyền giữ lượt đồng bộ có thời hạn 30 giây. Đợi hết hạn rồi đồng bộ lại. |
| `AUTHORIZATION_MODEL_MISMATCH` | Model đã khác bản gắn với database. `fga:build` chỉ sinh JSON, không tự chuyển database sang model mới. Cần xử lý migration/binding; không xóa dữ liệu để bỏ qua lỗi. |
| HTTP 409 `AUTHORIZATION_CONTEXT_CHANGED` | Dữ liệu đổi trong lúc kiểm tra quyền. Tải lại dữ liệu trước khi thực hiện lại thao tác. |

Nếu chạy app thủ công khi OpenFGA lỗi, Starter và danh mục tên dự án vẫn có thể hoạt động; điều đó chưa chứng minh V1–V4 sẵn sàng. `start.bat` dừng khi bước khởi tạo quyền thất bại.

## 6. Kiểm thử và tạo bằng chứng

Khởi động OpenFGA trước. Các lệnh kiểm thử dưới đây dùng SQLite và store riêng, không reset dữ liệu demo:

```powershell
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:idor -- --version=v1
npm.cmd run test:fga:model
npm.cmd run test:fga:integration
npm.cmd run evidence
```

`test:ui` cần Chrome hoặc Edge trên Windows. Nếu trình duyệt nằm ở vị trí khác, đặt `$env:LAB_BROWSER` trỏ tới file thực thi. Ảnh kiểm tra lưu trong `.local-check/` và được Git bỏ qua. Khi chạy test với engine ở URL khác, đặt `$env:FGA_API_URL` trong terminal vì các script test không tự đọc `.env`.

Regression IDOR ở Starter được kỳ vọng báo lỗi vì phiên bản này cố ý có lỗ hổng; ở V1 phải vượt qua. Bằng chứng OpenFGA nằm tại `evidence/openfga/`. Các artifact trực tiếp trong `evidence/` thuộc bản trước tích hợp; xem [evidence/README.md](evidence/README.md) để phân biệt.

Để sinh lại bản HTML của report từ Markdown, dùng Python 3.12 trở lên:

```powershell
python scripts/render-report.py
```

## 7. API và mã nguồn

Token demo: `demo-alice`, `demo-bob`, `demo-vera`, `demo-charlie`, `demo-admin-alpha`, `demo-admin-beta`. Đây là cách mô phỏng đăng nhập, chưa có mật khẩu, JWT hoặc OAuth2 thật.

| Method | Đường dẫn sau `/api/:version` | Mục đích |
| --- | --- | --- |
| GET | `/projects` | Danh mục ID/tên dự án cho tài khoản đã xác thực |
| GET | `/projects/:id` | Đọc thông tin dự án theo quyền |
| GET | `/projects/:id/tasks` | Đọc công việc trong dự án theo quyền |
| GET/PATCH | `/tasks/:id` | Đọc/sửa công việc |
| DELETE | `/projects/:id` | Xóa dự án và các task/membership liên quan |
| GET/POST | `/projects/:id/members` | Xem/thêm thành viên |
| PATCH/DELETE | `/projects/:id/members/:userId` | Đổi vai trò/xóa thành viên |

```powershell
curl.exe -i http://127.0.0.1:3000/api/starter/projects/beta/tasks -H "Authorization: Bearer demo-alice"
curl.exe -i http://127.0.0.1:3000/api/v1/projects/beta/tasks -H "Authorization: Bearer demo-alice"
```

PATCH task nhận `title`, `description`, `status` (`Open`/`Closed`). POST member nhận `userId`, `role`; PATCH member nhận `role` (`Viewer`/`Member`). Response có `{ data, error, trace, requestId }`. Các mã HTTP và tình huống lỗi được giải thích thêm trong report.

| Vị trí | Nội dung |
| --- | --- |
| `src/app.js`, `src/auth.js`, `src/policy.js` | Route, xác thực và gọi kiểm tra quyền trước khi đọc/ghi |
| `src/db.js`, `src/schema.sql` | SQLite ứng dụng, dữ liệu mẫu, revision và thông tin đồng bộ |
| `src/openfga/` | Gọi SDK OpenFGA, chuyển quan hệ SQL thành tuple và đồng bộ |
| `openfga/model.fga`, `openfga/model.json` | Mô hình quyền gốc và JSON sinh bởi `npm.cmd run fga:build` |
| `public/` | Giao diện web |
| `test/`, `scripts/` | Kiểm thử, thu thập bằng chứng và công cụ hỗ trợ |

Đọc [report.md](report.md) hoặc [report.html](report.html) để hiểu cơ chế; [POLICY.md](POLICY.md) để tra quy tắc chi tiết; [OPENFGA-PROGRESS.md](OPENFGA-PROGRESS.md) để xem kết quả kiểm chứng đã ghi nhận.

Đây là lab chạy local. Starter cố ý có lỗ hổng, người dùng được chọn phiên bản, tên dự án được công khai trong danh mục và có công cụ reset. Chưa có triển khai hosted, kiểm thử tải lớn hoặc hỗ trợ nhiều app instance.
