# Triển khai Task Authorization Minilab

Báo cáo triển khai · 29/10/2026

## 01. Kiến trúc: quyền nằm ở server

Ứng dụng mô phỏng quản lý công việc trong hai tổ chức (tenant) Alpha và Beta. Người dùng mở project, đọc/sửa task, quản lý thành viên và xóa project. Cùng một thao tác được chạy qua năm mức policy **Starter → V1 → V2 → V3 → V4** để thấy chính xác lớp kiểm tra nào thay đổi kết quả.

Đăng nhập thành công chỉ xác định người dùng là ai. Khi người đó mở hoặc sửa một task, server còn phải kiểm tra họ có quyền với task ấy hay không. Starter chỉ kiểm tra đăng nhập để minh họa lỗi thiếu phân quyền. Từ V1, ứng dụng lần lượt kiểm tra membership, role, người được giao task, trạng thái và tenant.

```mermaid
flowchart TB
  UI[Trình duyệt: project, task, form, trace] -->|HTTP cùng origin| ROUTE[Express: xác thực và routes / PEP]
  ROUTE -->|Người dùng từ token| AUTH[auth.js: tra users]
  ROUTE -->|Dữ liệu project, task, membership| DB[(SQLite: data/lab.sqlite)]
  ROUTE -->|version + caller + action + dữ liệu| PDP[policy.js: authorize / PDP]
  PDP -->|allow hoặc deny + checks| ROUTE
  ROUTE -->|Chỉ đọc hoặc ghi khi được phép| DB
  ROUTE -->|JSON: data, error, trace, requestId| UI
```

Khi nhận yêu cầu từ trình duyệt, Express xác định người gửi và đọc dữ liệu cần xét quyền. Hàm `authorize()` trả về quyết định cho phép hoặc từ chối; route dựa vào đó để trả nội dung hoặc ghi thay đổi. SQLite lưu cả dữ liệu nghiệp vụ và thông tin phân quyền. Các thành phần trong sơ đồ đều chạy trong cùng một process.

**PEP** (Policy Enforcement Point) là nơi thực thi quyết định, nằm trong wrapper `endpoint()` của route. **PDP** (Policy Decision Point) là nơi tính quyết định, nằm trong `policy.js`. PDP không tự ghi database; PEP phải chặn trước khi gọi phần xử lý nghiệp vụ.

UI và API được Express phục vụ tại `http://127.0.0.1:3000`. UI dùng HTML/CSS/JavaScript thuần; server chỉ bind loopback. Các nút vẫn xuất hiện để người học thử cả trường hợp bị từ chối. Việc ẩn hoặc hiện nút không quyết định quyền truy cập.

**Phạm vi hiện có:** đọc project và task, sửa task, quản lý membership, xóa project, reset dữ liệu và xem trace. Chưa có tạo project/task, xóa task, đăng nhập thật hay triển khai nhiều process.

## 02. Dữ liệu: phân biệt danh tính, role và quan hệ

SQLite có năm bảng. `users` xác định một người thuộc tenant nào và có phải tenant admin hay không. Role Viewer/Member/Owner nằm ở `project_memberships`, vì một người có thể có quyền khác nhau trong từng project. `tasks.assigneeId` ghi người được giao việc; quan hệ này không tự cấp quyền thành viên.

```mermaid
flowchart LR
  T[tenants] -->|1:N| U[users: tenantId, isAdmin]
  T -->|1:N| P[projects: tenantId]
  U -->|1:N| M[project_memberships: userId, projectId, role]
  P -->|1:N| M
  P -->|1:N| K[tasks: projectId, assigneeId, status]
  U -.->|assigneeId có thể rỗng| K
```

### Dữ liệu mẫu để đối chiếu

| Tài khoản | Tenant | Vai trò trong dữ liệu seed |
| --- | --- | --- |
| Alice | Alpha | Owner của project Alpha |
| Bob | Alpha | Member của Alpha; được giao A1 và A2 |
| Vera | Alpha | Viewer của Alpha |
| Charlie | Beta | Owner của project Beta |
| Admin Alpha / Admin Beta | Tương ứng | Tenant admin, ban đầu không có membership |

Alpha có A1 (Bob, Open), A2 (Bob, Closed), A3 (chưa giao, Open), A4 (Alice, Open). Beta có B1 (Charlie, Open) và B2 (chưa giao, Open). Các ID cố định giúp so sánh policy mà không cần tạo thêm dữ liệu.

### Danh tính được xác định như thế nào?

Client gửi `Authorization: Bearer demo-bob`. `authenticate()` chỉ nhận các định danh demo đã liệt kê, sau đó truy vấn bảng `users`. Principal dùng để xét quyền gồm thông tin người dùng từ database. Đây là mô phỏng xác thực bằng token công khai; màn hình chọn tài khoản không kiểm tra mật khẩu, không phát JWT và không có phiên đăng nhập bảo mật.

Role của caller được đọc lại từ membership của **đúng project chứa tài nguyên**. Query `role=Admin`, header `X-Role` hay `X-Tenant-Id` không được dùng làm đầu vào cấp quyền. Với task, project được lấy từ `task.projectId` trong database, không lấy từ một project do caller tự khai.

**Ví dụ:** Bob vẫn là assignee của A1 sau khi Alice xóa membership của Bob. Request tiếp theo của Bob bị từ chối vì bước membership thất bại trước bước assignee. Được giao việc và còn quyền tham gia project là hai điều kiện riêng.

## 03. Năm policy thay đổi điều gì?

Mỗi version dùng cùng routes và database. Bảng dưới áp dụng cho các API nội dung/nghiệp vụ; danh mục tên project có ngoại lệ riêng ở mục 07. Starter và V1 vẫn kiểm tra dữ liệu đầu vào, ràng buộc database và Owner cố định.

| Version | Cơ chế quyết định | Hành vi dễ quan sát |
| --- | --- | --- |
| Starter | Có token hợp lệ là qua bước xét quyền đối tượng | Alice đọc B1 của Beta được; đây là lỗi IDOR cố ý |
| V1 | Phải có membership trong project chứa tài nguyên | Alice bị chặn ở Beta; Vera vẫn sửa task trong Alpha được |
| V2 | Sau membership, xét role theo action | Viewer chỉ đọc; Member đọc/sửa; Owner quản lý và xóa |
| V3 | Member sửa task phải là assignee và task hiện tại còn Open | Bob sửa A1 được; A2, A3, A4 bị chặn |
| V4 | Xét tenant trước; admin cùng tenant được quyền tương đương Owner | Admin Alpha mở Alpha được dù chưa có membership; Beta bị chặn |

### Role không đủ để diễn tả mọi điều kiện

Membership tạo danh sách quyền truy cập theo project (ACL). V2 gom quyền theo role (RBAC). V3 bổ sung quan hệ người dùng–task (ReBAC) và thuộc tính trạng thái (ABAC). V4 thêm điều kiện tenant. Các khái niệm này cùng xuất hiện trong một chuỗi kiểm tra; hệ thống không chạy bốn engine phân quyền riêng.

Từ V2, action `read` cho mọi role có membership; `edit` cho Member/Owner; `delete` và `members` cho Owner. Vì vậy, **Viewer đọc được task nhưng không được xem danh sách thành viên**: API members dùng action `members`, không dùng `read`.

### Các ngoại lệ có chủ đích

**Owner ở V3/V4** được sửa cả task Closed và task giao cho người khác. Điều kiện assignee/Open chỉ áp dụng với Member. Member có thể đóng task Open của mình, nhưng request mở lại bị chặn vì trạng thái trước khi ghi đã là Closed.

**Admin ở V4** được xét sau khi kiểm tra tenant. Nếu khác tenant, server trả `TENANT_MISMATCH` ngay; cờ admin không vượt qua bước này. Nếu cùng tenant, PDP cho phép mà không cần membership. Phần xử lý nghiệp vụ vẫn kiểm tra payload, Owner cố định và tenant của người được thêm vào project.

V1–V3 không có tenant boundary riêng. V4 cũng không hoàn toàn là “thêm một điều kiện”: nó vừa siết ranh giới tenant, vừa mở ngoại lệ admin trong tenant. Không có đặc quyền admin ở V1–V3 khi người đó chưa có membership.

## 04. Vì sao nâng cấp từ ACL đến RBAC, ReBAC và ABAC?

Mỗi version bổ sung một yêu cầu mà bản trước chưa xử lý. V1 dùng danh sách thành viên để giới hạn truy cập vào project; V2 phân biệt quyền theo role; V3 kiểm tra thêm người được giao task và trạng thái task. Những kiểm tra đã có vẫn được giữ khi thêm điều kiện mới.

Trong báo cáo này, danh sách thành viên ở V1 được gọi là ACL cấp project. Membership cũng là quan hệ user–project nên có thể được nhìn theo ReBAC ở nghĩa rộng. Khác biệt của V3 nằm ở điều kiện cụ thể hơn: người sửa phải là assignee của task, ngoài việc còn là thành viên project.

### Starter → V1: chặn truy cập ngoài project bằng ACL

Ở Starter, Alice có token hợp lệ nên vẫn đọc được B1 của Beta dù không tham gia project này. V1 cần chặn trường hợp IDOR đó: người dùng chỉ được truy cập tài nguyên trong project mình tham gia.

Server tra project từ tài nguyên thật, rồi kiểm tra caller có trong `project_memberships` của project đó. Danh sách thành viên đóng vai trò ACL chung cho tài nguyên thuộc project, đáp ứng phạm vi V1. Chưa cần kiểm tra assignee hay status vì V1 đang giải quyết quyền tham gia project.

Alice/B1 chuyển 200 → 403, còn Alice/A1 và Charlie/B1 vẫn 200. Tuy nhiên, Vera là Viewer vẫn sửa task, xóa project và quản lý members trong Alpha được. V1 mới trả lời “có trong danh sách truy cập không”, chưa phân biệt hành động; đây là lý do cần V2.

### V1 → V2: giữ ACL, thêm quyền theo role và action

Viewer chỉ đọc, Member được đọc/sửa, Owner được quản lý members và xóa project. Membership đơn thuần của V1 không diễn tả được sự khác nhau này.

Sau khi kiểm tra membership, PDP đọc role của caller tại đúng project rồi xét ma trận role–action. ACL tiếp tục chặn người ngoài; RBAC bổ sung giới hạn hành động cho người bên trong. Không dùng role do caller tự khai và không bỏ bước ACL.

Vera sửa A1 chuyển 200 → 403; Bob vẫn sửa A1 được nhưng không được xóa project hay quản lý members. Bob cũng vẫn sửa được A2 Closed, A3 chưa giao và A4 giao cho Alice: RBAC cho phép theo nhóm Member, chưa xét từng task. Giới hạn này dẫn tới V3.

### V2 → V3: giữ ACL/RBAC, thêm assignee và trạng thái

Member chỉ được sửa task được giao cho mình và hiện còn Open. Role Member không đủ để suy ra hai điều kiện đó.

Sau membership và role, PDP kiểm tra quan hệ `task.assigneeId === principal.id` (ReBAC) rồi kiểm tra status hiện tại là Open (ABAC). Dữ liệu lấy từ server; không xét quyền bằng status mà client muốn ghi. Owner giữ quyền sửa rộng đã có từ V2; điều kiện mới chỉ dành cho Member.

Bob sửa A1 Open được; A2/A3/A4 chuyển từ 200 ở V2 sang 403 ở V3. Bob mất membership vẫn bị chặn dù còn là assignee. V3 giải quyết quyền theo task nhưng chưa có tenant boundary riêng hoặc quyền quản trị cấp tenant; đó là phạm vi mở rộng của V4.

## 05. V4 kế thừa thế nào để không làm version đi lùi?

### V3 → V4: bổ sung tenant boundary và quản trị trong tenant

V4 có hai yêu cầu: cách ly dữ liệu nghiệp vụ giữa các tổ chức và cho phép tenant admin quản trị project trong tổ chức mình mà không cần được thêm vào từng project.

V3 xét quyền theo membership, role và task, chưa kiểm tra trực tiếp tenant. Alice đã không đọc được B1 vì thiếu membership, nên ca này chưa cho thấy một lỗi truy cập khác tenant ở V3. V4 bổ sung kiểm tra tenant riêng để ranh giới giữa hai tổ chức không chỉ phụ thuộc vào danh sách thành viên của từng project.

V4 so sánh tenant của caller và project trước. Khác tenant thì dừng với `TENANT_MISMATCH`; cùng tenant mới xét cờ admin từ server. Admin hợp lệ có quyền tương đương Owner. Caller không phải admin tiếp tục qua membership → role → assignee/status như V3. Khi thêm thành viên, route còn kiểm tra user đích cùng tenant với project.

Admin Alpha chưa có membership bị từ chối khi mở Alpha ở V3 (403), nhưng được phép ở V4 (200); mở Beta vẫn bị từ chối (403). Kết quả thay đổi vì V4 thêm quyền quản trị trong tenant. Quyền này vẫn chịu kiểm tra tenant, dữ liệu đầu vào và quy tắc Owner cố định. Riêng danh mục tên project được giữ mở để phục vụ demo như giải thích ở mục 07.

### Các kiểm tra được giữ qua từng version

Các ca so sánh dùng cùng dữ liệu mẫu. Với thao tác ghi hoặc xóa, cần reset trước ca tiếp theo để kết quả phản ánh thay đổi policy thay vì dữ liệu đã bị sửa.

| Bảo vệ đã có | Version phải tiếp tục giữ | Bằng chứng trong bộ test hiện có |
| --- | --- | --- |
| V1: người ngoài project không đọc nội dung | V2–V4, với ngoại lệ tenant admin hợp lệ ở V4 | Alice/B1 bị chặn; Alice/A1 và Charlie/B1 vẫn được đọc |
| V2: giới hạn theo role/action | V3–V4 cho caller không phải tenant admin | Viewer không sửa; Member không xóa project/quản lý members |
| V3: Member cần membership, đúng assignee và Open | V4 cho Member không phải tenant admin | A2/A3/A4 bị chặn; bị thu hồi membership vẫn không sửa được |
| V4: tenant trước admin | Mọi action nội dung/nghiệp vụ của V4 | Admin Alpha bị chặn ở task/project/members Beta |

### Cách tổ chức các version trong bài lab

Các điều kiện phân quyền nằm trong `src/policy.js`; các ca so sánh nằm trong `test/authorization.test.js`. V1 và V2 vẫn giữ những giới hạn đã nêu để người học thấy vì sao cần bước nâng cấp tiếp theo. Đây là các tình huống được dựng cho bài lab, không phải nhật ký sự cố trong quá trình lập trình.

Schema và dữ liệu mẫu có sẵn role, assignee, status và tenant để các version cùng dùng một bộ dữ liệu. Tuy nhiên, **V1 chỉ xét membership; V2 mới xét role; V3 mới xét assignee/status; V4 mới xét tenant/admin.** Các trường có sẵn chưa tham gia cấp quyền cho đến version tương ứng. Bài lab so sánh policy trong cùng một ứng dụng, chưa mô phỏng lịch sử migration hay lưu các commit nâng cấp tuần tự. Lựa chọn này phục vụ việc so sánh; khả năng mở rộng chưa được đo.

## 06. Một lần sửa task đi qua những bước nào?

Xét Bob gửi `PATCH /api/v3/tasks/A1` với body `{"status":"Closed"}`. Token chứng minh danh tính demo; quyết định sửa vẫn dựa vào project, membership, assignee và trạng thái hiện tại lấy từ server.

```mermaid
flowchart TB
  A[Kiểm tra version, token và ID] --> B[BEGIN IMMEDIATE]
  B --> C[Đọc task, project, membership từ SQLite]
  C --> D[PDP: membership → role → assignee → status hiện tại]
  D -->|Deny / lỗi| E[ROLLBACK → trả lỗi, data null]
  D -->|Allow| F[Kiểm tra các field của body → UPDATE]
  F -->|Lỗi validation hoặc ghi| E
  F -->|Thành công| G[COMMIT → 200 và task đã cập nhật]
```

### Vì sao đọc, xét quyền và ghi trong cùng transaction?

Wrapper `endpoint()` đưa các thao tác khác GET vào `transaction(db, execute)`. `BEGIN IMMEDIATE` bắt đầu transaction ghi trước khi tải tài nguyên và membership. Các truy vấn tiếp theo, lời gọi PDP và câu UPDATE chạy đồng bộ trên cùng connection. Thành công thì `COMMIT`; ném lỗi ở bất kỳ bước nào trong callback thì `ROLLBACK`.

Nhờ vậy, quyết định dựa trên trạng thái vừa đọc trong transaction ghi; không có bước `await` ra ngoài giữa xét quyền và cập nhật. SQLite chỉ cho một writer tại một thời điểm. `busy_timeout = 3000` cho phép chờ khóa trong giới hạn cấu hình, không chứng minh khả năng chịu tải đồng thời.

### Không xét quyền bằng trạng thái người dùng muốn ghi

A1 đang Open, Bob là Member và assignee nên được đóng task. Ở request tiếp theo, dù Bob gửi `{"status":"Open"}`, PDP vẫn nhìn thấy A1 đang Closed trong database và từ chối. Nếu xét theo status trong body, caller có thể tự khai Open để vượt điều kiện.

`PATCH` chỉ nhận `title`, `description`, `status`; không nhận `assigneeId`, `projectId`, `tenantId` hoặc role. Sau khi được cấp quyền, route kiểm tra field hợp lệ rồi mới UPDATE. Caller thiếu quyền có thể nhận 403 trước khi lỗi field được đánh giá; lỗi JSON hỏng được middleware bắt sớm hơn.

**Đọc dữ liệu:** GET tải tài nguyên và membership rồi xét quyền trước khi trả nội dung, nhưng không được bọc trong transaction ghi này. Chưa kiểm thử tranh chấp nhiều process; không suy rộng cơ chế local thành bảo đảm cho hệ thống phân tán.

## 07. API và ranh giới dữ liệu trả về

Các đường dẫn dưới có prefix `/api/:version`, với version là `starter`, `v1`, `v2`, `v3`, `v4`. Mọi API trong nhóm này yêu cầu token hợp lệ. Hai endpoint hỗ trợ lab `/lab/config` và `/lab/reset` nằm ngoài nhóm đó.

| Method và đường dẫn | Ý nghĩa / action |
| --- | --- |
| GET `/projects` | Danh mục ID/tên project; ngoại lệ khám phá của lab |
| GET `/projects/:id` | Nội dung project / `read` |
| GET `/projects/:id/tasks` | Danh sách task của project / `read` |
| GET `/tasks/:id` | Một task / `read` |
| PATCH `/tasks/:id` | Sửa title, description, status / `edit` |
| DELETE `/projects/:id` | Xóa project và dữ liệu phụ thuộc / `delete` |
| GET, POST `/projects/:id/members` | Xem hoặc thêm membership / `members` |
| PATCH, DELETE `/projects/:id/members/:userId` | Đổi role hoặc xóa membership / `members` |

### Thấy tên project không có nghĩa là xem được task

Danh mục cố ý trả ID/tên mọi project đang tồn tại cho người đã xác thực, ở mọi version. Nó không trả tenant, task count, task hay members. Nhờ vậy Alice có thể chọn Beta để thử một lần truy cập bị từ chối. API mở project và liệt kê task vẫn đi qua PDP; từ V1, Alice không nhận được nội dung Beta nếu chưa có membership phù hợp.

Đây là quyết định phục vụ demo, có đánh đổi là tên project được khám phá ngoài phạm vi tenant. Nếu triển khai thật, cần quyết định lại danh mục có phải lọc theo quyền hay không; không mặc nhiên giữ ngoại lệ này.

### Kết quả có cùng khuôn dạng

Response API dùng `{ data, error, trace, requestId }`. Khi bị từ chối, `data` là `null`; trace ghi những bước đã thực sự chạy và lý do dừng. Trace không chứa bearer token hoặc nội dung task bị chặn. `requestId` là UUID cho request, chưa có kho audit log bền vững để tra cứu lại.

| HTTP status | Khi nào xuất hiện |
| --- | --- |
| 200 / 201 | Đọc hoặc mutation thành công / tạo membership thành công |
| 400 | ID, JSON hoặc payload không hợp lệ |
| 401 / 403 | Thiếu/sai token / đã xác thực nhưng bị policy hoặc quy tắc nghiệp vụ chặn |
| 404 / 409 | Không có tài nguyên, version, route / membership trùng hoặc đổi/xóa Owner |

Xóa hiện trả **200 kèm JSON**, không trả 204. Phân biệt 403 và 404 giúp giải thích policy, nhưng có thể tiết lộ một ID tồn tại. Response đặt `Cache-Control: no-store`; trace chi tiết chỉ thích hợp với mục đích lab hiện tại.

## 08. Quyết định kỹ thuật: tổ chức ứng dụng và policy

Ứng dụng dùng một server và một database để việc chạy thử, đổi policy và theo dõi request thuận tiện hơn. Phần dưới giải thích cách tổ chức này và những giới hạn đi kèm.

### 1. Một process Node.js, Express phục vụ cả UI và API

Express phục vụ cả UI và API để bài lab có thể chạy bằng một lệnh. UI gọi đường dẫn tương đối `/api/...`, nên frontend và backend cùng origin. Cách tổ chức này giảm phần cấu hình khi chạy thử và giúp việc theo dõi request dễ hơn.

`server.js` mở app tại loopback; `createApp()` gắn router API và middleware phục vụ thư mục `public`. Node dùng ESM, Express 5, SQLite tích hợp qua `node:sqlite`; không có bước build UI.

UI tự quản lý DOM, form và trạng thái; database đồng bộ có thể chặn event loop khi truy vấn lâu. React với API tách riêng hoặc PostgreSQL có thể phù hợp khi nhu cầu tăng, nhưng thêm cấu hình mà bài lab hiện chưa cần.

### 2. Cùng code và dữ liệu, đổi policy qua URL

Các version dùng cùng người dùng và tài nguyên để kết quả so sánh chỉ ra được ảnh hưởng của policy. Nếu mỗi version có dữ liệu mẫu hoặc route khác nhau, sẽ khó xác định vì sao cùng một thao tác lại cho kết quả khác.

Middleware đọc `:version`, chỉ chấp nhận năm giá trị khai báo; routes gọi cùng `authorize(version, principal, action, context)`. Dữ liệu sửa ở V1 cũng được thấy ở V4 vì không có database riêng theo version.

Các version dùng chung schema và file `data/lab.sqlite`. Bảng `tenants`, trường `tenantId` và cờ `isAdmin` đã có trong dữ liệu mẫu từ đầu, nhưng **chỉ V4 dùng chúng để kiểm tra tenant và cấp quyền tenant admin**. Vì vậy, cùng một request Alice đọc B1, V1 từ chối do thiếu membership còn V4 từ chối do khác tenant.

Khi đổi version, UI đổi prefix request, chẳng hạn `/api/v1/tasks/B1` thành `/api/v4/tasks/B1`, xóa nội dung và lịch sử cũ trên màn hình rồi tải lại. Server chọn policy theo URL; database và dữ liệu đang lưu vẫn giữ nguyên. Thao tác này không chạy migration hay reset, nên bài lab chưa mô phỏng bước bổ sung schema tenant khi nâng cấp lên V4.

Do dùng chung database, cần reset trước khi so sánh các ca sửa trạng thái hoặc xóa dữ liệu. Việc cho chọn Starter qua URL chỉ phục vụ bài lab; khi triển khai thực tế phải tắt policy cố ý thiếu bảo vệ này.

### 3. PDP tập trung, PEP bắt buộc trước nội dung/nghiệp vụ

Các điều kiện phân quyền được gom vào một hàm để tránh lặp ở từng route. Khi cần sửa quyền của một role, có thể đối chiếu bảng quyền với `authorize()` tại một chỗ.

`endpoint(action, kind, work)` tải tài nguyên theo ID, tìm project chứa nó và membership của caller, rồi gọi PDP. Chỉ khi `allowed` mới chạy `work`. Kết quả PDP kèm `checks`, nên trace phản ánh nhánh thực tế, kể cả các bước bị bỏ qua ở Starter.

Khi thêm route, vẫn phải gọi wrapper và truyền đúng action. Một route bỏ qua wrapper sẽ không được PDP kiểm tra. Danh mục tên project hiện được viết riêng theo ngoại lệ của lab. Với ứng dụng một process này, policy nằm ngay trong server; chưa cần một dịch vụ phân quyền riêng.

## 09. Deny by default và least privilege được áp dụng ra sao?

### Chỉ cấp quyền khi policy nhận diện và cho phép

Trước khi sửa, PDP cho phép edit khi role khác Viewer và xử lý action khác read/edit theo quyền Owner. Vì vậy, một lời gọi trực tiếp với role hoặc action lạ vẫn có thể được cho phép. Các route và ràng buộc database đã hạn chế đầu vào qua HTTP, nhưng bản thân PDP còn thiếu bước kiểm tra này.

Sau khi sửa, `authorize()` kiểm tra version, action và role membership có nằm trong danh sách hợp lệ hay không trước khi xét các nhánh Starter, V1 và tenant admin. Từ V2, quyền được liệt kê cụ thể: Viewer `[read]`, Member `[read, edit]`, Owner `[read, edit, delete, members]`. Action chưa khai báo bị từ chối ngay cả khi người gọi là Owner hoặc admin.

PDP còn chặn thiếu danh tính/project, hoặc edit thiếu task hay task không thuộc project đã truyền. PEP chỉ gọi nghiệp vụ khi `decision.allowed === true`. HTTP vẫn trả 401 cho token thiếu/sai, 404 cho version/route lạ và 403 cho deny từ PDP; response từ chối không chứa nội dung tài nguyên.

### Quyền tối thiểu tăng dần theo yêu cầu nghiệp vụ

V1 chỉ giới hạn theo project; V2 thu hẹp theo role/action; V3 thêm assignee và trạng thái Open cho Member edit; V4 thêm tenant boundary và quyền quản trị trong tenant. Quyền đọc không kéo theo quyền sửa hay quản lý members. Owner/admin có quyền rộng theo vai trò nghiệp vụ đã khai báo, vẫn chịu validation và quy tắc Owner cố định.

Starter vẫn bỏ qua quyền trên đối tượng, còn V1 chưa phân biệt hành động để phục vụ việc so sánh. Hai bản này chưa giới hạn quyền chặt như V3/V4. Danh mục tên project, `/lab/config` công khai và `/lab/reset` local cũng nằm ngoài PDP. Những ngoại lệ này phù hợp với phạm vi demo hiện tại và cần được xem xét lại trước khi triển khai thực tế.

### Kiểm chứng trực tiếp và qua HTTP

`test/policy.test.js` gọi PDP trực tiếp để kiểm tra version/action/role lạ, cả nhánh Starter/V1/admin, thiếu context và ma trận role–action. `test/authorization.test.js` tiếp tục kiểm tra request thật, dữ liệu không đổi sau deny và các bảo vệ kế thừa V1–V4. Chi tiết quy tắc và ngoại lệ nằm trong [POLICY.md](POLICY.md).

## 10. Quyết định kỹ thuật: lưu trữ và tính toàn vẹn

### 4. SQLite bền vững, SQL trực tiếp có tham số

Cần chứng minh thay đổi được lưu qua restart và các quan hệ được ràng buộc, nhưng không cần một database server riêng. Dữ liệu RAM/JSON đơn giản hơn nhưng không cung cấp cùng cơ chế transaction và foreign key.

`DatabaseSync` mở `data/lab.sqlite`, bật foreign keys và tạo schema nếu chưa có. Giá trị nhận từ request được truyền qua tham số `?` trong prepared statement. Index hỗ trợ tìm membership theo user và task theo project; khóa chính ghép `(projectId, userId)` ngăn trùng thành viên.

SQL do ứng dụng tự quản lý; chưa có hệ migration schema có version. Truy vấn đồng bộ và khả năng ghi của một file SQLite phù hợp với lab nhỏ; chưa đo hiệu năng hay tải ghi đồng thời.

### 5. Transaction bảo vệ thao tác ghi; database giữ ràng buộc

Policy phải dùng dữ liệu hiện tại, còn ghi dữ liệu phải toàn vẹn. Chỉ có foreign key không trả lời được “Bob có được sửa A2 không”; chỉ có policy cũng không ngăn được mọi lỗi quan hệ dữ liệu.

Transaction bao cả đọc–authorize–write như mục 06. Xóa project dùng `ON DELETE CASCADE` để xóa task và membership liên quan. `CHECK` giới hạn role/status; unique index `one_owner` cho phép tối đa một Owner trong project. Route không cho thêm role Owner hoặc đổi/xóa Owner đang có, nên Owner seed được giữ cố định.

Unique index chỉ đảm bảo **tối đa** một Owner, không tự bảo đảm project luôn có Owner. Quy tắc Owner cố định vẫn cần code ứng dụng. V4 kiểm tra tenant người được thêm ở route; foreign key đơn lẻ không tự áp đặt quan hệ cùng tenant.

### 6. Seed khi khởi tạo; reset là thao tác riêng

Restart phải giữ kết quả sửa để minh họa persistence, đồng thời cần cách đưa bài demo về trạng thái có thể lặp lại.

`openDatabase()` seed khi bảng tenants rỗng; với dữ liệu bình thường, mở lại file giữ nguyên thay đổi. Reset xóa và nạp lại seed trong một transaction. Năm version cùng nhìn thấy kết quả reset. Kiểm tra dùng file SQLite tạm riêng, không dùng `data/lab.sqlite` đang demo.

Reset ghi đè dữ liệu lab. Endpoint reset không yêu cầu đăng nhập; chỉ từ chối Origin được gửi khác origin hiện tại, vẫn nhận request không có Origin. Đây là tiện ích local, không phải cơ chế bảo vệ quản trị đầy đủ.

**Evidence để nộp:** [evidence/README.md](evidence/README.md) liệt kê response Alice/B1 trước/sau, 11 ca HTTP, logs regression đỏ/xanh, `tests-after.txt` và `ui-after.txt`. `manifest.json` ghi thời điểm, exit code và SHA-256 của code/artifact. Tái tạo bằng `npm.cmd run evidence` với SQLite tạm.

**Nguồn gốc code diff:** `evidence/authorization.diff` là diff **tái dựng**, không phải hai commit lịch sử. Before bỏ khối object authorization, after giữ code hiện tại. Cùng regression V1 chạy đỏ/xanh ở hai snapshot; patch đã qua `git apply --check`. Chi tiết tái dựng nằm trong README evidence.

## 11. Giao diện và cách trình bày một lần demo

### 7. Thao tác trên giao diện và xem chi tiết request

Người xem nên thao tác như một ứng dụng quản lý task, rồi mở chi tiết khi muốn hiểu tại sao được phép hoặc bị chặn. Chỉ đưa một form gọi API sẽ khó thấy ảnh hưởng lên dữ liệu.

UI có danh sách project, bảng task, form sửa, tab thành viên và xác nhận xóa/reset. Popup từ chối giải thích theo mã lỗi; popup thành công xuất hiện sau thao tác ghi thành công. Request/response, status, requestId và checks nằm trong **Chi tiết kỹ thuật**, với lịch sử tối đa 30 request. Các lần tải lại nền giữ kết quả thao tác trước đó đang được chọn.

Nút vẫn cho bấm dù caller không đủ quyền, vì mục đích là gửi request bị từ chối thật. Ứng dụng sử dụng thực tế có thể hướng dẫn/giới hạn thao tác sớm hơn, nhưng server vẫn cần giữ cùng kiểm tra.

### 8. Bỏ response cũ khi ngữ cảnh đã đổi

Response cho Starter có thể về sau khi người dùng đã chuyển V1. Nếu tiếp tục hiển thị nó, UI có thể đưa nội dung từ ngữ cảnh cũ trở lại màn hình.

Mỗi lần đổi ngữ cảnh, bộ đếm `generation` tăng và UI dọn nội dung/form cũ. `api()` giữ giá trị đếm lúc gửi; sau khi nhận response, nếu giá trị đã đổi thì ném `Stale` trước khi lưu lịch sử hoặc cập nhật màn hình. Đổi tài khoản/version còn xóa lịch sử kỹ thuật và dữ liệu bảo vệ. Khi một lần lưu bị từ chối trong cùng ngữ cảnh, form giữ bản nháp để người dùng sửa tiếp.

Cơ chế này loại kết quả hiển thị đã cũ, không hủy hay đảo ngược request đã tới server. Quyền ghi vẫn do server quyết định tại thời điểm xử lý.

### Các tình huống demo sự khác nhau giữa các version

| Thử trên dữ liệu mẫu | Kết quả cần giải thích |
| --- | --- |
| Alice đọc B1: Starter → V1 | 200 → 403: membership chặn IDOR |
| Vera sửa A1: V1 → V2 | 200 → 403: Viewer mất quyền edit |
| Bob sửa A2 Closed: V2 → V3 | 200 → 403: status hiện tại quyết định |
| Admin Alpha mở Alpha/Beta ở V4 | Alpha 200; Beta 403: tenant trước admin |

Khôi phục seed trước khi so sánh các thao tác ghi, nhất là đóng task hoặc xóa project. **So sánh tự động chỉ gửi GET** để tránh thực hiện mutation hai lần. Sau mỗi phép thử, mở trace và chỉ ra đúng bước FAIL; tài nguyên bị xóa trả 404 không chứng minh được policy 403.

## 12. Kết quả kiểm thử và những phần còn thiếu

### Kiểm tra cả response lẫn dữ liệu sau request

Một API trả 403 vẫn có thể đã ghi sai nếu thứ tự xử lý có lỗi. Kiểm tra status đơn lẻ không đủ để chứng minh thao tác bị từ chối an toàn.

Các test HTTP dùng `node:test` để khởi tạo Express trên cổng tạm, rồi gửi request bằng `fetch`. Mỗi fixture có SQLite tạm riêng. Test kiểm tra cả status, body, trace và dữ liệu sau request. Với ca IDOR, Starter phải đọc được B1 còn V1–V4 phải từ chối; đây đều là kết quả mong đợi trong bộ test mặc định.

### Kết quả chạy tại workspace ngày 29/10/2026

| Kiểm tra | Kết quả đã quan sát |
| --- | --- |
| `npm.cmd test` | **52/52 đạt** (47 HTTP/lưu trữ + 5 PDP), 0 fail, 0 skipped |
| `npm.cmd run test:ui` | **PASS**, không có lỗi JavaScript trình duyệt được script ghi nhận |
| Regression IDOR riêng | Starter: **1 fail / 2 pass**; V1: **3 pass** |
| `npm.cmd run evidence` | **PASS** · 11 ca HTTP, logs và diff |
| Môi trường | Node.js 22.17.1, Express cài tại workspace 5.3.0; Windows, Chrome headless |

Hướng dẫn và artifact bài nộp: [evidence/README.md](evidence/README.md). Nguồn gốc diff tái dựng được giải thích tại mục 10.

Bộ HTTP kiểm tra token, ma trận role/action, membership, assignee/status, admin cùng/khác tenant, giả mạo quyền, validation, Owner cố định, dữ liệu sau deny, cascade, persistence, reset và quyền đọc project/list task. Bộ UI đi qua đăng nhập demo, form task, quản lý thành viên, popup, xóa/reset, so sánh GET, response đến muộn và màn hình mobile 390 px.

Khi chạy UI test trong sandbox, công cụ kết nối trình duyệt báo `CDP timeout: Runtime.enable`. Chạy ngoài sandbox thì test hoàn tất. Các kết quả trong bảng được ghi nhận trên máy local; chưa có kết quả CI hay kiểm thử ở môi trường triển khai. Node 22 cũng phát cảnh báo SQLite experimental, nhưng bộ test vẫn chạy thành công.

### Những phần chưa triển khai hoặc chưa kiểm thử

- **Xác thực thật:** token demo công khai, chưa có mật khẩu, cấp/thu hồi token hay session bảo mật.
- **Vận hành:** chưa có deployment, kiểm thử tải ghi đồng thời/nhiều process, migration có version hoặc audit log lưu bền vững.
- **Phạm vi nghiệp vụ:** chưa tạo project/task, xóa task, chuyển Owner hoặc bulk API.
- **Nghiệm thu:** đã có bộ kết quả kiểm thử local; chưa có xác nhận của giảng viên hoặc kết quả CI. Các tiêu chí nghiệm thu trong `plan.md` chưa được xác nhận đầy đủ.

Trước khi triển khai thực tế, cần tắt Starter, bổ sung xác thực thật và xem lại quyền truy cập danh mục project, trace và reset. Việc chọn cách mở rộng lưu trữ cần thêm số đo về truy vấn, khóa ghi và tải thực tế. Các hạng mục này chưa được triển khai trong bài lab.
