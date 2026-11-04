# Tiến độ OpenFGA — Block-6-Advance

Bản tích hợp: 02/11/2026. Cập nhật khôi phục và evidence: 04/11/2026. Nhánh: `Block-6-Advance`. Kết quả kiểm chứng trong tài liệu là local; trạng thái commit/push đối chiếu bằng lịch sử Git và branch trên remote.

| Phần | Trạng thái và bằng chứng |
| --- | --- |
| Branch | Đã checkout `Block-6-Advance`, giữ thay đổi kế hoạch trước đó |
| Baseline | 52/52 tests và browser smoke PASS trước sửa |
| Engine | OpenFGA v1.22.1 + SQLite chạy thật qua Compose; migration/healthcheck PASS; không còn PostgreSQL service |
| Chuyển datastore | Store/model IDs và từng giá trị tuple/protobuf được giữ khi chuyển PostgreSQL → SQLite; business rows không thay đổi; nguồn cũ giữ làm backup |
| Policy | Model chung, relation theo V1–V4; Starter SKIPPED; 432 quyết định expected độc lập PASS |
| API / dữ liệu | Read/write, membership CRUD, delete/reset qua SDK; snapshot/revision, outbox, lease và readiness |
| Recovery | 202 sau commit pending; operation chỉ caller xem; recovery sau remote write/khởi tạo service mới PASS |
| HTTP / model / fault tests | 69/69 tests PASS, gồm missing condition, sai binding, timeout và race ALLOW/DENY |
| Browser | Forms, version selector, pending/recovery và mobile PASS; thêm 503 sau điều hướng/reload, retry lỗi, không lặp mutation, phản hồi sync sau đổi tài khoản; không JS errors |
| Persistence restart | Fixture riêng giữ SQLite title, store ID, model ID và kết quả allow/deny qua restart container OpenFGA thật dùng SQLite |
| Init chạy lặp | `fga:init` chạy hai lần giữ nguyên store/model, không reset nội dung SQLite demo |
| Reports | Markdown/HTML đồng bộ, 11 mục và 4 sơ đồ; phần kiểm chứng cập nhật recovery 503. Browser QA 04/11: không tràn mobile, không chồng footer ở chế độ in, không JS errors. Kiểm chứng 8 cards quyết định kỹ thuật thuộc lượt 02/11 |
| Evidence | `evidence/openfga/manifest.json` được tạo lại cho source hiện tại, gồm hash `start.bat`, tài liệu tiến độ và source/artifact khác; evidence baseline được giữ riêng |
| Dependencies | SDK/Axios pin; npm install/audit sau override báo 0 vulnerabilities |
| Hosted / manual acceptance | **NOT_VERIFIED**: chưa có hosted CI/deployment, giảng viên nghiệm thu hoặc benchmark nhiều app instances |

Các lệnh tái hiện có trong README. Evidence generator tự chạy regression, full tests và browser smoke trên fixture riêng; không sửa log/JSON để đổi kết quả. Các ảnh và kết quả QA báo cáo/restart của lượt này nằm trong `.local-check/`, không commit dữ liệu runtime.

`evidence/openfga/datastore.json` xác nhận container thực tế dùng SQLite và volume bền; `sqlite-migration.json` ghi kiểm chứng dữ liệu chuyển, `sqlite-restart.json` ghi persistence qua restart engine SQLite.

Lượt cập nhật 04/11 bổ sung nút **Đồng bộ lại** ngay trên màn hình lỗi 503. Browser smoke tái hiện thao tác thành viên đã commit → rời màn hình pending → 503 → retry còn lỗi → reload → sync thành công; revision và số operation không tăng. Phản hồi sync đến sau khi đổi tài khoản bị bỏ qua. Fixture dùng SQLite/store tạm, không mở/reset dữ liệu demo. Các kiểm chứng restart/migration/dependency audit ngày 02/11 là bằng chứng lịch sử, không phải những kiểm tra được chạy lại trong lượt cập nhật này.

Giới hạn hiện tại: đổi model đã pin cần migration/binding chủ động; chưa có lệnh migration tự động. Khi graph pending, toàn bộ V1–V4 tạm chặn. Sau crash, lease có thể cần tối đa 30 giây trước khi sync lại. Chưa có worker nền tự retry vô hạn. Các lựa chọn này được ghi rõ trong POLICY và báo cáo.
