# Block 2: API composition (baseline, BFF, GraphQL)

Dashboard hiển thị tên người dùng và danh sách đơn, mỗi dòng hàng kèm tên product. Dữ liệu nằm ở ba service (User, Order, Product), mỗi service một CSDL SQLite. Có ba cách ghép dữ liệu:

| Biến thể | Ghép ở đâu | Endpoint client gọi |
|---|---|---|
| Baseline | Browser, gọi tuần tự 3 service | `:4001/users/:id` → `:4002/users/:id/orders` → `:4003/products?ids=` |
| BFF | Server, mỗi loại client một endpoint | `GET :4010/bff/web/dashboard/:userId`, `GET :4010/bff/mobile/orders/:userId` |
| GraphQL | Server, một endpoint, hai query | `POST :4020/graphql` (`WebDashboard`, `MobileOrders`) |

Mọi quyết định thiết kế (schema, contract, cách đếm, mốc màn hình hoàn tất, policy lỗi) nằm trong [`decisions.md`](decisions.md), viết trước khi hiện thực. Các option đã cân nhắc nằm trong [`brainstorm.md`](brainstorm.md). Kết quả đo và trade-off: [`REPORT.md`](REPORT.md).

## Yêu cầu

- Node.js ≥ 20 (đã chạy với Node 24.10, Windows 11).
- Một trình duyệt Chromium cho Playwright, chọn một trong hai:
  - `npx playwright install chromium`, hoặc
  - dùng Edge/Chrome có sẵn. Script tự thử `chromium` → `msedge` → `chrome`. Có thể ép bằng `BROWSER_CHANNEL=msedge`.
- Các cổng 4001, 4002, 4003, 4010, 4020, 5173 phải đang trống.

## Chạy lại toàn bộ

```bash
npm install
npm run seed        # tạo data/*.db và client/img/*.png, kiểm tra N/M/K khớp decisions.md
npm run verify      # đối chiếu dữ liệu web/mobile + kịch bản lỗi -> results/verify.json
npm run measure     # ma trận đo đầy đủ -> results/raw/*.csv, results/screenshots/ (khoảng 10 phút)
npm run report      # -> results/summary.md, results/summary.csv
npm run waterfall   # -> results/waterfall/*.svg, results/traces/*.md
# hoặc gộp: npm run all
```

`npm run measure:quick` chạy 1 lượt × 2 warm, chỉ dataset small (khoảng 1–2 phút), dùng để thử trước.

## Demo bằng tay

```bash
npm start           # GraphQL ở chế độ batched (đã sửa N+1), bật /__fault
npm run start:naive # GraphQL ở chế độ naive (tái hiện N+1)
```

Sau đó mở <http://localhost:5173/> và chọn biến thể, dataset (`u_small` 10 đơn / `u_large` 200 đơn) và client (web hoặc mobile).

- Thanh trên cùng của mỗi trang hiện `rid`. Có thể xem số call và số DB query của đúng lần tải đó:
  ```bash
  node scripts/parse-logs.js <8 ký tự đầu của rid>   # hoặc: node scripts/parse-logs.js --last
  ```
- DevTools › Network: xem số request và waterfall. DevTools › Performance: xem các mark `data-start`, `screen-complete`, `images-complete`.
- GraphiQL: <http://localhost:4020/graphql>.
- Làm Product Service chậm hoặc lỗi (cần `npm start`, vì lệnh này đã bật `ENABLE_FAULT=1`):
  ```bash
  curl -X POST http://localhost:4003/__fault -H "Content-Type: application/json" -d "{\"mode\":\"delay\",\"delayMs\":3000}"
  curl -X POST http://localhost:4003/__fault -H "Content-Type: application/json" -d "{\"mode\":\"error\"}"
  curl -X POST http://localhost:4003/__fault -H "Content-Type: application/json" -d "{\"mode\":\"hang\"}"
  curl -X POST http://localhost:4003/__fault -H "Content-Type: application/json" -d "{\"mode\":\"none\"}"
  ```
  PowerShell: `Invoke-RestMethod -Method Post http://localhost:4003/__fault -ContentType 'application/json' -Body '{"mode":"error"}'`

## Cấu trúc

```
services/{user,order,product}/server.js   REST + SQLite (Product có /__fault)
bff/server.js                             BFF web + mobile
graphql/server.js                         graphql-yoga + DataLoader (PRODUCT_LOADER=naive|batched)
shared/                                   rid + log JSON lines, httpClient (timeout 1000 ms), hook DB, mã lỗi
client/                                   web.html, mobile.html, render.js (render + mark dùng chung), adapters/*
scripts/seed.js                           dữ liệu tất định
scripts/stack.js, start.js                khởi động/restart các server
scripts/browser.js                        Playwright: một lần tải màn hình trong context mới
scripts/logs.js, parse-logs.js            đọc log theo rid, đếm call/DB query/preflight/cache-hit
scripts/verify.js                         đối chiếu dữ liệu (decisions.md mục 8)
scripts/measure.js                        ma trận đo (mục 6.3, 7.4)
scripts/report.js, waterfall.js           bảng tổng hợp, waterfall SVG, trace N+1, call graph BFF
```

## Sản phẩm nộp ↔ file

| Yêu cầu của đề | Nơi xem |
|---|---|
| README để chạy lại | file này |
| Plan với các quyết định đã chốt và policy lỗi | [`decisions.md`](decisions.md) (mục 7: policy P2) |
| Waterfall baseline/BFF/GraphQL kèm mốc màn hình hoàn tất | [`results/waterfall/README.md`](results/waterfall/README.md) |
| Bảng đo thô từng lần chạy, kèm cách đếm | [`results/raw/runs.csv`](results/raw/runs.csv), cách đếm: `decisions.md` mục 5. Tổng hợp: [`results/summary.md`](results/summary.md) |
| Trace N+1 trước/sau (GraphQL), call graph nội bộ (BFF) | [`results/traces/graphql-n-plus-1.md`](results/traces/graphql-n-plus-1.md), [`results/traces/bff-call-graph.md`](results/traces/bff-call-graph.md) |
| Đối chiếu dữ liệu hai loại client, kết quả khi Product chậm/lỗi | [`results/verify.json`](results/verify.json), bảng lỗi trong `results/summary.md`, ảnh [`results/screenshots/`](results/screenshots/) |
| Trade-off và giới hạn của phép đo | [`REPORT.md`](REPORT.md) |

Log thô theo `rid` nằm ở `logs/measure-*/` và `logs/verify-*/`. Thư mục `logs/` không đưa vào git vì khá lớn; chạy lại `npm run measure` để tạo lại.

## Cách đếm (tóm tắt, chi tiết ở decisions.md mục 5)

- Mỗi lần tải màn hình có một `rid`. Client gửi `rid` qua `?rid=` (không dùng custom header để tránh preflight), composer chuyển tiếp xuống service bằng `X-Request-Id`.
- Mỗi server ghi JSON lines vào `logs/<phiên>/<service>.jsonl`:
  - `http-in`/`http-done` cho mỗi request nhận vào
  - `http-out` cho mỗi call ra ngoài (kèm `timedOut`)
  - `db` cho mỗi câu SQL, lấy từ hook `verbose` của better-sqlite3 nên không câu nào lọt
  - `cache-hit` cho DataLoader
- **Service call** = số `http-in` tại service đích. **DB query** = số `db` tại service đó. **Client request** = request dữ liệu Playwright ghi nhận. **Preflight** = `http-in` có method `OPTIONS`.
- Mỗi lần chạy đều kiểm tra chéo: số `http-out` của composer phải bằng số `http-in` ở service (cột `count_check`).

## Dữ liệu

Toàn bộ là dữ liệu giả, sinh tất định (`mulberry32(42)`): tên, email `@example.test`, địa chỉ có ghi "(địa chỉ giả)". Không có secret hay token.
