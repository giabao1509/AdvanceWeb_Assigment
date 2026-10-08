# Báo cáo: API composition (baseline, BFF, GraphQL)

> Mọi con số dưới đây lấy từ phiên đo `logs/measure-2026-10-08T02-46-33-076Z`: 570 lần chạy, không lần nào invalid hay lệch số đếm. Nguồn: [`results/summary.md`](results/summary.md) và [`results/raw/runs.csv`](results/raw/runs.csv). Phần nhận định là cách đọc số liệu: nhóm cần tự đối chiếu với bảng thô, log và diff trước khi trình bày, vì câu trả lời của agent không được dùng làm evidence.
>
> Môi trường đo: Windows 11, Node 24.10, Edge 154 (headless, qua Playwright), CPU i7-1260P. Client và cả 5 server chạy trên **cùng một máy**, qua localhost.

## 1. Problem

- Dashboard cần dữ liệu của 3 service: User → tên người dùng, Order → đơn và dòng hàng, Product → tên, giá, ảnh.
- Ở baseline, browser phải tự gọi tuần tự 3 service rồi tự ghép dữ liệu.
- Web cần đủ trường. Mobile chỉ cần mã đơn, trạng thái, tên product và ảnh.
- Product lặp lại giữa các đơn:

  | User | Đơn (N) | Dòng hàng (M) | Product khác nhau (K) |
  |---|---|---|---|
  | `u_small` | 10 | 19 | 6 |
  | `u_large` | 200 | 399 | 30 |

## 2. Solution

Quyết định chi tiết: [`decisions.md`](decisions.md).

| | Baseline | BFF | GraphQL |
|---|---|---|---|
| Client gọi | 3 request tuần tự | 1 request / client | 1 `POST /graphql` (+1 preflight CORS) |
| Ghép ở | browser | `bff/server.js` | resolver + DataLoader |
| Gọi nội bộ | – | User ‖ Order song song → Product batch | User → Order → Product: naive gọi từng dòng hàng; batched gom và dedup theo request |
| Mobile | – | endpoint riêng, không gọi User | query `ordersByUser`, không gọi User |
| Product lỗi | – | P2: `product: null` kèm `errors[{path, extensions.code}]`, HTTP 200 | P2: field nullable kèm `errors[]` chuẩn GraphQL |

## 3. Kết quả chính

### 3.1 Số request và số call (giống nhau ở mọi lần chạy)

| Biến thể | Client req | Preflight | User call/DB | Order call/DB | Product call/DB (small → large) | cache-hit (small → large) |
|---|---|---|---|---|---|---|
| Baseline (web) | 3 | 0 | 1/1 | 1/2 | 1/1 → 1/1 | – |
| BFF web | 1 | 0 | 1/1 | 1/2 | 1/1 → 1/1 | – |
| BFF mobile | 1 | 0 | **0/0** | 1/2 | 1/1 → 1/1 | – |
| GraphQL naive (web/mobile) | 1 | 1 | 1/1 (mobile 0/0) | 1/2 | **19/19 → 399/399** | 0 |
| GraphQL batched (web/mobile) | 1 | 1 | 1/1 (mobile 0/0) | 1/2 | **1/1 → 1/1** | 13 → 369 |

Mọi số đều khớp bảng giả thuyết ở `decisions.md` mục 5.4.

- Bản naive gọi Product **M lần**: tăng theo số dòng hàng, tức tăng theo số đơn.
- Bản batched luôn gọi **1 lần** và dedup M → K id (`cache-hit = M − K`).
- Trace từng call: [`results/traces/graphql-n-plus-1.md`](results/traces/graphql-n-plus-1.md).

### 3.2 Thời gian màn hình hoàn tất `t_data` (ms, median [min–max], warm, n = 25)

| Biến thể · client | small | large |
|---|---|---|
| Baseline · web | 82.5 [39.3–142.3] | 114.3 [80.6–147.5] |
| BFF · web | 51.0 [31.0–75.6] | 83.8 [67.7–140.7] |
| GraphQL naive · web | 66.9 [36.5–137.6] | **321.9** [144.9–387.0] |
| GraphQL batched · web | 49.4 [34.6–80.7] | 114.8 [74.2–158.7] |
| BFF · mobile | 40.1 [30.3–70.3] | 69.1 [39.7–106.3] |
| GraphQL naive · mobile | 55.1 [32.5–97.7] | 291.9 [114.9–389.8] |
| GraphQL batched · mobile | 47.3 [30.6–80.4] | 81.4 [52.6–126.3] |

Cold, lần đầu sau restart, n = 5:

- Hầu hết biến thể chậm hơn warm khoảng 20–70 ms, ví dụ BFF web small là 106.4 so với 51.0. Riêng baseline web small gần như bằng warm (84.5 so với 82.5).
- GraphQL naive large mất 429.8 ms ở cold, so với 321.9 ms ở warm.

Throttle RTT +100 ms (warm, n = 5):

| | Baseline | BFF web | GraphQL batched web |
|---|---|---|---|
| small | 406.5 | 156.5 | 171.9 |
| large | 455.6 | 203.0 | 173.9 |

Lưu ý giới hạn ở mục 6.

Đọc số liệu:

1. **Baseline trả giá theo số round-trip tuần tự.**
   - Trên localhost, BFF nhanh hơn baseline 31 ms (small) và 31 ms (large).
   - Có throttle 100 ms, BFF nhanh hơn khoảng 250 ms, tức khoảng 2.5 RTT. Đúng 2 request tuần tự bị bỏ, cộng phần JS ghép dữ liệu.
2. **N+1 chỉ thấy rõ khi dữ liệu lớn.**
   - Ở small (19 call), naive chỉ chậm hơn batched khoảng 17 ms.
   - Ở large (399 call), naive chậm gần 3 lần: 321.9 so với 114.8 ms. Thời gian xử lý trong GraphQL tăng từ 38.0 lên 249.7 ms (xem trace).
   - Bản naive còn mở tới 399 call chạy song song tới Product Service.
3. **GraphQL batched ngang BFF ở small** (49.4 so với 51.0), **chậm hơn ở large** (114.8 so với 83.8 ms với web, 81.4 so với 69.1 ms với mobile). Phần chênh có thể đến từ:
   - chi phí thực thi GraphQL khi resolve 399 field `product` qua DataLoader;
   - preflight `OPTIONS`.

   Hai phần này chưa được tách riêng để đo.
4. **Mobile nhanh hơn web** ở cùng biến thể, vì payload nhỏ hơn, không gọi User và render ít hơn.

Biên độ min–max khá rộng, ví dụ baseline small dao động 39–142 ms. Nguyên nhân: mốc `screen-complete` đặt sau 2 lần `requestAnimationFrame` nên bị làm tròn theo frame (16.7 ms), và client cùng server tranh CPU trên một máy. Vì vậy nên so bằng median, không so bằng một lần chạy lẻ.

### 3.3 Payload (body JSON client nhận, không nén / gzip)

| | Baseline web | BFF / GraphQL web | BFF / GraphQL mobile |
|---|---|---|---|
| small | 9.2 KB / 1.2 KB | 4.7 KB / 0.8 KB | 1.9 KB / 0.3 KB |
| large | 93.8 KB / 5.1 KB | 92.2 KB / 4.6 KB | 38.1 KB / 1.6 KB |

- **Mobile nhỏ hơn web khoảng 59–60%**, và chỉ chứa đúng các trường mobile cần (kiểm tra bằng whitelist khoá trong `verify.json`).
- **Baseline ở small nặng gấp đôi** vì nhận cả trường nội bộ (`description`, `category`, `userId`, `productId`).
- **Ở large, khoảng cách gần như biến mất** (93.8 so với 92.2 KB). Response đã ghép là dạng phi chuẩn hoá: lặp lại object product cho cả 399 dòng hàng. Trong khi đó, baseline chỉ tải 30 product một lần. Đây là trade-off đáng nói của composition, dù gzip thu hẹp được phần lớn khác biệt (5.1 so với 4.6 KB).
- GraphQL lớn hơn BFF vài chục byte do envelope `data`. Khi có lỗi thì lớn hơn rõ: 6.8 so với 6.0 KB với web small, vì mỗi lỗi kèm thêm `locations`.

### 3.4 Product Service chậm hoặc lỗi (policy P2, small, warm, n = 5)

| Fault | Màn hình | Mã lỗi | `t_data` BFF web / GQL web | Product call / DB | Call bị timeout |
|---|---|---|---|---|---|
| delay 300 ms | ok, đủ dữ liệu | – | 351.3 / 359.5 | 1 / 1 | 0 |
| delay 3000 ms | partial | `PRODUCT_TIMEOUT` | 1064.6 / 1071.2 | 1 / 0 | 1 |
| lỗi 500 | partial | `PRODUCT_UNAVAILABLE` | 42.0 / 41.4 | 1 / 0 | 0 |
| hang | partial | `PRODUCT_TIMEOUT` | 1051.3 / 1051.1 | 1 / 0 | 1 |

- Timeout 1000 ms giữ màn hình ở mức khoảng 1.05 s, kể cả khi Product treo hẳn. Không có retry nên số call vẫn là 1.
- Product DB = 0 khi bị timeout: Product Service thấy bên gọi đã huỷ nên bỏ qua truy vấn.
- Ở cả 4 kịch bản, user, đơn, tổng tiền và số dòng hàng **vẫn đầy đủ**. Với delay 300 ms, dữ liệu product cũng đủ. Với 3 kịch bản còn lại, 19/19 dòng hàng có `product: null` kèm lỗi đúng `path`.
- **Không có tên hay giá giả**: `verify.json` kiểm tra mọi product hoặc đúng bằng `product.db`, hoặc null kèm lỗi tương ứng.
- BFF và GraphQL đánh dấu cùng path và cùng mã lỗi.
- Ảnh chụp: [`results/screenshots/`](results/screenshots/). Waterfall khi Product treo: `results/waterfall/*-hang.svg`.

## 4. Evidence ↔ tiêu chí đạt

| Tiêu chí của đề | Kết quả | Evidence |
|---|---|---|
| Baseline, BFF, GraphQL trả cùng dữ liệu dashboard cho cùng người dùng | Đạt cho `u_small` và `u_large`. Cả naive và batched đều so với dữ liệu đọc thẳng từ 3 DB | `results/verify.json` mục `web.*` (44/44 đạt) |
| Response mobile chỉ chứa trường mobile cần | Đạt (whitelist khoá chính xác, BFF = GraphQL = phép chiếu của web) | `verify.json` mục `mobile.*` |
| Sau khi sửa N+1, call tới Product không tăng theo số đơn | Đạt: 1 call ở cả 10 và 200 đơn (naive: 19 → 399) | `results/traces/graphql-n-plus-1.md`, cột `product_calls` trong `runs.csv` |
| Số liệu là kết quả chạy thật | 570 lần chạy thô, mỗi dòng có `rid` để tra lại trong log | `results/raw/runs.csv`, `logs/measure-*/` |
| Waterfall có mốc màn hình hoàn tất | 18 waterfall (7 biến thể × localhost/throttle, cộng 4 waterfall khi Product treo), có vạch `data-start` và `screen-complete` | `results/waterfall/README.md` |
| Call graph nội bộ BFF | Sequence diagram từ log thật, thấy User ‖ Order song song, mobile không gọi User | `results/traces/bff-call-graph.md` |

Bộ kiểm tra cũng đã được thử ngược: cố ý cho BFF mobile trả thừa trường `lineNo` thì `verify.js` báo 10 kiểm tra FAIL. Sau đó code được hoàn nguyên.

## 5. Trade-off

| | Được | Mất |
|---|---|---|
| **Baseline** | Service đơn giản, không thêm hop. Payload chuẩn hoá: product chỉ tải một lần nên gọn khi product lặp nhiều. Mỗi response cache riêng được | Số round-trip tuần tự tăng theo số service: +250 ms khi RTT 100 ms. Over-fetch trường nội bộ. Mọi service phải mở CORS và lộ ra internet. Logic ghép lặp lại ở mỗi client |
| **BFF** | 1 request, gọi nội bộ song song, payload cắt theo từng client. Policy lỗi và timeout tập trung một chỗ. Nhanh nhất trong các phép đo warm | Thêm một service phải vận hành. Mỗi client một endpoint nên code ghép dễ trùng lặp (web và mobile). Response phi chuẩn hoá, lớn dần theo M. Đổi màn hình là phải sửa và deploy BFF |
| **GraphQL** | Một endpoint, client tự chọn trường: mobile chỉ là một query khác. Partial error có sẵn trong chuẩn (`data` + `errors[].path`). Schema có kiểu, tự mô tả | Mặc định là N+1 (mỗi field một resolver): 399 call nếu quên DataLoader. Phải nhớ dùng DataLoader **theo request**. `POST` cross-origin tốn thêm preflight. Chậm hơn BFF khoảng 31 ms ở large. Payload lỗi lớn và tăng theo M. Khó cache HTTP. Cần giới hạn độ sâu/độ phức tạp query (chưa làm) |
| **Policy P2 (partial)** | Product lỗi vẫn xem được trạng thái và tổng tiền đơn. Lỗi 500 trả nhanh (khoảng 40 ms) thay vì cả màn hình hỏng | HTTP 200 che sự cố khỏi monitoring theo status (bù bằng `X-Partial-Response` và log). Client phải xử lý `null`. Batch làm "lỗi một item" thành "lỗi cả chunk". 19 lỗi riêng cho 19 dòng hàng (399 với large) |
| **Giá lấy từ Product (D05)** | Kịch bản lỗi kiểm tra được đúng quy tắc "không thay tên/giá bằng giá trị giả" | Không đúng nghiệp vụ: giá đơn cũ phải là giá lúc mua |

## 6. Giới hạn của phép đo

- **Localhost, cùng một máy.**
  - RTT gần 0 nên lợi ích của việc giảm số request bị thu nhỏ.
  - Client và 5 server tranh CPU: bản naive mở 399 socket song song cùng lúc với browser đang render.
- **Throttle bằng CDP không phải RTT cộng thêm.**
  - Độ trễ hoạt động như thời gian tối thiểu cho mỗi request. Đo được: server 92 ms thì fetch 126 ms, server 161 ms thì fetch 168 ms.
  - Hệ quả: thời gian xử lý ở server bị giấu trong độ trễ giả lập. Đó là lý do naive và batched gần như bằng nhau khi throttle (192.9 so với 173.9 ms), dù không throttle thì chênh gần 3 lần.
  - Ma trận throttle chỉ dùng để thấy tác động của **số round-trip phía client**.
- **CDP không throttle preflight**, nên chi phí thêm 1 RTT của GraphQL `POST` cross-origin không hiện ra trong ma trận throttle.
- **Cold chỉ là cold về process** (JIT, kết nối, statement cache). SQLite vẫn được OS cache trang.
- **`screen-complete` bị làm tròn theo frame**, cộng thêm khoảng 16–33 ms, giống nhau cho mọi biến thể.
- **Instrumentation có overhead**: một dòng log cho mỗi sự kiện, khoảng 1600 dòng mỗi lần chạy naive large. Overhead này có ở mọi biến thể nhưng nặng hơn ở naive.
- **Waterfall ghép thời gian của browser và các process Node theo đồng hồ hệ thống.** Trên một máy, sai số dưới 1 ms, nhưng không dùng được khi chạy trên nhiều máy.
- **Mẫu nhỏ**: 5 mẫu cold và 25 mẫu warm mỗi ô, chỉ cho thấy xu hướng.
- **Phạm vi**: không có tải đồng thời, không phân trang, không auth. Trình duyệt là Edge vì chưa cài bản Chromium của Playwright.

## 7. Kịch bản trình bày (Problem → Solution → Demo → Evidence → Trade-off)

1. **Problem** (mục 1): sơ đồ 3 biến thể, bảng N/M/K.
2. **Solution** (mục 2 và `decisions.md`): nhấn vào D11 (song song, mobile không gọi User), D14 (DataLoader theo request), D21 (policy P2).
3. **Demo** (chạy thật trên `u_small`):
   1. `npm start`, mở <http://localhost:5173/>, chạy baseline web rồi BFF web. Mở DevTools › Network để thấy 3 request so với 1.
   2. Chạy `node scripts/parse-logs.js --last` ngay sau mỗi trang để thấy số call và số DB query.
   3. Tắt server, chạy `npm run start:naive`, mở GraphQL web với `u_large`, rồi `parse-logs --last`: thấy 399 call tới Product. Quay lại `npm start`: còn 1 call.
   4. Mở mobile BFF và GraphQL, so response trong DevTools: chỉ có `id, status, items[].product{name, thumbnailUrl}`.
   5. `curl -X POST :4003/__fault … {"mode":"hang"}`, tải lại web BFF và GraphQL: sau khoảng 1 s màn hình hiện dữ liệu một phần có đánh dấu lỗi. Đặt lại `none`.
4. **Evidence** (mục 3–4): bảng số call, bảng `t_data`, waterfall, trace N+1, call graph, `verify.json`.
5. **Trade-off** (mục 5–6).
