# Chính sách của minilab

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

## Ý nghĩa trace và kết quả cuối

`Authorization decision` chỉ là kết quả PDP kiểm tra quyền, chưa phải kết quả toàn bộ request. `ALLOW` vẫn có thể đi cùng HTTP 400/404/409 nếu payload hoặc quy tắc nghiệp vụ không hợp lệ. Owner cố định được kiểm tra ở bước `Business rule: fixed project owner`; sửa/xóa Owner trả FAIL và 409, kể cả Starter. Trace kết thúc bằng `Request outcome`: SUCCESS cho response thành công, REJECTED cho 4xx, ERROR cho 5xx, kèm mã lỗi hoặc HTTP status. Mutation chỉ báo SUCCESS sau khi transaction hoàn tất.
