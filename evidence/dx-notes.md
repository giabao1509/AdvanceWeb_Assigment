# Ghi chú developer experience (quan sát thật khi làm)

Môi trường: Windows 11, Node 24.10, TypeScript 7.0, @grpc/grpc-js 1.14, ts-proto 2.15, protoc 3.19.1 (từ grpc-tools 1.13). Thư mục dự án có dấu cách và ký tự Unicode (`C:\My Workspace\HCMUS\Web nâng cao\Block3`).

## Bước sinh code
- Sinh code v1 lần đầu mất **3333 ms**, những lần sau khoảng **360 ms** (xem `evidence/codegen/v1.txt`, `v2.txt`).
- **Lỗi 1, runtime của bước gen:** gọi `grpc_tools_node_protoc` qua shell (`.cmd`) thì đường dẫn chứa dấu cách bị cắt đôi, báo `'C:\My' is not recognized as an internal or external command`. Cách sửa: gọi thẳng `node_modules/grpc-tools/bin/protoc.exe`, không qua shell, và dùng đường dẫn tương đối.
- **Lỗi 2:** protoc chạy plugin `.cmd` qua `cmd.exe`, nên đường dẫn plugin bắt buộc dùng backslash. Nếu dùng `/` thì báo `'node_modules' is not recognized` rồi `Plugin failed with status code 1`.
- **Lỗi 3, khi thêm field Timestamp:** `google/protobuf/timestamp.proto: File not found`. protoc của grpc-tools không tự tìm thấy well-known type, phải thêm `-I node_modules/grpc-tools/bin`. Output của lần lỗi được giữ ở `evidence/codegen/v2-attempt1-failed.txt`.
- Code sinh ra import `@bufbuild/protobuf/wire`. Package này chỉ có sẵn vì là dependency bắc cầu của ts-proto (một devDependency), nên phải khai báo nó thành dependency runtime. Nếu không, môi trường production cài không kèm devDependencies sẽ bị vỡ.

## Lỗi compile
- TypeScript 7 đã bỏ `moduleResolution: node10` (lỗi `TS5108`), phải chuyển sang `module: preserve` + `moduleResolution: bundler`. Lỗi này không liên quan gRPC nhưng tốn thời gian thật.
- Sau khi sinh lại code v2, server **không compile được**: `TS2741: Property 'reservationExpiresAt' is missing`. ts-proto sinh field dạng `reservationExpiresAt: Date | undefined`, tức key bắt buộc và giá trị có thể undefined. Compiler vì thế buộc server mới phải cập nhật, còn bundle client cũ thì không bị ảnh hưởng. Output lỗi nằm ở `evidence/codegen/v2-tsc-before-fix.txt`.

## Lỗi runtime / đọc log
- `call.getDeadline()` của grpc-js server trả về **số ms epoch** chứ không phải `Date`, nên log ban đầu in ra `"deadline":"1791867539180"`. Đã sửa cách format.
- Payload gRPC là nhị phân nên không xem được bằng curl hay DevTools như REST. Mọi thông tin debug (grpcCode, details, trailer) đều phải tự log ra. Chi tiết thiếu hàng (`x-available-stock`) nằm trong **trailer**, nếu không log thì không thấy.
- REST baseline có thể thử trực tiếp bằng `curl -X POST :5001/reservations`. gRPC cần client sinh code (hoặc grpcurl kèm reflection, bài này không cài).
- Client cũ nhận field 4 và **bỏ qua trong im lặng**: ts-proto không cảnh báo về unknown field. Hiện tượng này chỉ thấy được nhờ log `unknownFieldBytes` (13–14 byte), là hiệu của số byte nhận trên wire trừ số byte client hiểu được.
- Deadline của gRPC được truyền sang server qua header `grpc-timeout`. Server log ra deadline và thấy `call.cancelled = true`. Với REST, server không biết deadline của client, chỉ phát hiện client bỏ đi khi socket đóng (`res.on("close")`).

## Phát hành client và server riêng
- Bundle client cũ (`builds/order-api-v1.cjs`) không được build lại; sha256 lúc chạy trùng với hash ghi lúc build (dashboard tự kiểm tra).
- Điều kiện để client cũ vẫn chạy được: giữ nguyên `package inventory`, tên service và tag 1–3. Đổi bất kỳ thứ nào trong số đó là phá wire contract dù code vẫn compile.
- Thêm field buộc phải sinh lại code ở **cả hai** repo (server để gửi, client để đọc), nhưng thứ tự deploy là tuỳ ý: server mới với client cũ chạy được, client mới với server cũ cũng chạy được (field vắng).
- So snapshot: body của Order API v2 có thêm key `reservationExpiresAt`, nên công cụ so sánh phải phân loại được "khác dạng additive" để không báo nhầm là vỡ contract.

## Đo
- HPACK: response lỗi gRPC ở lời gọi đầu là 39 byte xuống, các lời gọi sau chỉ còn 16 byte vì header/trailer đã nằm trong dynamic table.
- REST HTTP/1.1 gửi lại toàn bộ header ở mỗi lời gọi (`X-Powered-By`, `ETag`, `Date`, `Keep-Alive`…), nên wire bytes của REST ổn định nhưng lớn.
