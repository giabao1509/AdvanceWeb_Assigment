# Kế hoạch triển khai minilab Task Management API

> Bản chạy tối giản đã triển khai Starter–V4, UI và SQLite. Ưu tiên theo yêu cầu mới: chạy đúng hành vi, chưa tạo đầy đủ bộ evidence. Seed/reset nằm trong `db.js`; routes/trace nằm trong `app.js` để giảm số module. Lệnh evidence/regression riêng bên dưới vẫn là dự kiến, chưa có script tương ứng.

## 1. Mục tiêu và phạm vi

Xây dựng minilab minh họa sự khác nhau giữa authentication và application authorization. Người học có thể dùng cùng một danh tính, cùng tài nguyên để so sánh Starter → V1 → V2 → V3 → V4 qua API và UI.

**Mỗi version kế thừa toàn bộ cơ chế bảo vệ của version trước rồi bổ sung policy mới.** Không xây năm ứng dụng riêng, không viết lại JWT/OAuth2; dùng một file SQLite và UI thuần để giữ lab đơn giản.

- Ưu tiên hoàn thành Starter và V1–V3; V4 là mở rộng sau khi các test chính đã đạt.
- UI phục vụ demo, thử request và đọc log; server quyết định quyền truy cập.
- Chỉ sử dụng dữ liệu giả và token demo. Starter cố ý có IDOR để thực hành, chỉ chạy local.
- Hiện trạng workspace: chỉ có file `README`, chưa có starter code hoặc cơ chế đăng nhập. Nếu không có starter được cung cấp thêm, dùng adapter xác thực với token demo cố định để mô phỏng danh tính đã đăng nhập; không xây hệ thống đăng nhập mới.

## 2. Stack và cấu trúc tối giản

- Node.js + Express, JavaScript; một process phục vụ API và static UI cùng origin.
- Dữ liệu lưu trong file SQLite `data/lab.sqlite`, truy vấn SQL trực tiếp qua driver SQLite, không dùng ORM. Restart giữ nguyên dữ liệu; nút Reset hoặc lệnh reset mới khôi phục seed ban đầu.
- `node:test` + `fetch` tích hợp để test HTTP trực tiếp, không cần trình duyệt cho permission tests. SQLite dùng `node:sqlite` tích hợp; Node tối thiểu 22.13.
- HTML/CSS/JavaScript thuần; không cần React, Docker, ORM, policy engine hoặc dịch vụ bên ngoài.

```text
src/
  app.js                 # Tạo app, gắn middleware và routes
  server.js              # Khởi động local server
  auth.js                # Adapter xác thực, cung cấp principal đáng tin cậy
  db.js                  # Mở SQLite, tạo schema, truy vấn và transaction
  schema.sql             # Tables, foreign keys và constraints
  policy.js              # PDP: quyết định theo version + action + resource
  reset.js               # CLI reset; seed nằm trong db.js, PEP/routes/trace trong app.js
data/
  lab.sqlite             # Database local được tạo khi chạy, không commit
public/
  index.html
  app.js
  styles.css
test/
  authorization.test.js  # Test HTTP theo version, bảng trường hợp cho phép/từ chối
                         # Bao gồm token, validation, spoofing và persistence/reset
scripts/
  ui-smoke.js            # Kiểm tra UI bằng Chrome/Edge local
evidence/
  README.md              # Cách tái hiện và giới hạn của evidence
  starter-idor.json      # Response thực tế thu được khi chạy demo
  v1-regression.txt      # Kết quả chạy regression ở Starter và V1
  tests-after.txt        # Kết quả test thực tế sau triển khai
plan.md
POLICY.md
README.md
```

Các file evidence chỉ được tạo từ kết quả chạy thật; danh sách trên là đầu ra dự kiến, chưa phải bằng chứng đã có.

## 3. Dữ liệu mẫu và danh tính

| Tài nguyên | Dữ liệu |
| --- | --- |
| Tenant Alpha | Alice, Bob, Vera, Admin Alpha; Project Alpha |
| Tenant Beta | Charlie, Admin Beta; Project Beta |
| Project Alpha | Alice = Owner, Bob = Member, Vera = Viewer |
| Project Beta | Charlie = Owner |
| A1 | Project Alpha, assignee Bob, Open |
| A2 | Project Alpha, assignee Bob, Closed |
| B1 | Project Beta, assignee Charlie, Open |
| B2 | Project Beta, chưa assign, Open |
| Fixture bổ sung | A3: Project Alpha, chưa assign, Open; A4: assign Alice, Open |

A3 và A4 giúp phân biệt “chưa assign” với “assign người khác”. Có thể tạo fixture trực tiếp trong test thay vì thêm API tạo task.

Tenant được seed sẵn nhưng chỉ được dùng làm điều kiện authorization từ V4. V1–V3 vẫn chặn Alice đọc B1 bằng quan hệ project.

Principal được resolve từ token ở server. Membership, project role và tenant admin được lấy từ dữ liệu server; mọi `role`, `userId`, `tenantId` tự gửi đều không trở thành danh tính hoặc quyền của caller. Token demo được công khai trong hướng dẫn vì chỉ đại diện cho tài khoản giả của lab.

### Lưu trữ SQLite

- Schema tối thiểu gồm `tenants`, `users`, `projects`, `project_memberships`, `tasks`. `users` lưu tenant và cờ tenant admin; `project_memberships` lưu project role; `tasks` lưu project, assignee, title, description và status.
- Dùng primary key, foreign key, unique `(project_id, user_id)` và CHECK cho role/status; bật `PRAGMA foreign_keys = ON` trên mỗi connection. Thêm index cho task theo project và membership theo user.
- Khởi tạo schema và seed khi database mới được tạo; không tự seed đè dữ liệu mỗi lần khởi động. Reset xóa dữ liệu và nạp seed trong một transaction, giữ schema.
- Dùng parameterized queries. Các ràng buộc như user/assignee phải cùng tenant hoặc thuộc đúng project vẫn được kiểm tra ở server; foreign key đơn lẻ không thay thế policy.
- Với mutation, đọc trạng thái hiện tại, kiểm tra quyền và ghi dữ liệu trong cùng transaction trên một connection; từ chối hoặc lỗi thì rollback. Xóa project dùng foreign key cascade để xóa tasks và memberships liên quan.
- Mọi version dùng chung file database local. Test dùng file SQLite tạm riêng cho từng test, seed độc lập, đóng connection và dọn file sau khi chạy; không chạm `data/lab.sqlite` của người demo.
- Bỏ qua file database runtime và các file phụ SQLite trong Git; commit schema/seed để tái tạo. Chỉ kiểm tra nội dung database bằng công cụ SQLite phù hợp; không xóa file phụ khi connection đang mở.

## 4. Thiết kế các version kế thừa

| Version | Kế thừa và bổ sung | API demo |
| --- | --- | --- |
| Starter | Xác thực token; thiếu object-level authorization trên mọi thao tác | Toàn bộ endpoint |
| V1 | Starter + kiểm tra membership với project chứa tài nguyên trên mọi thao tác | Toàn bộ endpoint |
| V2 | V1 + project roles và permission matrix cho từng action | Toàn bộ endpoint |
| V3 | V2 + ràng buộc Member phải là assignee và task còn Open khi edit | Toàn bộ endpoint |
| V4 | V3 + tenant boundary trước mọi quyết định project/task; thêm tenant admin | Toàn bộ endpoint |

Task assignee/status tồn tại trong seed từ đầu, nhưng đến V3 mới tham gia quyết định edit. Giữ cùng bộ endpoint ở mọi version để so sánh cùng request; chỉ nâng cấp policy. PATCH ở V1 được phép nếu caller là member của project, kể cả Viewer; V2 mới xét role. Starter chỉ yêu cầu token nhưng vẫn áp dụng validation và constraints chung.

### V1: Sửa IDOR/BOLA

1. Gọi Starter với token Alice và task B1, lưu response thực tế chứa dữ liệu Beta.
2. Viết regression test yêu cầu Alice đọc B1 phải bị từ chối và không chứa nội dung task.
3. Chạy cùng regression với Starter: test phải FAIL vì response là 200; lưu output.
4. Thêm kiểm tra membership của project chứa task tại server.
5. Chạy regression với V1: phải PASS; đồng thời Alice đọc A1 và Charlie đọc B1 vẫn 200.

Starter có characterization test xác nhận lỗ hổng còn tái hiện được. Regression cố ý thất bại trên Starter chạy bằng lệnh riêng, không làm bộ test mặc định luôn đỏ.

### V2: RBAC trong phạm vi project

Quyền được xác định bằng cặp `(userId, projectId)`. Một người có thể là Owner project này nhưng không có quyền ở project khác.

| Hành động | Viewer | Member | Project Owner | Người ngoài project |
| --- | --- | --- | --- | --- |
| Đọc task | Cho phép | Cho phép | Cho phép | Từ chối |
| Sửa task | Từ chối | Cho phép | Cho phép | Từ chối |
| Xóa project | Từ chối | Từ chối | Cho phép | Từ chối |
| Xem/thêm/đổi role/xóa member | Từ chối | Từ chối | Cho phép | Từ chối |

Để giữ lab nhỏ, mỗi project có một Owner cố định; API membership chỉ quản lý Viewer/Member. Không hỗ trợ chuyển Owner, hạ quyền hoặc xóa Owner. Trường hợp cố sửa Owner trả 409.

### V3: Kết hợp ReBAC và ABAC

- Viewer vẫn chỉ đọc.
- Member chỉ sửa khi đồng thời: còn là member của project chứa task, `task.assigneeId === principal.userId`, và `task.status === 'Open'`.
- Owner giữ quyền sửa task trong project, kể cả task Closed hoặc không assign cho mình. Đây là lựa chọn policy của lab và phải được ghi trong `POLICY.md` cùng test tương ứng.
- Membership là quan hệ user–project; assignee là quan hệ user–task; trạng thái Open/Closed là thuộc tính tài nguyên.
- `PATCH` chỉ cho sửa `title`, `description`, `status`; không cho tự đổi `projectId`, `tenantId`, `assigneeId` để tạo quyền. Member có thể đóng task đang Open của mình; lần sửa tiếp theo bị từ chối. Owner có thể mở lại.
- Policy đánh giá trên task hiện tại do server load, trước khi áp dụng payload. Không dùng giá trị `status=Open` do caller gửi để vượt kiểm tra task Closed.

### V4: Tenant boundary — mở rộng

- Xác định tenant của tài nguyên qua project trên server, đối chiếu với tenant của principal trước khi xét role hoặc quan hệ.
- Tenant admin được thực hiện các action của Owner trên project trong chính tenant, kể cả khi không có membership; vẫn tuân thủ validation và quy tắc một Owner cố định.
- Admin Alpha gọi task, project hoặc membership của Beta đều bị từ chối. Cần positive test Admin Alpha thao tác được trong Alpha để tránh bản sửa chặn tất cả.
- Khi thêm member, user đích phải cùng tenant với project, kể cả caller là admin hợp lệ.
- Không dùng `tenantId` trên query, header hoặc body làm tenant đáng tin cậy. Có test gọi trực tiếp bỏ qua UI và giả mạo cả role lẫn tenant.

## 5. API, enforcement và lỗi

Các phiên bản được chọn bằng URL rõ ràng: `/api/:version/...`, với allowlist `starter`, `v1`, `v2`, `v3`, `v4`. Server dùng version từ URL để chọn policy demo; version không hợp lệ trả 404. Đây là cơ chế so sánh trong lab, không phải cơ chế bảo vệ cho production.

| Method | Route sau `/api/:version` | Version |
| --- | --- | --- |
| GET | `/tasks/:id` | Starter–V4 |
| PATCH | `/tasks/:id` | Starter–V4 |
| DELETE | `/projects/:id` | Starter–V4 |
| GET | `/projects/:id/members` | Starter–V4 |
| POST | `/projects/:id/members` | Starter–V4 |
| PATCH | `/projects/:id/members/:userId` | Starter–V4 |
| DELETE | `/projects/:id/members/:userId` | Starter–V4 |

Luồng xử lý chung:

```text
Validate version/route → Authenticate → Validate ID và payload
→ Load resource + project + membership từ server
→ authorize(version, principal, action, resourceContext)
→ Deny hoặc thực thi thao tác → Serialize response
```

- `policy.js` là PDP: trả `{ allowed, reason, checks }`, không tự ghi dữ liệu.
- Route là PEP: bắt buộc gọi PDP trước khi trả nội dung task hoặc thực hiện mutation. Task lookup và project lookup dùng chung context để tránh route kiểm tra khác nhau.
- V4 kiểm tra tenant trước membership/RBAC/assignee/status; tenant admin chỉ được xét sau khi tenant boundary đã đạt.
- Mỗi request đánh giá lại dữ liệu hiện tại; xóa membership có hiệu lực ở request tiếp theo.
- 401: thiếu token hoặc token sai. 403: có danh tính nhưng thiếu quyền. 404: tài nguyên không tồn tại. Dùng 403 nhất quán cho trường hợp B1 tồn tại nhưng Alice không được đọc; chấp nhận việc mã lỗi có thể tiết lộ sự tồn tại ID trong phạm vi lab, không trả title/description/assignee.
- 400: ID/payload sai, field không hỗ trợ, role/status không hợp lệ. 409: membership trùng hoặc cố thay đổi Owner cố định.
- Body PATCH task chứa `role`, `tenantId`, `projectId`, `assigneeId` bị 400; header/query giả mạo role/tenant bị bỏ qua và quyết định quyền vẫn dựa trên server.
- `role` trong API quản lý member là role của user đích, chỉ nhận Viewer/Member sau khi caller đã được authorize; không phải role tự khai của caller.
- Xóa project đồng thời loại task và memberships liên quan trong transaction SQLite. Test xác nhận người bị từ chối không làm thay đổi dữ liệu.

## 6. UI demo và log

Một trang gồm ba vùng, bố cục đơn giản, không cần dashboard thống kê:

1. **Request:** chọn version, danh tính hoặc Anonymous, action, task/project ID; payload JSON chỉ hiện khi cần. Có thể nhập ID tự do và dán Bearer token để thử request sai.
2. **Response:** method, URL, HTTP status, JSON response và thời gian xử lý.
3. **Authorization trace:** các bước server thực sự đã đánh giá, kết quả từng bước và lý do allow/deny.

Trace ví dụ Alice đọc B1:

```text
Starter: authenticated Alice → object authorization SKIPPED → 200
V1: authenticated Alice → project membership FAIL → 403
V4: authenticated Alice → tenant boundary FAIL → 403
```

“Trước kiểm tra” là thông tin request và danh tính đã xác thực; “sau kiểm tra” là kết quả PDP và response thực tế. Không trả một bản task chưa được authorize để UI hiển thị ở phần trước kiểm tra. Trace chỉ chứa check đã chạy; các check không chạy được ghi SKIPPED, không bịa kết quả.

- Với JSON response, dùng envelope `{ data, error, trace, requestId }`. Bản minilab dùng 200 cho sửa/xóa và 201 cho tạo membership; chưa có endpoint trả 204.
- Trace chỉ gồm tên check, pass/fail/skipped và mã lý do; không chứa token hoặc nội dung task bị từ chối. Log hiển thị là tiện ích phát triển local.
- Preset: Alice đọc A1, Alice đọc B1, Charlie đọc B1, Viewer thử edit, Bob sửa A1/A2/A3/A4, giả mạo Admin, Admin Alpha gọi Beta.
- Nút **So sánh Starter/V1** gửi cùng GET với cùng user/ID đến hai version, hiển thị cạnh nhau. Không tự gửi mutation qua nhiều version vì dữ liệu có thể đã thay đổi.
- Nút **Reset dữ liệu** gọi endpoint demo riêng, chỉ có trong chế độ lab local; các version dùng chung file SQLite nên mutation ở version trước ảnh hưởng version sau cho đến khi reset. UI ghi rõ điều này; restart server không reset dữ liệu.
- Có ô header/query tùy chọn cho thử giả mạo; server phải bỏ qua quyền caller tự khai ngay cả khi request được gửi bằng curl hoặc test.

## 7. Chiến lược kiểm thử và evidence

Mỗi test tạo app với file SQLite tạm và seed riêng để không phụ thuộc thứ tự. Có test đóng/mở lại database để xác nhận dữ liệu được lưu bền, test reset khôi phục seed và test xóa project không để lại task/membership mồ côi. Test từ V1 tiếp tục chạy trên V2–V4; test RBAC từ V2 tiếp tục chạy trên V3–V4, nhưng oracle của Member edit được siết theo V3. Đây là thay đổi policy có chủ đích, không phải yêu cầu giữ nguyên mọi kết quả 200 của V2.

| Nhóm | Positive | Negative |
| --- | --- | --- |
| Authentication | Token Alice hợp lệ | Anonymous/token sai → 401 |
| V1 object access | Alice/A1; Charlie/B1 → 200 | Alice/B1 → 403, không chứa dữ liệu Beta |
| V2 read | Viewer/Member/Owner đọc trong project | Caller ngoài project bị từ chối |
| V2 edit | Member/Owner sửa trong project | Viewer hoặc caller ngoài project bị từ chối |
| V2 delete project | Owner xóa project | Member/Viewer/người ngoài bị từ chối |
| V2 membership | Owner xem/thêm/đổi/xóa Member/Viewer | Vai trò còn lại bị từ chối cho từng endpoint |
| V3 edit | Bob sửa A1; Owner sửa A2 | Bob sửa B1, A3, A4 hoặc A2 bị từ chối |
| V3 dữ liệu hiện tại | Member đóng A1 thành công | Sửa tiếp sau khi đóng; gửi status Open để vượt kiểm tra; assignee đã mất membership |
| V4 tenant | Admin Alpha thao tác trong Alpha | Admin Alpha gọi trực tiếp task/project/members Beta |
| V4 user đích | Thêm member cùng tenant | Thêm user Beta vào project Alpha |
| Giả mạo | Request hợp lệ vẫn theo quyền thật | `role=Admin`, `tenantId=Beta` qua query/header/body không tăng quyền |
| Validation | Payload đúng được lưu | ID sai, task không tồn tại, status/role sai, JSON lỗi, field thừa, version sai |

Kiểm tra cả HTTP status, nội dung response và state sau request. Với mutation bị từ chối, assert dữ liệu không đổi; với mutation được phép, assert thay đổi đã xảy ra và đọc lại được khi phù hợp. Response từ chối không chứa title/description của task đích.

Lệnh dự kiến:

```text
npm start                       # Chạy server + UI local
npm run db:reset                 # Reset database demo về seed ban đầu
npm test                        # Characterization Starter + tests V1–V4 đã triển khai
npm run test:idor -- --version=starter  # Regression riêng: dự kiến FAIL
npm run test:idor -- --version=v1       # Cùng regression: dự kiến PASS
npm run evidence                # Reset fixture và ghi kết quả thực tế
```

Trên PowerShell dùng `npm.cmd` nếu execution policy chặn `npm.ps1`. Script evidence phải ghi rõ version, request đã bỏ token, status, body đã giới hạn, kết quả test và thời điểm chạy. Không đánh dấu hoàn thành bằng output mẫu tự viết.

Code diff: lưu hoặc hướng dẫn chạy `git diff` cho các file auth/policy/routes/tests sau triển khai. Không tự commit/push. Evidence trước/sau được tái hiện bằng hai policy Starter/V1 trên cùng codebase, không tuyên bố đó là hai commit lịch sử nếu chưa có.

## 8. Thứ tự triển khai

| Bước | Việc thực hiện | Điều kiện hoàn tất |
| --- | --- | --- |
| 1 | Chốt seed, permission matrix, lỗi và policy Owner | `POLICY.md` có oracle rõ ràng |
| 2 | Tạo app factory, auth adapter, SQLite schema/seed/reset, toàn bộ endpoint Starter | Alice đọc B1 nhận 200; mutation chỉ cần token hợp lệ; Anonymous nhận 401; restart giữ dữ liệu |
| 3 | Viết regression, thu evidence Starter, thêm V1 | Regression đỏ ở Starter, xanh ở V1; legitimate reads vẫn đạt |
| 4 | Thêm policy V2 cho cùng bộ endpoint, enforce role trên mutation và member management | Mỗi action có test allow/deny; không tự khai quyền |
| 5 | Thêm điều kiện V3 | Membership + assignee + status được kiểm tra trên server |
| 6 | Thêm UI, preset, compare GET, trace và reset | Demo được Starter/V1 và V2/V3, log khớp response |
| 7 | Nếu còn thời gian, thêm V4 | Admin cùng tenant được phép; cross-tenant và spoofing bị chặn |
| 8 | Chạy toàn bộ test, thu evidence và viết README | Bài nộp có chính sách, tests, evidence, diff và giới hạn |

Để phù hợp 55 phút thực hành, chuẩn bị sẵn skeleton, UI và adapter xác thực trước giờ thực hành. Dành 45–60 phút cho reproduce/test/fix V1; 60–75 cho V2; 75–90 cho V3; 90–100 cho V4 nếu còn thời gian. Xây toàn bộ skeleton và UI từ con số 0 không được tính là đã nằm gọn trong 55 phút này.

## 9. Tiêu chí nghiệm thu và giới hạn

- [ ] Starter tái hiện được Alice đọc B1 và có evidence thực tế.
- [ ] V1 chặn B1 nhưng giữ Alice/A1 và Charlie/B1 thành công.
- [ ] Mọi version có cùng bộ endpoint; V2 enforce project role trên từng action, có positive/negative tests cho từng quyền.
- [ ] V3 không làm mất bảo vệ V1/V2; Member chỉ sửa task được assign, còn Open, trong project mình còn membership.
- [ ] UI chuyển được version và hiển thị response/trace đúng; request trực tiếp tuân thủ cùng policy.
- [ ] Giả mạo role/tenant không tăng quyền; mutation bị từ chối không đổi state.
- [ ] Nếu triển khai V4: tenant admin chỉ có quyền trong tenant của mình, kể cả qua membership endpoints.
- [ ] README có cách chạy, token demo, reset, lệnh test, evidence và code diff.
- [ ] SQLite lưu dữ liệu qua restart; reset khôi phục seed; test dùng database tạm riêng và không thay đổi database demo.
- [ ] Ghi rõ những phần chưa triển khai/chưa kiểm thử; không gọi V4 hoàn thành nếu mới có kế hoạch.

Ngoài phạm vi: đăng nhập thật, cấp/thu hồi token, OAuth2 server, nhiều process, stress test concurrent writes, cache authorization, policy engine phân tán, chuyển Owner, bulk APIs và UI quản trị hoàn chỉnh. Một file SQLite trong một process đủ cho minilab; vẫn dùng transaction cho kiểm tra quyền và ghi dữ liệu, chưa đánh giá khả năng chịu tải hoặc triển khai phân tán.

## 10. Nội dung giải thích khi demo

1. Scope `tasks:read` chỉ cho phép loại thao tác đọc ở mức API; vẫn cần kiểm tra Alice có quyền trên đúng task/project/tenant. Scope không thay thế object authorization.
2. Role Member chưa đủ để sửa ở V3: cần membership hiện tại trong đúng project, quan hệ assignee và trạng thái Open.
3. Ẩn nút Delete chỉ ảnh hưởng UI; caller vẫn gửi HTTP trực tiếp được, nên PEP phải nằm ở server.
4. Với lượng tài liệu lớn và nhiều nhóm chia sẻ, dùng policy tập trung có mô hình quan hệ rõ ràng, PEP nhất quán ở các API, test theo matrix; cân nhắc dịch vụ/PDP chuyên dụng, indexing quan hệ và cache có invalidation. Lab chỉ dùng một hàm policy để minh họa nguyên tắc này.

Lựa chọn của lab: membership tạo ACL theo project; RBAC gom quyền theo Viewer/Member/Owner; ReBAC kiểm tra quan hệ membership/assignee; ABAC kiểm tra status và tenant. Kết hợp các lớp theo một thứ tự rõ ràng giúp tránh mỗi route tự diễn giải policy khác nhau.
