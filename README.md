# Akira Trading Alert System

Hệ thống phân tích thị trường và cảnh báo giao dịch thực chiến thời gian thực qua Telegram do **Akira** nghiên cứu, thiết kế và phát triển.

Hệ thống tập trung vào thị trường Vàng (`XAU/USD`), tiền mã hóa (`BTC`, `ETH`, `SOL`, ...) và các sự kiện kinh tế vĩ mô, được xây dựng theo kiến trúc hướng sự kiện độ trễ thấp nhằm phục vụ quá trình theo dõi và ra quyết định giao dịch liên tục 24/7.

---

## Kiến trúc kỹ thuật

- **Nền tảng cốt lõi:** NestJS, TypeScript, Prisma (PostgreSQL) và Telegraf.
- **Dữ liệu thời gian thực (0ms Live WebSocket):** Kết nối trực tiếp luồng giá thời gian thực với cơ chế watchdog, heartbeat định kỳ, phát hiện kết nối treo/clock-jump, tự động kết nối lại theo exponential backoff kèm jitter và đồng bộ lại dữ liệu ngay sau khi phục hồi.
- **Phân tích hợp lưu đa khung thời gian (Multi-Timeframe Confluence):** Đánh giá đồng bộ nhiều khung thời gian theo sự kiện giá (event-driven) kết hợp cơ chế memoization giúp tối ưu CPU ngay cả khi thị trường biến động mạnh.
- **Pipeline gửi cảnh báo độ trễ thấp:**
  - **In-Memory Subscriber Cache:** Nạp cấu hình người dùng vào RAM khi khởi động, đồng bộ tức thì mỗi khi người dùng thay đổi cài đặt để loại bỏ độ trễ truy vấn cơ sở dữ liệu trên đường gửi tin.
  - **Send-First, Log-Later:** Ưu tiên phát thông báo Telegram trước, ghi lịch sử vào cơ sở dữ liệu bất đồng bộ phía sau.
  - **Batch Broadcast:** Gửi tin song song theo nhóm kết hợp cơ chế tự phục hồi kết nối PostgreSQL serverless.
- **Sẵn sàng triển khai Cloud:** Đóng gói Docker multi-stage build nhẹ, chạy bằng user non-root và hỗ trợ graceful shutdown.

---

## Hệ thống phân cấp tín hiệu (Tier System)

Mọi tín hiệu được **Akira** thiết kế và phân tầng rõ ràng theo mức độ hội tụ và xác nhận hành động giá, giúp người giao dịch lọc nhiễu và kiểm soát hoàn toàn loại thông báo muốn nhận:

| Cấp độ | Vai trò | Mô tả tổng quan |
| :--- | :--- | :--- |
| **Tier 0** | Tín hiệu cơ sở | Cảnh báo sớm khi giá tiến vào vùng biên nhạy cảm để bắt đầu quan sát. |
| **Tier 1** | Tín hiệu tiêu chuẩn | Cảnh báo khi giá tiếp cận vùng phản ứng chính trên từng chiến lược độc lập. |
| **Tier 2** | Hợp lưu nâng cao | Xác nhận hội tụ từ nhiều yếu tố kỹ thuật hoặc cấu trúc đa khung thời gian. |
| **Tier 3** | Xác nhận VIP | Tín hiệu chất lượng cao kết hợp xác nhận phản ứng giá trực tiếp tại vùng hợp lưu. |
| **Tier SSS** | Siêu hợp lưu | Cấp độ ưu tiên cao nhất khi các hệ thống chiến lược độc lập cùng đồng thuận một hướng giao dịch. |

> *Ghi chú: Chi tiết thuật toán định lượng, bộ tham số và bộ lọc nội bộ thuộc quyền sở hữu nghiên cứu của tác giả và không công khai trên tài liệu công cộng.*

---

## Tính năng nổi bật

- **Tùy biến bật/tắt chi tiết theo từng Tier:** Cho phép bật hoặc tắt độc lập từng cấp độ (`Tier 0`, `Tier 1`, `Tier 2`, `Tier 3`, `Tier SSS`) trực tiếp qua menu `/tiers` hoặc nút `Cài đặt Tier` trên Dashboard — tắt cấp thấp không làm gián đoạn các cấp cao hơn.
- **Bộ lọc xu hướng trong ngày (Daily Bias):** Lọc tín hiệu theo chiều ưu tiên (`BUY_ONLY`, `SELL_ONLY`, `BOTH`) tùy theo kế hoạch giao dịch từng phiên.
- **Theo dõi đa khung thời gian:** Bảng điều khiển tương tác trên Telegram cho phép bật/tắt linh hoạt từng khung thời gian theo dõi.
- **Cảnh báo gọi điện thoại Telegram (CallMeBot):** Hỗ trợ đổ chuông báo thức cho các tín hiệu mức ưu tiên cao nhất để không bỏ lỡ cơ hội quan trọng.
- **Tiện ích giao dịch bổ trợ:** Cảnh báo chạm mốc giá tùy chỉnh (`/alert`), bảng theo dõi động lượng Vàng đa khung (`/gold`), lịch sự kiện kinh tế vĩ mô theo thời gian thực (`/calendar`) và cổng Webhook nhận tín hiệu từ nền tảng giao dịch bên ngoài.

---

## Danh sách lệnh Telegram chính

| Nhóm | Lệnh | Chức năng |
| :--- | :--- | :--- |
| **Cài đặt Tier** | `/tiers`, `/tier` | Mở menu bật/tắt độc lập `Tier 0`, `Tier 1`, `Tier 2`, `Tier 3`, `Tier SSS` và preset nhanh |
| **Chiến lược biến động** | `/bbatr`, `/bb` | Mở bảng điều khiển, chọn Daily Bias và bật/tắt cảnh báo tự động |
| **Biên động (Envelope)** | `/nwe`, `/envelope` | Mở bảng điều khiển Envelope đa khung và tùy chọn khung nhận tin |
| **Cấu trúc Cung/Cầu (SMC)** | `/ob`, `/smc` | Mở bảng điều khiển Order Block đa khung và tùy chọn khung nhận tin |
| **Cảnh báo VIP** | `/tier3`, `/testcall` | Bật/tắt nhanh cảnh báo VIP và kiểm tra kết nối gọi điện báo thức |
| **Cảnh báo giá** | `/alert <mã> <giá>`, `/alerts` | Đặt và quản lý cảnh báo chạm mốc giá Vàng / Crypto |
| **Theo dõi Vàng** | `/gold`, `/goldalert` | Xem bảng động lượng đa khung và cài đặt ngưỡng cảnh báo |
| **Kinh tế vĩ mô** | `/calendar`, `/settings` | Xem lịch tin tức vĩ mô trong ngày và chọn mức độ ưu tiên |
| **Trợ giúp** | `/start`, `/help` | Hiển thị hướng dẫn tổng quan |

---

## Tài liệu hướng dẫn

- [COMMANDS.md](COMMANDS.md) — Hướng dẫn chi tiết danh sách câu lệnh và thao tác trên Telegram.
- [CALLMEBOT_SETUP.md](CALLMEBOT_SETUP.md) — Hướng dẫn thiết lập tính năng gọi điện báo thức Telegram qua CallMeBot.
