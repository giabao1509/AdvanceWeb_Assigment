# Kế hoạch và trạng thái Block 7

Phạm vi hiện tại: **hai luồng Baseline / Saga**, giữ nghiệp vụ đặt hàng và thanh toán thủ công. Không còn lựa chọn hay policy V1/V2/V3.

## Thiết kế

- TypeScript strict, Express, SQLite; UI HTML/CSS/TypeScript thuần. Không thêm broker hoặc thư viện workflow.
- Ba service có HTTP/process/DB riêng: Order, Inventory, Payment. UI chạy trong launcher, độc lập với Order.
- Dùng chung ba file `data/{order,inventory,payment}.sqlite`. `orders.mode` cố định cơ chế từng đơn; nút mode chỉ áp dụng cho đơn mới. Migration giữ nguồn cũ, cộng tồn/số dư và nhập lịch sử đúng một lần. Cột version chỉ giữ tương thích lịch sử/idempotency.
- Baseline chạy tuần tự, không tự bù hoặc phục hồi lỗi. Saga dùng đối soát, bù và restart recovery.

## Luồng thủ công

Chọn hàng → tạo đơn → reserve → chờ khách thanh toán → chọn ví → charge → confirm. Có thể hủy trước thanh toán để trả hàng; worker không tự charge đơn đang chờ khách. Payment kiểm tra số dư và lưu debit/credit cùng operation result trong transaction local.

## Retry có giới hạn

- Mỗi bước: 1 lần xử lý đầu và tối đa `SAGA_MAX_RETRIES=3` lần thử lại; cấu hình 0 là chỉ gọi lần đầu.
- Bộ đếm/giới hạn lưu trong Saga. Bước mới có bộ đếm mới; giữ nguyên qua restart.
- Hết lượt: bước bù giữ `COMPENSATING`, F4 chưa rõ giữ `RECOVERING`, bước tiến khác `REQUIRES_REVIEW`; Saga `retry_exhausted=1`, `resume_blocked=1`. Giữ step, decision, pending và operation IDs.
- Không báo hủy, giải phóng hàng hoặc hoàn tiền trước khi các bước đó thành công.
- Sau khắc phục lỗi, người vận hành tiếp tục cùng Saga để cấp lượt mới. Resume khi đang chạy không reset bộ đếm; UI chờ dependency khởi động xong.

F4: launcher hẹn giờ khởi động lại Payment; Order giữ `RECOVERING`, chờ phiên Payment mới để cấp một đợt query có giới hạn. `charge_uncertain`, `last_payment_instance` lưu bền vững; không tạo charge mới khi outcome chưa rõ. UI có thời gian dừng và đếm thời gian phục hồi.

## Hoàn tất local

- Gộp UI và backend còn hai mode; giữ Thủ công / Tự động.
- Thêm migration retry fields, worker có giới hạn và trạng thái cần kiểm tra.
- UI hiển thị bộ đếm, trạng thái dừng, service health và nút tiếp tục.
- 48 backend tests PASS: 17 nghiệp vụ, 9 thủ công, 6 retry, 4 quan sát kho/log, 3 dữ liệu chung/migration, 7 F4, 2 checkpoint V3. Browser thủ công/mobile và F4/F5/F6 recovery PASS; TypeScript strict PASS.
- README, DEMO và report Markdown/HTML cập nhật cho thiết kế hiện tại.

## Kiểm tra lại

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:manual
npm.cmd run test:retry
npm.cmd run test:ui:manual
npm.cmd run test:ui:recovery
```

Các kiểm tra dùng fixture riêng. Không reset DB live. Bộ matrix/video tổng thể cũ chưa tái tạo; V3 F5/F6 đã có bộ riêng tại `evidence/latest-v3.json`, đủ ba checkpoint JSON/ảnh; chưa có hosted CI hoặc acceptance trên máy khác. Không commit/push.
