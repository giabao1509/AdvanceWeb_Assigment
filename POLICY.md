# Chính sách của minilab

## Engine và nguồn dữ liệu

Trên branch `Block-6-Advance`, **V1–V4 dùng OpenFGA**. Starter vẫn cố ý bỏ qua object authorization. Bộ chọn version/API giữ nguyên; mỗi version ánh xạ đến relation riêng trong cùng model đã pin. Đổi version không thay model hoặc seed lại quan hệ.

OpenFGA lưu store/model/tuples bền trong **SQLite riêng** trên Docker volume, thay datastore PostgreSQL trước đó. Database này khác `data/lab.sqlite` của ứng dụng. Cách Check và policy Starter–V4 không thay đổi; vẫn đồng bộ quan hệ vì hai database có schema và transaction riêng.

SQLite là nguồn gốc của danh tính, tenant, project, membership và task. OpenFGA lưu bản chiếu quan hệ `tenant.member/admin`, `project.tenant/owner/member/viewer`, `task.project/assignee`. Backend truyền `current_status` đọc từ SQLite cho condition `task_is_open`; body gửi `status: Open` không làm task Closed vượt quyền. Store/model ID do server quản lý.

OpenFGA quyết định ALLOW/DENY; Express là PEP thực thi. Chẩn đoán từ snapshot chỉ giải thích DENY bằng mã thân thiện, không cấp quyền thay engine. Trace Check có relation/model, không giả rằng OpenFGA trả đường suy luận từng nhánh.

| Version | Read project/task | Edit task | Delete project / members |
| --- | --- | --- | --- |
| V1 | participant | participant | participant |
| V2 | participant | Owner hoặc Member | Owner |
| V3 | participant | Owner hoặc (Member và assignee và Open) | Owner |
| V4 | cùng tenant và (participant hoặc admin tenant) | cùng tenant và (Owner hoặc admin tenant hoặc (Member và assignee và Open)) | cùng tenant và (Owner hoặc admin tenant) |

`participant = owner or member or viewer`. Read task kế thừa qua project. Relation có hậu tố `_v1`…`_v4`; V1–V3 không xét tenant. Cross-tenant membership tạo ở version trước không vượt được boundary V4. Role, action và version lạ bị chặn trước mọi nhánh, kể cả Starter/admin.

## Đồng bộ, transaction và lỗi dịch vụ

Mọi mutation quan hệ, kể cả Starter và reset, ghi SQLite và outbox trong cùng transaction. Sync đối chiếu toàn bộ tuple của store lab, xóa grant cũ trước khi ghi grant mới, có pagination/batch và lease một synchronizer. Chỉ mở readiness khi applied revision bằng desired revision và binding/model đúng. Startup/manual sync cũng đóng readiness trước khi chạm graph. Job tồn tại qua restart; chưa có worker nền tự retry vô hạn, phục hồi bằng startup, CLI sync hoặc nút Đồng bộ lại.

200/201 cho mutation quan hệ nghĩa là đã commit và đồng bộ. Nếu commit xong nhưng sync chưa thành công, trả **202** với `committed: true`, operation ID và trạng thái pending. Không báo mutation thất bại hoặc chạy lại nghiệp vụ. Caller được xác thực chỉ xem metadata operation của mình. Request bảo vệ tiếp theo bị 503 khi pending; sau sync, user đã bị thu hồi membership nhận 403 dù vẫn là assignee.

Không có transaction chung giữa hai database SQLite của ứng dụng và OpenFGA. Server đọc snapshot/revision trong transaction ngắn, đóng transaction trước HTTP Check, rồi mở transaction ngắn xác nhận revision/binding/readiness trước khi trả dữ liệu hoặc ghi. Dữ liệu đổi giữa chừng trả **409 AUTHORIZATION_CONTEXT_CHANGED**, không dùng quyết định cũ. Trigger tăng revision cho SQL writes/cascade/reset; reset không đưa counter về giá trị cũ. Callback transaction phải đồng bộ.

Check dùng **HIGHER_CONSISTENCY**, SDK không tự retry và có timeout. Engine lỗi, response sai, condition/model lỗi hoặc graph chưa ready trả **503**, không giả thành DENY 403 và không fallback local/Starter. Request bị 4xx/5xx trước commit không thay đổi nghiệp vụ. Starter và ngoại lệ danh mục không phụ thuộc Check.

Trace phân biệt OpenFGA Check, Authorization decision, Business rule, Authorization sync và Request outcome. HTTP 202 kết thúc bằng **PENDING**; chỉ báo SUCCESS hoàn tất sau commit và sync nếu có. Error code cụ thể giữ nguyên khi chẩn đoán chắc chắn, nếu engine DENY mà snapshot không phân loại được thì trả `AUTHORIZATION_DENIED`.

Các mục bên dưới mô tả policy nghiệp vụ giữ từ minilab gốc; phần trên bổ sung cách OpenFGA thực thi và các trạng thái vận hành mới.

| Version | Quy tắc bổ sung, kế thừa version trước |
| --- | --- |
| Starter | Mọi endpoint chỉ yêu cầu token hợp lệ; cố ý thiếu object authorization |
| V1 | Mọi thao tác yêu cầu membership ở project chứa tài nguyên; chưa phân biệt role/action |
| V2 | Giữ các endpoint, thêm quyền theo role project và action |
| V3 | Member edit cần đúng assignee và trạng thái hiện tại Open |
| V4 | Tenant boundary trước mọi policy; tenant admin có quyền Owner chỉ trong tenant mình |

Mọi version có cùng endpoint đọc/sửa task, xóa project và quản lý members. Chỉ policy thay đổi: Viewer/Member ở V1 vẫn sửa/xóa và quản lý members được trong project mình; V2 mới siết các quyền này. Role/tenant của caller luôn lấy từ server. Query/header tự khai bị bỏ qua; field không được phép trong body bị từ chối. Role gửi ở membership API là role của user đích, không làm thay đổi quyền của caller. Validation payload, constraints và quy tắc Owner cố định áp dụng ở mọi version, kể cả Starter.

Ngoại lệ khám phá của UI lab: GET `/api/:version/projects` yêu cầu token hợp lệ nhưng cố ý trả ID/tên của mọi project đang tồn tại ở mọi version. Không trả task, task count, members hoặc tenant qua danh mục này. Đây không phải API đọc nội dung project và không cấp quyền mở project. Trace ghi rõ `DISCOVERABLE_PROJECT_NAMES_ONLY`.

GET `/api/:version/projects/:id` và GET `/api/:version/projects/:id/tasks` dùng action `read` và cùng policy với đọc task: Starter chỉ xác thực; V1–V3 cần membership; V4 kiểm tra tenant rồi xét tenant admin/membership. Deny trả `data: null`. Quyền đọc project/task không cấp quyền xem danh sách members: API members vẫn dùng action quản lý members, từ V2 yêu cầu Owner hoặc tenant admin hợp lệ ở V4.

| Hành động trong project, từ V2 | Viewer | Member | Owner | Người ngoài |
| --- | --- | --- | --- | --- |
| Đọc task | Có | Có | Có | Không |
| Sửa task V2 | Không | Có | Có | Không |
| Sửa task V3/V4 | Không | Đúng assignee + Open | Có, kể cả Closed | Không |
| Xóa project | Không | Không | Có | Không |
| Xem/thêm/đổi role/xóa member | Không | Không | Có | Không |

V4 tenant admin không cần membership trong project cùng tenant; vẫn phải qua validation, không thay đổi Owner cố định và không thêm user khác tenant vào project. Admin chưa có membership không có đặc quyền ở V1–V3.

PATCH task chỉ nhận title/description/status. Member được đóng task Open của mình; không thể tự mở lại vì policy xét trạng thái database trước mutation. Owner/admin hợp lệ có thể mở lại. Membership bị thu hồi có hiệu lực ở request tiếp theo kể cả task vẫn assign cho user đó.

Membership là ACL ở project; RBAC gom quyền theo role; ReBAC kiểm tra quan hệ membership và assignee; ABAC xét trạng thái task và tenant. Scope đọc API không tự cấp quyền trên task cụ thể. UI không phải nơi enforce quyền: request trực tiếp luôn đi qua cùng PEP/PDP ở server.

## Deny by default: chỉ cho phép khi có quy tắc rõ ràng

PDP `authorize()` chỉ nhận version `starter/v1/v2/v3/v4`, action `read/edit/delete/members` và role membership `Viewer/Member/Owner`. Version, action hoặc role membership không được nhận diện trả deny với mã `UNKNOWN_VERSION`, `UNKNOWN_ACTION` hoặc `UNKNOWN_ROLE`; kiểm tra này chạy trước cả nhánh Starter, V1 và tenant admin. Không có membership khác với có membership mang role không hợp lệ: trường hợp đầu được xét theo policy version, trường hợp sau bị từ chối.

PDP cũng từ chối khi thiếu danh tính/project, hoặc action edit thiếu task hay task không thuộc project đã truyền. Từ V2, quyền được liệt kê tường minh theo từng role/action như bảng trên; không suy ra quyền edit chỉ vì role khác Viewer và không cấp quyền cho action mới chỉ vì caller là Owner. Action mới phải được khai báo và gán quyền trước khi sử dụng. PEP chỉ chạy nghiệp vụ khi `decision.allowed === true`.

Ở biên HTTP, version lạ trả 404, token thiếu/sai trả 401, route chưa khai báo trả 404; deny từ PDP trả 403 và `data: null`. Mã lỗi PDP trực tiếp không thay thế cách ánh xạ lỗi tại router. Role, tenant và membership của caller vẫn lấy từ server.

**Phạm vi và ngoại lệ:** Starter cố ý cho phép truy cập đối tượng sau xác thực; V1 cố ý cho mọi thành viên thao tác trong project. Kiểm tra đầu vào PDP không biến hai bản này thành policy an toàn cuối cùng. Danh mục tên project, `/lab/config` công khai và `/lab/reset` local là ngoại lệ đã khai báo, không đi qua PDP; không tuyên bố toàn bộ ứng dụng lab áp dụng quyền tối thiểu như production.

## Least privilege: thu hẹp quyền theo nhu cầu của từng version

- **V1:** giới hạn tài nguyên theo membership, nhưng chưa giới hạn hành động; Viewer/Member vẫn có quyền rộng có chủ đích để minh họa nhu cầu V2.
- **V2:** Viewer chỉ đọc; Member đọc/sửa; Owner được quản lý members và xóa project. Quyền thuộc đúng project, không phải role toàn hệ thống.
- **V3:** giữ ACL/RBAC; Member edit còn cần đúng assignee và task hiện tại Open. Quyền read không tự cấp edit; assignee không thay thế membership.
- **V4:** giữ điều kiện V3 cho người dùng thường; tenant admin được quyền tương đương Owner chỉ sau khi qua tenant boundary. Đây là quyền quản trị mới có phạm vi, không phải bỏ kiểm tra cho mọi caller. Owner/admin vẫn chịu validation và quy tắc Owner cố định.

Kiểm chứng bằng `test/policy.test.js` cho đầu vào PDP không hợp lệ và ma trận allowlist, cùng `test/authorization.test.js` cho HTTP allow/deny, dữ liệu không đổi sau thao tác bị chặn, quyền Member theo task và admin khác tenant. Đây là kiểm chứng local, không phải chứng nhận an toàn production.

## Ý nghĩa trace và kết quả cuối

`Authorization decision` chỉ là kết quả kiểm tra quyền, chưa phải kết quả toàn bộ request. `ALLOW` vẫn có thể đi cùng HTTP 400/404/409 nếu payload hoặc quy tắc nghiệp vụ không hợp lệ. Owner cố định được kiểm tra ở bước `Business rule: fixed project owner`; sửa/xóa Owner trả FAIL và 409, kể cả Starter. `Request outcome` là SUCCESS khi hoàn tất, PENDING cho 202, REJECTED cho 4xx và ERROR cho 5xx. Mutation quan hệ chỉ báo SUCCESS sau khi transaction và đồng bộ đều hoàn tất.
