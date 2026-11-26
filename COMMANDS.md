# Hướng dẫn sử dụng lệnh Telegram — Akira Trading Alert System

Tài liệu tổng hợp toàn bộ câu lệnh và thao tác nút bấm tương tác trên Telegram Bot do **Akira** phát triển.

---

## 1. Bảng tổng hợp câu lệnh nhanh

| Nhóm tính năng | Lệnh chính | Lệnh thay thế | Chức năng |
| :--- | :--- | :--- | :--- |
| **Khởi động** | `/start` | `/help` | Đăng ký người dùng và xem hướng dẫn tổng quan |
| **Cài đặt Tier** | `/tiers` | `/tier`, `/tiersettings`, `/caidattier` | Bật/tắt độc lập từng mức `Tier 0`, `Tier 1`, `Tier 2`, `Tier 3`, `Tier SSS` |
| **Chiến lược Biến động** | `/bbatr` | `/bb`, `/bba`, `/strat` | Mở bảng điều khiển, xem trạng thái tín hiệu và bộ lọc xu hướng |
| | `/bbatr on` / `off` | `/bb on`, `/bb off` | Bật hoặc tắt cảnh báo tự động XAU/USD |
| | `/bbatr tier0` | `/bb t0` | Bật hoặc tắt nhanh riêng `Tier 0` |
| | `/bbatr buy` / `sell` / `both` | `/bb buy`, `/bb sell`, `/bb both` | Chọn bộ lọc hướng giao dịch trong ngày (Daily Bias) |
| | `/bbatr <mã> [khung]` | `/bb btc`, `/bb eth 15m` | Xem nhanh dữ liệu cho mã Vàng hoặc Crypto bất kỳ |
| | `/bbatr alert <mã> [khung]` | `/bb dat btc 15m` | Tạo cảnh báo cá nhân cho mã và khung thời gian tùy chọn |
| | `/bbatr list` / `del <id>` | `/bb ds`, `/bb xoa <id>` | Quản lý danh sách cảnh báo cá nhân |
| **Biên động (NWE)** | `/nwe` | `/envelope` | Mở bảng điều khiển NWE đa khung và chọn khung nhận cảnh báo |
| | `/nwe <khung>` | `/nwe m15`, `/nwe h1`, `/nwe h4` | Xem nhanh một khung thời gian cụ thể |
| | `/nwe on` / `off` | — | Bật hoặc tắt cảnh báo NWE |
| **Order Block (SMC)** | `/ob` | `/smc`, `/orderblock`, `/zone` | Mở bảng điều khiển vùng Cung/Cầu đa khung |
| | `/ob <khung>` | `/ob m15`, `/ob h1`, `/ob h4` | Xem nhanh vùng Cung/Cầu theo khung thời gian |
| | `/ob on` / `off` | — | Bật hoặc tắt cảnh báo Order Block |
| **VIP & Báo thức** | `/tier3` | `/tier2`, `/sweep`, `/sfp` | Bật/tắt nhanh cảnh báo VIP `Tier 3` |
| | `/testcall` | `/calltest` | Kiểm tra gọi điện báo thức Telegram qua CallMeBot |
| **Cảnh báo giá** | `/alert <mã> <giá>` | `/canhbao xau 3650` | Đặt cảnh báo chạm mốc giá cho Vàng hoặc Crypto |
| | `/alerts` | `/dsalert`, `/alertlist` | Xem và hủy các cảnh báo giá đang chờ |
| **Động lượng Vàng** | `/gold` | `/xau`, `/vang` | Xem bảng theo dõi Vàng đa khung thời gian |
| | `/goldalert` | `/xaualert`, `/goldsettings` | Cài đặt khung thời gian và ngưỡng cảnh báo Vàng |
| **Kinh tế Vĩ mô** | `/calendar` | `/macro`, `/forex` | Xem lịch công bố dữ liệu kinh tế vĩ mô trong ngày |
| | `/settings` | `/macro_settings` | Chọn mức độ ảnh hưởng của tin tức vĩ mô muốn nhận |

---

## 2. Quản lý thông báo theo từng Tier (`/tiers`)

Bấm nút **Cài đặt Tier** ngay trên bất kỳ Dashboard nào (`/bbatr`, `/nwe`, `/ob`) hoặc gõ `/tiers` để mở bảng tùy chỉnh độc lập:

- **Tier 0:** Tín hiệu cảnh báo sớm ở cấp cơ sở.
- **Tier 1:** Tín hiệu tiêu chuẩn trên từng chiến lược độc lập.
- **Tier 2:** Tín hiệu hợp lưu nâng cao / hợp lưu đa khung thời gian.
- **Tier 3:** Tín hiệu xác nhận VIP có độ ưu tiên cao.
- **Tier SSS:** Siêu hợp lưu tối thượng khi nhiều hệ thống cùng đồng thuận.

Mỗi nút hoạt động hoàn toàn độc lập và có hiệu lực ngay lập tức:
- Có thể tắt `Tier 0` hoặc `Tier 1` để giảm tần suất thông báo mà vẫn nhận đầy đủ `Tier 2`, `Tier 3` và `Tier SSS`.
- Hỗ trợ 2 chế độ chuyển đổi nhanh: **Bật tất cả Tier** và **Chỉ VIP (Tier 3 + SSS)**.

---

## 3. Cảnh báo gọi điện báo thức (CallMeBot)

- Hệ thống hỗ trợ tự động gọi điện báo thức trên Telegram cho các tín hiệu cấp độ ưu tiên cao nhất.
- Xem hướng dẫn kích hoạt chi tiết tại [CALLMEBOT_SETUP.md](CALLMEBOT_SETUP.md).
- Dùng `/testcall` để kiểm tra kết nối bất kỳ lúc nào.
