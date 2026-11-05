# Block 7 — Checkout Baseline / Saga

Mini lab TypeScript với ba service chạy riêng: **Order, Inventory, Payment**. Baseline dừng khi gặp lỗi; Saga đối soát hoặc bù để xử lý công việc còn dở. Hai cơ chế dùng chung kho, ví và lịch sử, chỉ khác cách xử lý từng đơn.

Payment mô phỏng nghiệp vụ bằng SQLite, không thu tiền qua ngân hàng. Các lệnh reserve, charge, refund, release đều gọi HTTP và ghi DB thật.

Thanh **Thiết lập chung** ở đầu trang gom Baseline/Saga, **Thủ công / Chạy lab** và tình huống H0–F6. Dùng được từ cả ba tab; không cần sang Backend để chọn case. Cách chạy/tình huống chỉ áp dụng cho đơn mới, tạm khóa khi đang gửi yêu cầu.

UI mặc định dùng **Thủ công**: chọn sản phẩm → tạo đơn giữ hàng → chọn ví → thanh toán hoặc hủy. Ví chính seed 10.000.000đ, Ví phụ 100.000đ dùng chung cho cả hai cơ chế; số dư được lưu và trừ/hoàn tại Payment. Chọn **Chạy lab** rồi chọn tình huống ở thanh chung để hệ thống tự xử lý chuỗi đặt hàng.

Xem [DEMO.md](DEMO.md) để có kịch bản so sánh hai luồng và SQL đọc DB. `npm.cmd run db:inspect -- saga` đọc đơn mới nhất; thêm mã đơn để lọc. `npm.cmd run db:export -- saga` xuất ba SQLite snapshot gồm WAL để mở bằng viewer. Thay `saga` bằng `baseline` khi cần.

## 1. Cài đặt và chạy

Node.js **22.17.1+**, npm. Không cần Docker, Redis hay DB server. Cần Internet để cài dependencies lần đầu.

### Chạy nhanh trên Windows

Sau khi clone repo hoặc giải nén ZIP, mở thư mục dự án rồi chạy **start.bat** bằng cách nhấp đúp hoặc gõ trong PowerShell:

```powershell
.\start.bat
```

File này kiểm tra Node.js/npm, tạo `.env` từ `.env.example` nếu chưa có, cài dependencies bằng `npm.cmd ci` nếu chưa cài, rồi chạy UI và cả ba service. Cấu hình và dữ liệu hiện có được giữ nguyên. Sau khi cập nhật source có thay đổi dependencies, chạy lại `npm.cmd ci` trước khi mở app.

### Cài đặt và chạy bằng lệnh

```powershell
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run dev
```

Mở **http://127.0.0.1:3000**. Dừng phiên app cũ trước khi chạy phiên mới. `Ctrl+C` dừng launcher và các child service, giữ dữ liệu.

Nếu gặp `EADDRINUSE`, một phiên khác đang chiếm cổng. Dừng phiên cũ trong terminal của nó rồi chạy lại; không mở đồng thời `start.bat` và `npm.cmd run dev`. Với Windows, nếu hiện câu hỏi `Terminate batch job (Y/N)?` sau Ctrl+C, chọn `Y`.

| Thành phần | Port mặc định | Chức năng |
| --- | --- | --- |
| UI/launcher | `3000` | Phục vụ UI, chuyển tiếp HTTP tới từng service, điều khiển child process |
| Order | `3003` | Đơn hàng, Saga record, worker/resume |
| Inventory | `3001` | Tồn kho, reservation, movements |
| Payment | `3002` | Charge, refund, operations, ledger |

UI nằm trong process launcher và không có DB nghiệp vụ riêng. Dừng Order không làm UI hoặc hai participant chết theo. UI chỉ đọc dữ liệu nghiệp vụ qua HTTP, không mở DB của service khác.

Nếu npm trên Windows báo `UNABLE_TO_VERIFY_LEAF_SIGNATURE`:

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
npm.cmd ci
```

Không tắt TLS verification. `node:sqlite` còn phát cảnh báo experimental trên Node 22.17.1; cảnh báo này không phải lỗi khởi động.

### Chạy từng thành phần

Mở bốn terminal trong repo, chạy lần lượt:

```powershell
npm.cmd run start:inventory
npm.cmd run start:payment
npm.cmd run start:order
npm.cmd run start:ui
```

Các script tự đọc `.env`. Khi chạy thủ công, UI vẫn xem được dữ liệu nhưng không quản lý PID của các service ngoài launcher; nút kill/restore được tắt. Dùng `npm run dev` để demo F4/F6 trực tiếp trên UI với marker tự động.

### `.env`

`UI_PORT=3000`, `ORDER_PORT=3003`, `INVENTORY_PORT=3001`, `PAYMENT_PORT=3002`. Đổi port participant thì đổi luôn `INVENTORY_URL`/`PAYMENT_URL` tương ứng. `DATA_DIR=./data`, `LOG_DIR=./logs`, `HTTP_TIMEOUT_MS=2000`, `RECOVERY_INTERVAL_MS=1000`.

`ENABLE_FAULTS=true` bật các tình huống và điều khiển process của lab. Tất cả bind loopback. Không có `.env` thì fault hooks mặc định tắt.

`SAGA_MAX_RETRIES=3`: mỗi bước có 1 lần gọi đầu và tối đa 3 lần thử lại, cách nhau khoảng `RECOVERY_INTERVAL_MS`. `0` nghĩa là không thử lại sau lần đầu. Giới hạn lưu theo Saga; thay `.env` rồi restart áp dụng cho đơn mới hoặc lần tiếp tục chủ động tiếp theo.

## 2. Hai luồng xử lý

| Lựa chọn | Khả năng | Tình huống trên UI |
| --- | --- | --- |
| Baseline | Tuần tự, không tự bù/reconcile/resume | H0 và các lỗi để đối chứng |
| Saga | Tự bù, query kết quả bằng ID cũ, retry có giới hạn và phục hồi sau restart | H0, F1–F6 |

Hết lượt retry khi đang bù, đơn giữ `COMPENSATING` và dừng gọi tự động; UI báo hết lượt, chờ khắc phục. Với bước tiến thông thường, hết lượt chuyển `REQUIRES_REVIEW`. Cả hai đều giữ bước đang chờ, operation ID và decision. Không tự kết luận đã hoàn tiền/hủy. Restart giữ bộ đếm và trạng thái dừng. Khắc phục lỗi rồi bấm **Tiếp tục Saga** để cấp lại tối đa 3 retry cho bước đó; bấm khi đang chạy không reset giới hạn. Lỗi nghiệp vụ rõ ràng như thiếu số dư chuyển sang bù, không retry trừ tiền.

**Riêng F4 khi charge chưa rõ:** hết lượt đối soát vẫn giữ `RECOVERING`, ngừng gọi operation liên tục. Launcher tự khởi động lại Payment sau thời gian chọn trên UI (0–60 giây, mặc định `F4_DOWNTIME_MS=4000`). Order kiểm tra health và nhận diện phiên Payment mới bằng `instanceId`; mỗi phiên mới chỉ cấp một đợt đối soát có giới hạn. Query đúng charge ID đã lưu, thấy `CHARGED` thì tự confirm. Không cần bấm tiếp tục; nếu query trả `NOT_FOUND` sau charge chưa rõ, giữ chờ và không gửi charge khác. Health chỉ xác nhận service truy cập được, không xác nhận khoản thu.

## 3. Cách demo trên UI

Tab **Đặt hàng**: chọn Baseline hoặc Saga, sản phẩm và số lượng. Giá được tính ở server. Khi gửi lại do mất response, giữ cùng create operation ID; **Tạo đơn mới** mới sinh ID khác.

Tab **Kho hàng**: mỗi sản phẩm hiện một số **Tồn kho**, lấy trực tiếp từ `stock.available` trong DB. Giữ chỗ làm số này giảm; nhả hàng cộng lại; xác nhận đơn không trừ thêm lần nữa. Lịch sử chỉ hiển thị thời gian, sản phẩm, hoạt động và tồn sau thao tác; lọc theo sản phẩm hoặc hoạt động, mới nhất ở trên. Dữ liệu đọc trực tiếp từ Inventory ngay cả khi Order dừng. Reservation của đơn thành công vẫn là `HELD` vì lab chưa có bước giao hàng.

Tab **Phản hồi backend**: xem trạng thái service và nhật ký của đơn được chọn. **Dừng service** có màu đỏ, **Khôi phục service** có màu xanh. Trạng thái có nhãn và màu để phân biệt đang xử lý, đối soát, bù, hoàn tất hoặc lỗi. Phần **Tiến trình Saga** cho biết bước đang chạy, việc còn chờ và số lượt retry.

Log mới nhất ở trên; cuộn xuống để xem thêm log cũ, mỗi đợt 40 dòng. Khi đang đọc, giao diện giữ vị trí thay vì nhảy về đầu. Bấm một dòng để mở request/response hoặc sự kiện gốc; có bộ lọc HTTP/nội bộ/service. Lịch sử thanh toán bên dưới gồm mọi khoản thu/hoàn của cả hai cơ chế, không đổi theo đơn đang xem.

Nhật ký gộp HTTP Order → participant, các lệnh UI → backend (gỡ lỗi refund, resume…), sự kiện worker/Saga và vòng đời service. Worker vẫn gọi HTTP khi đối soát hoặc retry. Confirm/cancel là local transaction, nên chỉ có sự kiện nội bộ. F6 giữ trace refund gốc chưa lưu response và liên kết sang lượt query đã đối soát; không sửa dấu vết cũ thành thành công. Launcher đọc lại log khi restart; HTTP traces và Saga history lưu bền vững trong Order DB. Mini lab đọc toàn bộ lịch sử từ API, không chặn ở 200 bản ghi; riêng danh sách log được nạp dần vào giao diện.

| Case | Thao tác | Điều cần quan sát |
| --- | --- | --- |
| H0 | Chọn luồng thành công | `CONFIRMED / HELD / CHARGED`, một charge |
| F1 | Reserve bị từ chối | Saga cancelled; không gọi charge, không có reservation |
| F2 | Payment từ chối sau reserve | Saga release rồi cancel; Baseline còn held |
| F3 | Confirm reject sau charge | Refund trước release; Saga cancelled; ledger giữ charge + refund |
| F4 | Saga, Chạy lab | Payment bị kill sau commit rồi tự khởi động lại. Saga giữ `RECOVERING`, tự query ID cũ và confirm; chỉ một khoản thu |
| F5 | Saga, Chạy lab | Refund lỗi, retry tới giới hạn rồi dừng chờ xử lý. Pending còn `refund → release → cancel`. Bấm Gỡ lỗi refund và tiếp tục |
| F6 | Saga, Chạy lab | Order bị kill sau refund commit, trước khi lưu kết quả. Khôi phục Order để query refund ID cũ, rồi release/cancel; không hoàn tiền hai lần |

Không dùng reset để thay cho restart/resume. F4/F6 kill process thật. Nút service chỉ điều khiển child process do launcher này tạo, không nhận PID tùy ý.

```powershell
# Điều khiển qua UI launcher đang chạy:
npm.cmd run service -- payment stop
npm.cmd run service -- payment start
npm.cmd run resume -- <saga_id>
```

`saga_id = order_id` là ánh xạ 1:1 của lab. Tên ID, phase, intent và pending trả từ Order API; UI không tự suy ra kết quả nghiệp vụ.

## 4. DB và dữ liệu cũ

Chỉ dùng ba file: `data/order.sqlite`, `data/inventory.sqlite`, `data/payment.sqlite`. Baseline và Saga dùng chung đơn, kho, ví và lịch sử. Mỗi service chỉ mở file của mình. Nút Baseline/Saga chọn cơ chế cho đơn mới; cột `orders.mode` giữ cơ chế của đơn cũ, kể cả khi thao tác qua URL mode khác. Cột `orders.version` chỉ giữ metadata lịch sử.

App tự chuyển từ sáu DB cũ khi chưa có DB chung: giữ nguyên file nguồn, ID, lịch sử và operation IDs; cộng tồn/số dư hiện có từ hai bộ dữ liệu. Vì hai bộ từng có vốn/tồn ban đầu riêng, dữ liệu gộp có thể lớn hơn seed mới. `data/migration-*.json` ghi nguồn đã nhập; restart không nhập lặp. Dòng kho chuyển từ DB cũ được ghi nguồn để phân biệt tồn lịch sử trước khi gộp. Nên sao lưu và dừng service trước khi chuyển lần đầu. `db:reset` chỉ chạy khi đã dừng app; reset cả DB chung và dữ liệu mode cũ để lần sau seed sạch.

Schema migration giữ đơn, stock, reservation, ví và ledger cũ. Movement nhập từ durable operation cũ có `source=IMPORTED_OPERATION`, `available_after=null`; không dựng số dư hay lịch sử không có bằng chứng.

SQLite dùng WAL. Nếu viewer chỉ đọc/copy file chính, dữ liệu mới có thể chưa hiện; giữ các file `-wal`/`-shm` đi kèm và dùng reader hỗ trợ WAL. Launcher shutdown qua IPC để đóng DB. Không xóa WAL/SHM khi app chạy.

## 5. Contract API và ánh xạ học liệu

Mọi API có prefix `/api/:mode`, mode là `baseline|saga`. Mode chọn cơ chế khi tạo đơn, không chọn DB; các URL đọc trả cùng dữ liệu. UI chuyển tiếp `/api/:mode/inventory/...` tới Inventory và `/api/:mode/payments/...` tới Payment độc lập với Order.

| Contract học liệu | Endpoint tại service | Ánh xạ |
| --- | --- | --- |
| Create/read/list order | `POST /orders`, `GET /orders/:id`, `GET /orders` | `Idempotency-Key` hoặc `create_op_id`; body SKU, quantity, checkout_mode, scenario; response có order_id, saga_id |
| Read Saga | `GET /orders/:id/saga`, `GET /sagas/:id` | phase, intent, pending, history, operations, localOperations |
| Resume Saga | `POST /sagas/:id/resume` | Cấp lại lượt thử nếu đang dừng; dùng record và operation IDs cũ |
| Reserve/release | Inventory: `POST /reservations`, `POST /reservations/:id/release` | `operationId` tương ứng reserve_op_id/release_op_id |
| Charge/refund | Payment: `POST /payments`, `POST /payments/:id/refund` | Payment ID là charge ID; refund liên kết cùng payment, có operation ID riêng |
| Query operation | Participant: `GET /operations/:operationId` | status, httpStatus, result bền vững; encode operation ID chứa dấu `/` |
| Items/movements | Inventory: `GET /items`, `GET /movements?orderId=...` | Tồn kho và lịch sử giữ/nhả hàng |
| Ledger | Payment: `GET /ledger?orderId=...` | Bản ghi charge/refund gốc |
| Health | `GET /health` từng service; UI `GET /lab/health` | Health và PID riêng; unavailable không có nghĩa không charge |

Confirm/cancel là handler local, có stable operation IDs và kết quả trong Order DB. Mỗi transition cùng Saga event được persist trong local transaction. Một command participant ghi side effect và kết quả operation atomically; không giữ SQLite transaction khi chờ HTTP.

Kiểu dữ liệu operation khai báo `PENDING|SUCCEEDED|FAILED`, nhưng handler hiện chỉ ghi kết quả `SUCCEEDED` hoặc `FAILED` cùng transaction nghiệp vụ; chưa có luồng ghi `PENDING`. `FAILED` là từ chối dứt khoát đã lưu. Timeout hay refund `503` không được xem là terminal FAILED.

`202` tạo đơn/resume nghĩa là đã tiếp nhận, chưa phải hoàn tất. Query operation `200` phải đọc tiếp `status`, `httpStatus`, `result`. `404` chỉ là chưa thấy operation, retry vẫn dùng ID cũ. `TIMEOUT`/`NETWORK_ERROR` là transport error, không chứng minh payment thất bại. `409` cần đọc `error` để phân biệt hết hàng/idempotency conflict.

## 6. Kiểm chứng và evidence

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:manual
npm.cmd run test:retry
npm.cmd run test:f4
npm.cmd run test:v3
npm.cmd run test:observability
npm.cmd run test:shared
npm.cmd run test:ui:shared
npm.cmd run test:ui:manual
npm.cmd run test:ui:recovery
npm.cmd run test:ui:stock
npm.cmd run test:ui:state
npm.cmd run test:ui:history
npm.cmd run test:ui
npm.cmd run demo:kill-payment
npm.cmd run demo:restart-order
npm.cmd run evidence
npm.cmd run evidence:v3
```

HTTP tests dùng DB riêng, kiểm tra ba service, thứ tự bù, idempotency, giá server, migration và F6. Retry tests kiểm tra giới hạn 0/3, restart và resume không cộng/trừ tiền trùng. UI tests kiểm tra thanh toán, hủy, kho, dừng/khôi phục, F4–F6, cuộn log và mobile. `test:ui:state` kiểm tra giữ hàng → xác nhận không trừ kho thêm → hủy đơn khác để nhả hàng.

`evidence` tạo thư mục timestamp mới, test output, matrix theo mode, F4/F6 traces, video, screenshots và manifest SHA-256. `evidence/latest-run.json` hiện vẫn trỏ lượt trước khi gộp mode/giới hạn retry; chưa tái tạo bộ evidence. Demo/test có DB và port riêng, không kill/reset app đang dùng. `evidence:v3` tạo riêng bộ V3 F5/F6 với ba checkpoint JSON/ảnh; `evidence/latest-v3.json` trỏ bộ này. Checkpoint ngay sau restart được giữ bằng IPC trong fixture để chụp trước khi worker tiếp tục; app bình thường không có bước chờ đó.

## 7. Reset, logs và giới hạn

Dừng toàn bộ app trước khi chạy `npm.cmd run db:reset`; sau đó `npm.cmd run dev` seed lại. Reset giữ logs/evidence. `logs/{order,inventory,payment}.jsonl` là live logs; `supervisor.jsonl` có marker và vòng đời process; SQLite Order giữ HTTP traces và Saga events.

Một coordinator instance, một SKU/đơn, full refund. Không broker/outbox, multi-coordinator lock hoặc exactly-once delivery toàn hệ thống. Refund là giao dịch bù mới, giữ lịch sử charge. Dependency lỗi kéo dài giữ pending.

Xem [report.html](report.html) hoặc [report.md](report.md) để đọc kiến trúc, danh sách API và hướng dẫn bấm demo. [DEMO.md](DEMO.md) có thêm lệnh đọc DB/SQL; [Plan.md](Plan.md) lưu kế hoạch triển khai. HTML light theme được tạo offline từ Markdown bằng `python scripts/render-report.py`; Python chỉ cần khi tạo lại report, không cần để chạy app.

Bản clone/ZIP không kèm `node_modules`, `.env`, DB đang chạy hay logs cá nhân. Lần chạy đầu tạo DB và dữ liệu mẫu; các lần sau dùng lại dữ liệu đã lưu. Source, báo cáo và evidence đã lưu được giữ trong bản phát hành.
