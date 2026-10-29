# Chính sách của minilab

| Version | Quy tắc bổ sung, kế thừa version trước |
| --- | --- |
| Starter | Mọi endpoint chỉ yêu cầu token hợp lệ; cố ý thiếu object authorization |
| V1 | Mọi thao tác yêu cầu membership ở project chứa tài nguyên; chưa phân biệt role/action |
| V2 | Giữ các endpoint, thêm quyền theo role project và action |
| V3 | Member edit cần đúng assignee và trạng thái hiện tại Open |
| V4 | Tenant boundary trước mọi policy; tenant admin có quyền Owner chỉ trong tenant mình |

Mọi version có cùng endpoint đọc/sửa task, xóa project và quản lý members. Chỉ policy thay đổi: Viewer/Member ở V1 vẫn sửa/xóa và quản lý members được trong project mình; V2 mới siết các quyền này. Role/tenant của caller luôn lấy từ server. Query/header tự khai bị bỏ qua; field không được phép trong body bị từ chối. Role gửi ở membership API là role của user đích, không làm thay đổi quyền của caller. Validation payload, constraints và quy tắc Owner cố định áp dụng ở mọi version, kể cả Starter.

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
