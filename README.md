# REST → gRPC giữa Order API và Inventory Service

Web nâng cao · Tuần 2 · Block 3. Browser gọi Order API bằng REST/JSON (giữ nguyên); Order API gọi Inventory, ban đầu bằng REST, sau chuyển sang gRPC. Có thêm field `reservation_expires_at` (tag 4) và chứng minh client cũ (build từ proto trước, chưa build lại) vẫn chạy với server mới.

Các quyết định đã chốt trước khi viết gRPC nằm ở **[PLAN.md](PLAN.md)**.

## Yêu cầu

- Node.js ≥ 22 (đã chạy trên Node 24.10, Windows 11)
- Không cần cài protoc riêng: dùng `protoc` đi kèm npm `grpc-tools`

## Chạy demo

```bash
npm install
npm start            # supervisor chạy 6 process + dashboard
```

Mở **http://localhost:4000** để chọn client, chạy các luồng đặt hàng, điều khiển Inventory và xem kết quả/log. Nút **Đọc báo cáo** mở phần giải thích lựa chọn và kết quả tại [REPORT.html](REPORT.html); có bản [REPORT.md](REPORT.md) để đọc trong IDE.

| Instance | Cổng | Ghi chú |
|---|---|---|
| inventory-v2 (server mới) | REST 5001 · gRPC 50051 | source, proto v2 |
| inventory-v1 (server cũ) | REST 5002 · gRPC 50052 | `builds/inventory-v1.cjs` (đóng băng) |
| order-rest | 3001 | baseline, `TRANSPORT=rest` |
| order-grpc-v1 (**client cũ**) | 3002 | `builds/order-api-v1.cjs` (đóng băng) |
| order-grpc-v2 (client mới) | 3003 | source, proto v2 |
| order-grpc-v2-oldsrv | 3004 | client mới → server cũ |

Log của từng process được ghi vào `logs/<instance>.log` (JSON lines), đồng thời hiển thị live trên dashboard.

### Kịch bản demo gợi ý

1. Bấm **gRPC · client cũ** → *Đủ hàng ×2* → `POST /orders`. Kết quả 201. Panel nội bộ cho thấy lời gọi `gRPC /inventory.InventoryService/Reserve`, "13 B bị bỏ qua" (field 4), và Inventory log `gọi bởi order-api/1.0.0;proto=v1;bundle=…`.
2. **gRPC · client mới**: body có thêm `reservationExpiresAt`.
3. **Client mới → server cũ**: field vắng, nên key bị bỏ.
4. *Thiếu hàng ×10*: 409 `OUT_OF_STOCK` (gRPC `FAILED_PRECONDITION` + trailer).
5. Bấm **Chậm 5 s** ở Server mới, gửi lại: 504 sau ~2 s. Khoảng 3 s sau, Inventory log `SKIPPED_CALLER_CANCELLED`, tồn kho không đổi.
6. Bấm **Tắt process**, gửi lại: 503 ngay. Bấm **Bật lại**.
7. **Gửi cùng request tới cả 4 client & so sánh**: hiện bảng so sánh status và body.

## Sinh code

```bash
npx tsx src/scripts/gen.ts <label>          # protoc + ts-proto → src/gen, ghi evidence/codegen/<label>.txt
```

Lệnh thực tế mà script chạy:

```
node_modules/grpc-tools/bin/protoc \
  --plugin=protoc-gen-ts_proto=node_modules\.bin\protoc-gen-ts_proto.cmd \   # Linux/macOS: node_modules/.bin/protoc-gen-ts_proto
  --ts_proto_out=src/gen \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,useDate=true,env=node \
  -I proto -I node_modules/grpc-tools/bin proto/inventory.proto
```

- `proto/history/inventory.v1.proto`: proto trước khi thêm field
- `proto/inventory.proto`: proto hiện tại (v2)
- `evidence/codegen/proto-v1-v2.diff`: `diff -u` giữa hai bản

## Client cũ (không build lại)

- `frozen/v1/`: bản chụp source và code sinh từ proto v1, lấy **trước** khi thêm field.
- `builds/order-api-v1.cjs` và `builds/inventory-v1.cjs` được bundle bằng esbuild qua `npx tsx src/scripts/build-v1.ts`.
- `builds/build-info.json` ghi sha256 của từng bundle và thời điểm build. Mặc định script build từ chối chạy lại nếu file này đã tồn tại.
- Lúc chạy, bundle tự tính sha256 của chính nó, ghi vào `clientVersion` và gửi metadata `x-client-version`. Dashboard so sánh hash lúc build, hash của file hiện tại và hash của process đang chạy.

Bundle và proto v1 phải giữ nguyên byte, gồm cả newline LF. `.gitattributes` tắt chuyển đổi newline cho `builds/*.cjs` và `frozen/v1/proto/inventory.proto` để hash vẫn khớp manifest. Không chạy lại `build:v1` hoặc dùng `--force` khi chỉ muốn chạy demo/thu thập evidence.

## Tái tạo evidence (cần `npm start` đang chạy)

```bash
npm run typecheck
npm run evidence:snapshot     # snapshot mọi Order API + so với baseline + ma trận client×server → evidence/snapshots, evidence/matrix.json
npm run evidence:scenarios    # thiếu hàng / chậm / tắt → evidence/scenarios.json
npm run evidence:measure      # payload (message + wire) và latency → evidence/payload.json
```

Chạy các lệnh trên lần lượt ở terminal thứ hai; tránh gửi request trên dashboard cùng lúc vì chúng dùng chung fixture.

Ma trận ghép log đúng REST/gRPC, cùng `reservationId` và phiên bản caller, trong khoảng của response đơn vừa tạo. Nếu có nhiều lời gọi xen vào khoảng này hoặc không tìm được cặp log, script báo lỗi thay vì ghi bằng chứng không khớp. Bảng payload và cách đọc giới hạn phép đo nằm ở mục 8 của REPORT.md/REPORT.html; ghi chú developer experience nằm trong `evidence/dx-notes.md`.

Hai mốc lịch sử **không** chạy lại được vì code đã chuyển sang bước sau:
- `evidence/snapshots/baseline-rest.json` và `evidence/logs/baseline-*.log`: chụp ở giai đoạn baseline, khi chỉ có REST.
- `evidence/snapshots/grpc-v1.json` và `evidence/logs/grpc-*.log`: chụp ngay sau khi chuyển sang gRPC (proto v1), trước khi thêm field.

Muốn so lại thủ công: `npx tsx src/scripts/compare.ts baseline-rest grpc-v1`.

## Cấu trúc

```
PLAN.md                       quyết định đã chốt
proto/                        inventory.proto (v2), history/inventory.v1.proto
src/inventory/                REST (baseline + admin) và gRPC server, store
src/order-api/                API ngoài + client REST/gRPC + ánh xạ lỗi
src/gen/                      code sinh từ proto (không sửa tay)
src/supervisor/               chạy topology, gom log, API cho dashboard
src/scripts/                  gen, build-v1, snapshot, compare, snapshot-all, scenarios, measure
frozen/v1/                    source + code sinh của bản v1 (đóng băng)
builds/                       bundle v1 + build-info.json
dashboard/                    HTML/CSS/JS thuần
evidence/                     snapshot, log, codegen, matrix, scenarios, payload, dx-notes.md
```

Dữ liệu đều là dữ liệu giả (SKU-001, tồn 5). Không có secret.
