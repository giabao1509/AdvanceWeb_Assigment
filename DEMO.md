# Kịch bản demo và cách đọc DB

Mở **http://127.0.0.1:3000**. Giao diện mặc định dùng **Thủ công**: chọn sản phẩm → tạo đơn → chọn ví → thanh toán hoặc hủy. Tab **Backend** dành cho response, trạng thái service và các tình huống gây lỗi.

Thanh **Thiết lập chung** đầu trang là nơi duy nhất chọn Baseline/Saga, Thủ công/Chạy lab và tình huống. Khi chọn Chạy lab, ô H0–F6 xuất hiện ngay tại đây; không cần đổi tab để thiết lập.

Tab **Kho hàng** hiện **Tồn kho** lấy trực tiếp từ `stock.available` và toàn bộ lịch sử giữ–trả của cả hai cơ chế, mới nhất ở trên. Tạo đơn rồi mở kho để thấy tồn giảm; hủy trước thanh toán rồi mở lại để thấy dòng trả hàng và tồn tăng. Xác nhận đơn không trừ kho thêm lần nữa. Lịch sử thanh toán trong Backend tổng hợp mọi đơn Baseline/Saga, không đổi theo đơn đang xem log. Muốn đối chiếu một đơn, dùng mã sao chép từ phần chi tiết đơn và lệnh đọc DB bên dưới.

Đây là ví nội bộ của lab, không kết nối cổng thanh toán bên ngoài. HTTP giữa các service, giữ hàng, trừ số dư và ghi SQLite đều chạy thật. Giá tiền lấy từ server.

## 1. Nên so sánh điều gì?

| Lựa chọn | Điểm cần quan sát |
|---|---|
| Baseline | Khi thanh toán thất bại, hàng đã giữ vẫn còn `HELD`; không tự bù. |
| Saga | Lỗi rõ ràng thì bù; kết quả chưa rõ thì đối soát bằng ID cũ. Retry có giới hạn, phục hồi được sau restart. |

Luồng thành công giống nhau ở cả hai lựa chọn. Muốn thấy khác biệt phải xem cả lỗi, hàng đang giữ và lịch sử thanh toán.

**Thủ công** dùng tồn kho và số dư thực tế, không áp preset F1–F6. **Chạy lab** thực hiện cả chuỗi sau một lần đặt hàng; dùng nó cho các thí nghiệm crash/recovery.

## 2. Mở đúng DB

| Chế độ | Order | Inventory | Payment |
|---|---|---|---|
| Baseline và Saga | `data/order.sqlite` | `data/inventory.sqlite` | `data/payment.sqlite` |

Chỉ còn **Baseline và Saga**, dùng chung kho, ví, đơn và lịch sử. Nút mode chỉ chọn cơ chế cho đơn mới; `orders.mode` ghi cơ chế cố định của đơn. Cột `orders.version` giữ metadata cũ cho idempotency. DB mới seed một Ví chính 10.000.000đ và một Ví phụ 100.000đ. Khi chuyển từ hai bộ DB cũ, app cộng tồn/số dư hiện có và giữ mọi lịch sử, nên dữ liệu gộp có thể lớn hơn seed; các file nguồn được giữ nguyên.

Đơn cũ trước khi bổ sung ví có `wallet_id = NULL`; không suy diễn rằng chúng từng trừ tiền từ ví mới. Dùng đơn mới để trình bày luồng thanh toán.

### Đọc nhanh khi app đang chạy

```powershell
# Đọc đơn mới nhất và dữ liệu liên quan ở cả ba service
npm.cmd run db:inspect -- saga
npm.cmd run db:inspect -- baseline

# Nút sao chép mã đơn trong UI cung cấp ID đầy đủ
$orderId = 'DAN_MA_DON_DAY_DU_VAO_DAY'
npm.cmd run db:inspect -- saga $orderId
```

Lệnh hiển thị đường dẫn DB chung, order, Saga history, reservation, movements, wallets, payment và ledger của đúng đơn. `stock` và `wallets` là trạng thái chung. Không truyền mode sẽ đọc đơn mới nhất trong toàn hệ thống; truyền `baseline` hoặc `saga` chỉ lọc đơn, không chọn DB khác.

### Mở bằng DB Browser / SQLite viewer

```powershell
npm.cmd run db:export -- saga
npm.cmd run db:export -- baseline
```

Mở ba file tại **đường dẫn được lệnh in ra**, dưới `.local/db-snapshots/`. Đây là snapshot độc lập, đã gồm dữ liệu WAL, thuận tiện để xem mà không cần dừng app. Xuất lại để thấy thay đổi mới; sửa snapshot không thay đổi app.

Ba file được chụp lần lượt, không phải một transaction chung. Để đối chiếu kết quả cuối, đợi đơn ổn định rồi xuất.

Nếu mở DB live, viewer phải hỗ trợ WAL và refresh dữ liệu. Không chỉ copy mỗi file `.sqlite` khi app đang chạy; dữ liệu mới có thể nằm trong `-wal`. Không xóa `-wal`/`-shm`. Một lựa chọn khác là dừng app sạch bằng Ctrl+C rồi mở lại đúng file.

## 3. Demo đặt hàng và thanh toán thủ công

### A. Tạo đơn trước, thanh toán sau

1. Chọn **Saga → Thủ công**. Chọn đèn `LAMP-01`, số lượng 1, bấm **Tạo đơn hàng**.
2. Đợi **Chờ thanh toán**, sao chép mã đơn. Chưa bấm thanh toán; đọc DB lần một.
3. Chọn **Ví chính**, bấm **Thanh toán**. Đợi **Đã xác nhận**; đọc DB lần hai.

| Nơi xem | Trước thanh toán | Sau thanh toán |
|---|---|---|
| Order | `AWAITING_PAYMENT / AWAIT_PAYMENT`, chưa có `payment_id` | `CONFIRMED / DONE`, có `wallet_id`, `payment_id` |
| Inventory | Reservation `HELD`, có movement `RESERVE` | Vẫn `HELD`: hàng đã dành cho đơn thành công |
| Payment | Không có payment/charge của đơn; ví chưa bị trừ | Payment `CHARGED`, một ledger `CHARGE`; ví giảm đúng tổng tiền |

Đèn giá 450.000đ; nếu chưa từng dùng ví chính, số dư sau thanh toán là 9.550.000đ. Reload trang khi đang chờ thanh toán vẫn xem và thanh toán được đơn. Gửi lại thanh toán cùng ví không tạo charge thứ hai.

### B. Hủy khi chưa thanh toán

Tạo đơn thủ công mới rồi bấm **Hủy đơn**. Kết quả: Order `CANCELLED`, `failure_reason = USER_CANCELLED`; Inventory `RELEASED`, có `RESERVE` và `RELEASE`; không có charge hoặc trừ ví.

Baseline cũng hỗ trợ thao tác hủy chủ động này. Điểm khác biệt của Saga là **tự bù khi các bước thất bại**. Lab chưa có thời hạn tự giải phóng đơn chờ thanh toán; hãy hủy các đơn không dùng nữa.

### C. Thiếu số dư thật: Baseline so với Saga

1. Chọn **Baseline → Thủ công**, đặt đèn 450.000đ, thanh toán bằng **Ví phụ** 100.000đ.
2. Order kết thúc `FAILED`; Inventory vẫn `HELD`, chỉ có `RESERVE`. Payment trả `402 / INSUFFICIENT_FUNDS`, không có payment/charge, số dư không đổi.
3. Chọn **Saga → Thủ công**, lặp lại với đơn mới.
4. Order `CANCELLED`; Inventory `RELEASED`, có thêm `RELEASE`; vẫn không có charge và số dư không đổi.

Không cần chọn preset F2: Payment quyết định từ số dư trong DB chung. Baseline để lại một sản phẩm bị giữ; đơn Saga kế tiếp chỉ giải phóng phần đã giữ của chính nó. Xem movement theo mã đơn để phân biệt hai luồng. Muốn so sánh từ cùng điều kiện ban đầu, dừng app và reset trước mỗi case. Lỗi thiếu tiền kết thúc bằng bù/hủy, không retry trừ tiền liên tục.

## 4. Demo đối soát, giới hạn retry và restart

Với các tình huống dưới đây, chọn **Chạy lab** và case tương ứng tại **Thiết lập chung**, rồi bấm **Chạy lab** trong phần đặt hàng. Tab Backend dùng để quan sát và khôi phục service. Cần `ENABLE_FAULTS=true` và chạy bằng `npm.cmd run dev` để launcher điều khiển các process.

### D. Payment đã charge nhưng mất response (F4)

1. Chọn **Saga → Chạy lab → F4**. Chọn thời gian Payment dừng (mặc định 4 giây), rồi tạo đơn.
2. Launcher dừng Payment tại marker sau commit, trước response. Order hiển thị đang đối soát; Payment unavailable.
3. Dùng `db:inspect` ngay lúc này: Payment DB đã có `CHARGE` và số dư đã giảm, dù Order chưa nhận được kết quả.
4. UI đếm thời gian tự khởi động lại Payment. Khi hết lượt đối soát, đơn vẫn `RECOVERING`, hiển thị **Chờ Payment phục hồi** và dừng gọi operation liên tục.
5. Payment trở lại với cùng DB. Order tự phát hiện phiên mới, query charge ID cũ rồi chuyển `CONFIRMED`, không cần bấm tiếp tục.

Kết quả cần chỉ ra: **một charge, một lần trừ ví**, không thanh toán lại bằng ID mới. HTTP trace có request query operation. Baseline không tự giải quyết kết quả chưa rõ.

Muốn thấy hai nhánh: chọn thời gian dừng ngắn để phục hồi trong budget; tăng thời gian để thấy `PAYMENT_RECOVERY_WAIT` rồi `PAYMENT_RECOVERY_DETECTED`. Mỗi phiên Payment mới chỉ mở một đợt đối soát có giới hạn. Khôi phục thủ công sớm sẽ hủy timer cũ. Nếu khởi động thất bại, UI giữ thông báo lỗi và cho khôi phục service thủ công. F4 minh họa đối soát/phục hồi để tiếp tục, không minh họa refund/release.

### E. Refund lỗi — retry có giới hạn (F5)

1. Chọn **Saga**, tình huống **F5**, tạo đơn tự động.
2. Confirm bị từ chối, refund đang bị chặn. Order ở `COMPENSATING`; Payment vẫn `CHARGED`, ví đã bị trừ; reservation vẫn `HELD`.
3. Mặc định refund có **1 lần gọi đầu + 3 lần thử lại**. Sau 4 kết quả lỗi, Order vẫn `COMPENSATING / REFUND_PENDING`; UI hiện **Đang bù · hết lượt thử, chờ khắc phục**, bộ đếm **3 / 3**. Saga có `retry_exhausted=1`, `resume_blocked=1`.
4. Pending vẫn là `refund → release → cancel`. Chưa refund xong thì chưa nhả hàng/hủy cuối cùng. Restart Order lúc này không làm mới giới hạn.
5. Bấm **Gỡ lỗi refund và tiếp tục**. Thao tác này khắc phục lỗi và cấp lại lượt xử lý cho cùng bước, cùng operation ID.

Cuối cùng: Order `CANCELLED`, reservation `RELEASED`, Payment `REFUNDED`. Ledger giữ **cả CHARGE lẫn REFUND**, ví được cộng lại đúng một lần. `SAGA_MAX_RETRIES=3` trong `.env` cấu hình giới hạn; `0` chỉ cho lần gọi đầu. `attempts` là tổng số lượt lỗi, còn `retry_count` là số lần thử lại của bước hiện tại. Bước mới có bộ đếm mới; bấm tiếp tục khi đang chạy không reset bộ đếm.

### F. Order chết sau refund commit, trước khi lưu kết quả (F6)

1. Chọn **Saga → Chạy lab → F6**, tạo đơn. Confirm bị từ chối nên Saga chuyển sang hoàn tiền.
2. Payment đã refund và cộng ví. Launcher kill Order trước khi Order lưu kết quả refund: intent còn `REFUND_PENDING`, decision `COMPENSATE`, kho vẫn `HELD`.
3. Trong Backend, Payment là `REFUNDED`, ledger có CHARGE và REFUND. Marker ghi checkpoint trước khi Order dừng; đây là dữ liệu đã lưu, không phải phản hồi live từ Order.
4. Bấm **Khôi phục Order**. Order query refund operation ID cũ, thấy đã thành công rồi release và cancel.
5. Kết quả cuối: Order `CANCELLED`, một REFUND, một RELEASE; ví chỉ được cộng một lần, kho chỉ tăng lại một lần. Trace refund gốc `complete=0` được giữ để thấy khoảng hở.

`npm.cmd run evidence:v3` chụp trước dừng, ngay sau restart và sau hội tụ cho cả F5/F6. Script giữ worker tại checkpoint IPC sau khi đọc DB, chụp xong mới cho tiếp tục; app chạy bình thường tự resume. Mỗi mốc có JSON và ảnh Backend; ảnh Kho hàng cuối cho thấy release.

## 5. SQL để đối chiếu trong viewer

Thay `THAY_BANG_ORDER_ID` bằng mã đầy đủ. Mỗi nhóm chạy trong DB được ghi rõ; không chạy tất cả vào một file.

### `order.sqlite`

```sql
SELECT id, mode, version, checkout_mode, status, step, total
FROM orders ORDER BY rowid DESC LIMIT 20;

SELECT id, mode, version, checkout_mode, status, step, total, wallet_id,
       reservation_id, payment_id, failure_reason, last_error
FROM orders WHERE id = 'THAY_BANG_ORDER_ID';

SELECT order_id, decision, operations, attempts, retry_count, retry_limit,
       retry_exhausted, resume_blocked, last_error
FROM sagas WHERE order_id = 'THAY_BANG_ORDER_ID';

SELECT event, status, step, phase, intent, pending, error, created_at
FROM saga_events WHERE order_id = 'THAY_BANG_ORDER_ID' ORDER BY rowid;

SELECT action, http_status, transport_error, operation_id, complete
FROM http_traces WHERE order_id = 'THAY_BANG_ORDER_ID' ORDER BY rowid;
```

`sagas` giữ bước/decision cần tiếp tục; `saga_events` là lịch sử chuyển trạng thái. Baseline không có Saga record. `complete = 0` ở trace F6 chỉ nói Order chưa lưu được kết quả, không chứng minh Payment chưa refund.

### `inventory.sqlite`

```sql
SELECT * FROM stock;
SELECT * FROM reservations WHERE order_id = 'THAY_BANG_ORDER_ID';
SELECT kind, quantity, delta, available_after, operation_id, source, created_at
FROM movements WHERE order_id = 'THAY_BANG_ORDER_ID' ORDER BY rowid;
```

`RESERVE` giảm khả dụng; `RELEASE` cộng lại. `HELD` ở đơn thành công là bình thường. `HELD` ở đơn đã thất bại do thiếu tiền là phần tồn đọng của Baseline. Movement nhập từ operation cũ có thể không có `available_after`.

### `payment.sqlite`

```sql
SELECT id, name, balance FROM wallets;
SELECT * FROM payments WHERE order_id = 'THAY_BANG_ORDER_ID';

SELECT l.kind, l.amount, l.payment_id, l.operation_id, l.created_at
FROM ledger_entries l JOIN payments p ON p.id = l.payment_id
WHERE p.order_id = 'THAY_BANG_ORDER_ID' ORDER BY l.rowid;

SELECT id, action, status, http_status, result
FROM operations WHERE order_id = 'THAY_BANG_ORDER_ID' ORDER BY rowid;
```

Thiếu tiền có operation `FAILED / 402` nhưng không có payment hay ledger: yêu cầu bị từ chối trước khi trừ ví. Refund thêm ledger mới, không xóa charge cũ. Số dư ví là tổng hiện tại, nên dùng ledger theo mã đơn để giải thích một giao dịch cụ thể.

## 6. Đọc response trong tab Backend

- `202`: đã tiếp nhận tạo đơn/thanh toán, xem trạng thái tiếp theo; chưa có nghĩa đã thành công.
- Reserve `201`: đã giữ hàng. Charge `201`: đã ghi thanh toán. HTTP `200` khi query operation cần đọc tiếp `status`, `httpStatus`, `result` bên trong.
- `402 / INSUFFICIENT_FUNDS`: từ chối rõ ràng vì thiếu số dư; có thể chuyển sang bù.
- `409`: đọc mã lỗi, có thể là hết hàng hoặc yêu cầu không hợp lệ với trạng thái hiện tại.
- Refund `503`: lỗi tạm thời, việc bù còn pending.
- `TIMEOUT`, `NETWORK_ERROR`, trace `PENDING`: chưa biết kết quả từ phía gọi; đối chiếu participant DB hoặc query operation, không kết luận ngay là chưa trừ tiền.

Nhật ký mới dùng câu dễ đọc, chẳng hạn “Đã tìm thấy khoản thu trước đó”, “Đã hoàn tiền”, “Order đã khởi động lại, bắt đầu phục hồi đơn”. Bấm một dòng để xem HTTP request/response hoặc JSON của sự kiện nội bộ. Có thể lọc loại log. Mới nhất ở trên; cuộn xuống để nạp log cũ, polling không kéo bạn khỏi dòng đang đọc. Bấm **Về mới nhất** để về đầu danh sách.

F4/F5/F6 hồi phục vẫn có HTTP thật: query operation, refund hoặc release. Các lệnh khôi phục service/gỡ lỗi/resume nay cũng hiện trong nhật ký. Confirm/cancel không có HTTP riêng vì chạy local. Với F6, dòng refund cũ hiện “Chưa lưu được phản hồi”, kèm nút **Xem lượt đối soát** khi đã tìm được kết quả về sau. Không coi dòng gốc chưa có response là operation vẫn chạy mãi.

Khi trình bày trong 10–12 phút: **A → C → D → E → F**. Giữ mã đơn của từng case để mở lại. Không reset DB giữa lúc đang demo recovery. Các kiểm tra mới chạy trên fixture riêng; bộ evidence cũ chưa được tái tạo cho luồng thủ công.
