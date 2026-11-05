# Trạng thái triển khai

Hệ thống hiện có **Baseline / Saga**. Saga dùng một engine chung cho bù, đối soát và phục hồi sau restart. Không còn version gates hoặc danh sách đơn theo version. Metadata cũ được giữ để replay không tạo thêm đơn và không mất lịch sử.

UI mặc định đặt hàng thủ công: tạo đơn giữ hàng, chọn ví rồi thanh toán hoặc hủy trước thanh toán. Payment kiểm tra số dư, ghi charge/debit và refund/credit trong transaction local. Thiếu tiền là lỗi từ DB thật: Baseline để lại hàng đã giữ, Saga tự release và cancel. Đơn chờ thanh toán không bị worker tự charge.

Retry mặc định **3 lần cho từng bước**, ngoài lần xử lý đầu; chỉnh bằng `SAGA_MAX_RETRIES`. `retry_count`, `retry_limit`, `retry_exhausted`, `resume_blocked` lưu trong DB. Bước tiến khác F4 hết lượt chuyển `REQUIRES_REVIEW`; bước bù giữ `COMPENSATING` và chờ khắc phục, giữ pending và operation IDs; restart không cấp lại lượt. Resume chủ động sau khắc phục cấp lượt mới, không làm lại side effect đã commit. Resume khi đang chạy không reset bộ đếm.

Baseline và Saga dùng chung `data/{order,inventory,payment}.sqlite`; `orders.mode` cố định cơ chế của từng đơn. Kho, ví và lịch sử không đổi khi chuyển nút. Migration giữ file cũ và nhập dữ liệu một lần. UI chỉ có hai nút chọn cơ chế cho đơn mới, hiển thị bộ đếm và trạng thái chờ xử lý. Khi service đang khởi động, nút tiếp tục tạm khóa để không tiêu lượt trước khi dependency sẵn sàng.

Kiểm chứng local: **48 backend tests PASS** (17 nghiệp vụ, 9 thủ công, 6 retry, 4 quan sát kho/log, 3 dữ liệu chung/migration, 7 F4, 2 checkpoint V3), browser đặt hàng/thanh toán/mobile, F4/F6 recovery và typecheck PASS. Các test dùng fixture riêng; DB live được sao lưu trước nâng cấp và giữ lịch sử.

F4 tự khôi phục Payment theo thời gian chọn (mặc định 4 giây). Kết quả charge chưa rõ giữ `RECOVERING`; hết lượt chỉ dừng operation query. Order phát hiện instance mới để tự đối soát có giới hạn, dùng ID cũ và không cần nút tiếp tục. Timer giữ trong launcher, có lưu trạng thái để xử lý khi launcher restart. Test phủ phục hồi trước/sau budget, baseline, restart, khôi phục sớm, query NOT_FOUND và lỗi readiness.

`DEMO.md` có kịch bản và SQL đọc DB. `db:inspect` đọc đúng WAL; `db:export` tạo snapshot tự chứa. README và report Markdown/HTML mô tả thiết kế hiện tại. Bộ matrix/video tổng thể vẫn là bản cũ. V3 F5/F6 đã được tạo riêng, xem `evidence/latest-v3.json`: ba mốc trước dừng, sau restart và sau hội tụ, kèm ảnh UI và manifest SHA-256. Checkpoint IPC chỉ dùng trong fixture kiểm thử.

Không commit/push.
