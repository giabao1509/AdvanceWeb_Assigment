# Evidence V3 — F5 và F6

Mỗi case có ba JSON và ba ảnh Backend: trước dừng, ngay sau restart, sau hội tụ. Ảnh released-inventory cho thấy nhả hàng trong tab Kho hàng.

F5 giữ COMPENSATING và pending refund → release → cancel sau hết budget; script restart rồi gỡ lỗi và tiếp tục. Fixture dùng 1 retry để chụp gọn.

F6 dừng Order sau refund commit, trước khi lưu kết quả. Sau restart, query refund ID cũ rồi release/cancel. Có đúng một refund và một release.

Checkpoint sau restart được giữ bằng IPC chỉ trong script kiểm thử; app chạy bình thường tự bật worker. Dữ liệu/port là fixture riêng. manifest.json ghi SHA-256 của artifacts và source hiện tại. Đây là evidence V3 có phạm vi riêng, không thay bộ matrix/video tổng thể cũ.
