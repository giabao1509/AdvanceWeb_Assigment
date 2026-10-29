# Chính sách của minilab

| Version | Quy tắc bổ sung, kế thừa version trước |
| --- | --- |
| Starter | Có token hợp lệ thì GET được mọi task; cố ý thiếu object authorization |
| V1 | GET task yêu cầu membership ở project chứa task |
| V2 | Thêm role project và các endpoint mutation/member management |
| V3 | Member edit cần đúng assignee và trạng thái hiện tại Open |
| V4 | Tenant boundary trước mọi policy; tenant admin có quyền Owner chỉ trong tenant mình |

Starter/V1 chỉ có GET task. Role/tenant của caller luôn lấy từ server. Query/header tự khai bị bỏ qua; field không được phép trong body bị từ chối. Role gửi ở membership API là role của user đích, không làm thay đổi quyền của caller.

| Hành động trong project | Viewer | Member | Owner | Người ngoài |
| --- | --- | --- | --- | --- |
| Đọc task | Có | Có | Có | Không |
| Sửa task V2 | Không | Có | Có | Không |
| Sửa task V3/V4 | Không | Đúng assignee + Open | Có, kể cả Closed | Không |
| Xóa project | Không | Không | Có | Không |
| Xem/thêm/đổi role/xóa member | Không | Không | Có | Không |

V4 tenant admin không cần membership trong project cùng tenant; vẫn phải qua validation, không thay đổi Owner cố định và không thêm user khác tenant vào project. Admin chưa có membership không có đặc quyền ở V1–V3.

PATCH task chỉ nhận title/description/status. Member được đóng task Open của mình; không thể tự mở lại vì policy xét trạng thái database trước mutation. Owner/admin hợp lệ có thể mở lại. Membership bị thu hồi có hiệu lực ở request tiếp theo kể cả task vẫn assign cho user đó.

Membership là ACL ở project; RBAC gom quyền theo role; ReBAC kiểm tra quan hệ membership và assignee; ABAC xét trạng thái task và tenant. Scope đọc API không tự cấp quyền trên task cụ thể. UI không phải nơi enforce quyền: request trực tiếp luôn đi qua cùng PEP/PDP ở server.
