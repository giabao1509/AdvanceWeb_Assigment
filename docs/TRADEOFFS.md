# Quyết định và giới hạn

- **HTTP loopback** theo yêu cầu mới của người dùng. Không có TLS và cookie Secure; không triển khai thành dịch vụ công khai. ES256 bảo vệ tính xác thực token, không mã hóa đường truyền.
- **Node 22.17.1 hiện có** đã chạy được, thay cho mục tiêu Node 24 ban đầu. Lockfile ghi phiên bản dependency thật. Một package root và TypeScript shared modules thay workspaces/packages riêng để chạy bài gọn hơn.
- **HTML/CSS/JS không framework**, không CDN. Dashboard đơn giản, cập nhật 3 giây; không thêm SPA/build pipeline.
- **Opaque SQLite sessions** là adapter ngắn cho lab, random SID lưu hash, rotate sau login, HttpOnly/SameSite và CSRF. Không dùng JWT trong cookie hoặc tự viết OAuth client. Taxi dùng openid-client; script tấn công được phép gọi HTTP trực tiếp.
- **Baseline/full cùng nguồn hiện tại**, mode cố định lúc process start, data/key/cookies riêng. Có kết quả so sánh policy chạy thật; không tuyên bố có commit lịch sử baseline-only trước khi viết secure implementation.
- **JWT offline + local revocation lookup** giải quyết code replay với TTL ngắn. Đây là shared filesystem coupling có chủ đích; không phải kiến trúc microservice đa host.
- **SQL trực tiếp, transaction ngắn** giúp đọc được điều kiện consume/rotate/charge. Một process mỗi service; evidence race qua HTTP không thay chứng minh multi-process/power-loss.
- **Một worker, lock theo user** tránh refresh song song. Jobs bền vững; retry charge giữ idempotency key. Không bảo đảm distributed exactly-once; crash giữa refresh và lưu vault có thể cần link lại.
- **Taxi và Wallet có tài khoản seed riêng**, đều kiểm mật khẩu Argon2id và session. Không còn tự gán identity Alice. Dashboard đọc ví/lịch sử charge qua API Bearer theo sub/client; không công khai danh sách ví hoặc route `/lab/*`. Log/trace nội bộ cần xác thực giữa service. Mật khẩu seed vẫn được ghi trong trang hướng dẫn phục vụ bài thực hành.
- **Consent mới cho mỗi vé mới** là quy tắc nghiệp vụ để nhìn rõ chuỗi cấp quyền trước đặt vé. Intent gắn user/session, chỉ chuyển authorized sau callback/code exchange; deny không tạo vé. Retry và job offline dùng quyền đã cấp. Catalog/booking là dữ liệu bền vững; chưa có inventory chỗ hoặc điều phối xe ngoài hệ thống.
- **Không có hàng loạt unit test.** Giữ smoke hai mode, chín attack cases đề yêu cầu, một nhóm race checks và một kịch bản UI. Phần chưa được kiểm độc lập: key rotation/HA, MFA, load/soak, multi-host worker, HSM/KMS, exhaustive malformed JWT matrix và crash consistency.
- Rate limit là in-memory theo process; database/demo có thể tăng dần qua các lượt chạy. Dùng reset:demo khi muốn bắt đầu lại. Không xem các lần chạy local là chứng nhận production.

Ưu tiên tiếp theo nếu mở rộng: thay AS lab bằng sản phẩm đã kiểm chứng; TLS; quản lý/rotate key và secret; revocation events hoặc introspection; distributed refresh coordination; tách diagnostic surface khỏi production API.
