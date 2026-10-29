# Kịch bản trình bày

## Problem

Taxi cần charge ví của Alice sau chuyến đi dù Alice đã thoát app. Taxi không được biết password Wallet; quyền chỉ nằm trong scope Alice chấp thuận.

## Solution

Mở Full security `http://localhost:5103`. Giải thích ba thẻ: Taxi là client; Wallet AS cấp quyền; Wallet API giữ tài nguyên. Token ở server, browser đi qua code/state. Hai tab so sánh cùng protocol, khác policy AS.

## Demo

1. Chọn chuyến và bấm **Đặt vé từ đầu đến cuối**. Đăng nhập Taxi `alice / Taxi-alice-2026!`; sau đó đăng nhập Wallet AS `alice / Alice-demo-2026!`, đọc scope và bấm **Đồng ý liên kết**. Mỗi vé mới yêu cầu consent, kể cả ví đã liên kết. Nếu từ chối, không tạo vé hoặc khoản trừ tiền.
2. Xem thông báo đặt vé và sequence diagram đầy đủ từ đăng nhập/cấp quyền đến callback/token/tạo vé/charge. Bấm mũi tên `POST /consent` để thấy `decision: allow` trước bước tạo vé. Request/response lấy từ HTTP thực tế, payload chỉ mở khi chọn và credential đã che.
3. Bấm **Đặt lại cùng vé / chuyến vừa rồi**. Ticket/trip/key giữ nguyên và counter không tăng. Đặt vé mới yêu cầu consent lại và sinh vé mới. Mở một job cũ trong lịch sử rồi Đặt lại để gửi lại đúng vé đó. Contract API và guard consent: [API_FLOW.md](API_FLOW.md).
4. Đặt job offline, hoàn tất consent rồi logout Taxi. Trong lúc đợi token hết hạn thật, chạy case ở mode khác hoặc giải thích evidence. Không login/refresh lại cùng mode khi chờ. Đăng nhập lại để xem vé; browser đã logout không được đọc ví/vé.
5. Chạy sáu case trên chính `/authorize`, `/login`, `/consent`, `/token` và Wallet API. Route `/testing/cases/:id/runs` chỉ điều khiển HTTP tests. “Thiếu PKCE”: baseline cấp code; full trả invalid_request. “Dùng lại code”: full invalid_grant rồi API 401. “Replay refresh”: full thu hồi family. Dùng grant thử riêng để không phá grant của vé; không có API demo hoặc response giả.
6. Xem job completed: AS refresh 200 → Wallet API charge 201; active_taxi_sessions=0. Đăng nhập Taxi lại và mở quản lý quyền AS, revoke, refresh → invalid_grant/unlinked.
7. Case M2M: rates 200, charge 403; xin wallet:charge bị AS full trả invalid_scope.

## Evidence

Mở `evidence/<run-id>/REPORT.html` và JSON cạnh đó. Chỉ rõ mode, thời gian, status/error, exp trước job và counter trước/sau. UI có nhật ký live cả ba server và nút xem phản hồi từng job. Các field token/secret đã che; không đưa DevTools raw callback/cookie vào bài nộp.

## Trade-off

HTTP loopback theo yêu cầu; UI/identity/quan sát phục vụ lab. Full là kiểm tra OAuth đầy đủ theo phạm vi bài, còn production cần TLS, AS đã được kiểm chứng, quản lý khóa và hạ tầng thu hồi/worker phân tán.
