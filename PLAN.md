# PLAN – REST → gRPC giữa Order API và Inventory Service

> Viết **trước** khi hiện thực gRPC. Mọi quyết định dưới đây đã được nhóm chốt (qua hỏi–đáp với agent), agent không tự quyết.
> Ngày chốt: 2026-10-13.

## 1. Stack

| Hạng mục | Quyết định |
|---|---|
| Ngôn ngữ | Node.js 24 + TypeScript (chạy bằng `tsx`, kiểm tra kiểu bằng `tsc --noEmit`) |
| REST | Express 5 |
| gRPC | `@grpc/grpc-js` |
| Sinh code | `protoc` (từ npm `grpc-tools`) + plugin `ts-proto` (`outputServices=grpc-js`, `useDate=true`) |
| Đóng băng client cũ | `esbuild` bundle 1 file `.cjs` |
| Dashboard | HTML/CSS/JS thuần, phục vụ bởi supervisor (Node), **tiếng Việt, nền sáng**, 5 tab: Problem · Solution · Demo · Evidence · Trade-off |
| Git | Không dùng |

## 2. Contract API ngoài (browser / bên thứ ba) – KHÔNG đổi khi chuyển transport

`POST /orders`, body `{ "sku": string, "quantity": integer }`

| Trường hợp | HTTP | Body |
|---|---|---|
| Đủ hàng | **201** | `{ orderId, sku, quantity, status: "CONFIRMED", createdAt }` (+ `reservationExpiresAt` **chỉ ở Order API v2**, xem §5) |
| Input sai (thiếu sku, quantity ≤ 0 / không nguyên) | **400** | `{ error: { code: "VALIDATION_ERROR", message, details } }` – Order API tự validate, không gọi Inventory |
| SKU không tồn tại | **404** | `{ error: { code: "SKU_NOT_FOUND", message, details: { sku } } }` |
| Thiếu hàng | **409** | `{ error: { code: "OUT_OF_STOCK", message, details: { sku, requested, available } } }` |
| Inventory tắt | **503** | `{ error: { code: "INVENTORY_UNAVAILABLE", message } }` |
| Inventory chậm quá deadline | **504** | `{ error: { code: "INVENTORY_TIMEOUT", message } }` |
| Lỗi khác (gRPC INTERNAL/UNKNOWN, REST 5xx…) | **500** | `{ error: { code: "INTERNAL_ERROR", message } }` |

- `message` được Order API tạo từ lỗi đã chuẩn hoá → giống hệt nhau dù transport là REST hay gRPC.
- Giá trị động khi đối chiếu snapshot: `orderId`, `createdAt`, `reservationExpiresAt` được thay bằng placeholder.

## 3. Fixture

- 1 SKU: `SKU-001` tồn = **5**.
- Đường đủ hàng: `SKU-001 × 2`. Đường thiếu hàng: `SKU-001 × 10`.
- Giữ hàng **có trừ tồn**; có endpoint/nút **Reset fixture**. Script snapshot reset trước mỗi lần gọi.
- TTL giữ hàng: **10 phút** (`reservation_expires_at = now + 10 phút`).

## 4. Proto (rev v1 – trước khi thêm field)

```proto
syntax = "proto3";
package inventory;

service InventoryService {
  rpc Reserve(ReserveRequest) returns (ReserveResponse);
}
message ReserveRequest  { string sku = 1; int32 quantity = 2; }
message ReserveResponse { string reservation_id = 1; string sku = 2; int32 quantity = 3; }
```

Package giữ nguyên `inventory` qua các revision (đổi package = đổi tên service trên wire = phá client cũ).

### Biểu diễn lỗi ở gRPC & ánh xạ ra ngoài

| Tình huống | gRPC (server) | REST baseline (server) | Order API → ngoài |
|---|---|---|---|
| Thiếu hàng | status `FAILED_PRECONDITION`, trailer `x-available-stock`, `x-requested` | 409 `INSUFFICIENT_STOCK` + `available` | 409 `OUT_OF_STOCK` |
| SKU lạ | `NOT_FOUND` | 404 | 404 `SKU_NOT_FOUND` |
| Quá deadline | client nhận `DEADLINE_EXCEEDED` | `AbortSignal.timeout` → `TimeoutError` | 504 `INVENTORY_TIMEOUT` |
| Server tắt | `UNAVAILABLE` | lỗi kết nối (`ECONNREFUSED`…) | 503 `INVENTORY_UNAVAILABLE` |
| Khác | `INTERNAL`, `UNKNOWN`, … | 5xx khác | 500 `INTERNAL_ERROR` |

## 5. Thêm field (rev v2)

```proto
import "google/protobuf/timestamp.proto";
message ReserveResponse {
  string reservation_id = 1; string sku = 2; int32 quantity = 3;   // không đổi tag/kiểu/nghĩa
  google.protobuf.Timestamp reservation_expires_at = 4;            // MỚI, tag 4
}
```

- Kiểu message (`Timestamp`) có presence: ts-proto sinh `reservationExpiresAt?: Date | undefined`.
- **Field vắng** (client v2 gọi server v1): Order API v2 **bỏ key** `reservationExpiresAt` khỏi body ngoài và log `field absent`. Không bao giờ diễn giải vắng thành epoch 1970.
- Order API v2 **có** đưa `reservationExpiresAt` vào body ngoài (thay đổi additive). Snapshot so sánh REST ↔ gRPC dùng Order API v1 (trước khi thêm field).

## 6. Deadline / Inventory chậm / tắt

- Deadline Order API → Inventory: **2000 ms** cho **cả REST baseline** (`AbortSignal.timeout(2000)`) **và gRPC** (`deadline`).
- Chế độ chậm: Inventory sleep **5 s** trước khi xử lý.
- Không giữ hàng ma: sau khi sleep, Inventory kiểm tra caller đã huỷ (`call.cancelled` cho gRPC / socket đã đóng cho REST) → không trừ tồn, log `skipped: caller cancelled`.
- Điều khiển bằng **nút trên dashboard**: supervisor quản lý process; bật/tắt chậm qua endpoint admin; kill/start process Inventory thật.

## 7. Topology chạy song song (cờ cấu hình)

| Instance | Cổng | Code | Gọi tới |
|---|---|---|---|
| `inventory-v2` (server mới) | REST 5001, gRPC 50051 | source hiện tại (proto v2) | – |
| `inventory-v1` (server cũ) | REST 5002, gRPC 50052 | bundle đóng băng v1 | – |
| `order-rest` (baseline) | 3001 | source, `TRANSPORT=rest` | inventory-v2 REST |
| `order-grpc-v1` (**client cũ**) | 3002 | **bundle đóng băng v1** | inventory-v2 gRPC |
| `order-grpc-v2` (client mới) | 3003 | source, proto v2 | inventory-v2 gRPC |
| `order-grpc-v2-oldsrv` | 3004 | source, proto v2 | inventory-v1 gRPC |
| supervisor + dashboard | 4000 | source | điều khiển tất cả |

## 8. Chứng minh client cũ chưa build lại

- Trước khi thêm field: chụp source vào `frozen/v1/`, build `builds/order-api-v1.cjs` và `builds/inventory-v1.cjs` bằng esbuild, ghi `builds/build-info.json` (version, proto sha256, sha256 bundle, thời điểm build).
- Khi chạy, process tự tính sha256 file của mình và log `clientVersion` + hash; gửi metadata `x-client-version` → Inventory log lại.
- Dashboard so hash đang chạy với hash lúc build.

## 9. Đo payload (chặng nội bộ)

Hai bảng **tách riêng**, không trộn:
1. **Message đã serialize**: REST = số byte UTF-8 của HTTP body JSON; gRPC = số byte protobuf của message (đo trong hàm serialize/deserialize, không gồm frame/header).
2. **Wire bytes**: TCP proxy đếm byte trên socket mỗi chiều. REST = HTTP/1.1 (header + body); gRPC = HTTP/2 (HEADERS/DATA/trailers, HPACK). Báo riêng lời gọi đầu (cold, có thiết lập kết nối) và lời gọi ấm.
- Thời gian phản hồi: ≥ 5 lần mỗi transport, báo median + min–max.

## 10. Thứ tự hiện thực

1. Baseline REST + snapshot + log nội bộ.
2. Proto v1, sinh code, gRPC server + client; snapshot sau.
3. Đóng băng client/server v1 (bundle + hash).
4. Thêm field tag 4, sinh lại, client mới đọc field.
5. Chạy ma trận client × server.
6. Thiếu hàng / chậm / tắt.
7. Đo payload + latency.
8. Dashboard + README.
