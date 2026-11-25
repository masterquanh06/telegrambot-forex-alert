# Telegram Forex & Financial Alert Bot

Hệ thống phân tích kỹ thuật thời gian thực và cảnh báo giao dịch qua Telegram cho Vàng (`XAU/USD`), Crypto (`BTC`, `ETH`, `SOL`, ...) và lịch kinh tế vĩ mô. Dự án được xây dựng trên nền tảng NestJS, TypeScript, Prisma (PostgreSQL) và Telegraf với các signal engine thuần (pure functions) tách biệt khỏi lớp I/O.

---

## Chiến lược & Hệ thống phân cấp tín hiệu

### 1. Bollinger Bands (20) + ATR (14) + RSI (14) — Khung M5 (`OANDA:XAUUSD`)

- **Nguồn dữ liệu:** Luồng TradingView Live WebSocket theo từng tick, kèm fallback TradingView Scanner và Binance REST.
- **Phân cấp 5 mức (`Tier 0` → `Tier 3`):**
  - `Tier 0`: Giá chạm biên `BB Upper` hoặc `BB Lower`.
  - `Tier 1`: Giá khớp vùng entry mở rộng `BB Upper + ATR(14)` hoặc `BB Lower - ATR(14)`.
  - `Tier 2A`: Khớp `BB ± ATR` kết hợp `RSI(14)` quá mua/quá bán (`>= 70` / `<= 30`).
  - `Tier 2B`: Xuất hiện nến rút râu từ chối M5 (Pinbar `>= 45%` hoặc nến đảo chiều thuận màu `>= 25%`) tại biên BB.
  - `Tier 3 (VIP)`: Khớp `BB ± ATR` kết hợp nến rút râu từ chối M5 ngay tại mốc `BB ± ATR`.
- **Kiểm soát nhiễu & Quản trị rủi ro:** Bộ lọc râu chỉ kích hoạt từ phút thứ 4 của nến M5 (`>= 80%` thời lượng nến) hoặc trên nến vừa đóng (`prevCandle`); tự động tính Entry, SL (`1 ATR`), TP1 (`BB Middle`), TP2 (`R:R 1:2`) và hỗ trợ lọc Daily Trend Bias (`BUY_ONLY`, `SELL_ONLY`, `BOTH`).

### 2. SMC Order Blocks + Nadaraya-Watson Envelope (MTF — `TVC:GOLD`)

- **Nguồn dữ liệu:** Kết nối WebSocket đa khung trực tiếp `TVC:GOLD` (500 nến/khung cho `M5`, `M15`, `M30`, `H1`, `H4`, `D1`), công thức NWE chuẩn Pine Script v5 (`h=8, mult=3.0`) kèm fallback Binance.
- **Phân cấp 3 tầng:**
  - `Tier 1`: Chạm biên NWE hoặc vùng Supply/Demand Order Block trên từng khung đơn lẻ.
  - `Tier 2 (MTF Confluence)`: Chạm biên NWE `H1` đồng thời giao cắt ít nhất một Order Block thuộc `M15`, `M30`, `H1`, `H4` (ưu tiên khối chính `H4 > H1 > M30 > M15`).
  - `Tier 3 (VIP)`: Thỏa `Tier 2` kết hợp nến rút râu từ chối `M15` được lọc nhiễu theo `ATR(14)` khung M15 và quy tắc `>= 80%` thời lượng nến.

### 3. Tier SSS (Siêu hợp lưu) & CallMeBot Voice Alert

- **Điều kiện kích hoạt:** Tự động kích hoạt khi `BB+ATR M5 (Tier 3)` và `SMC+NWE M15 (Tier 3)` cùng xuất hiện theo một chiều trong cửa sổ 20 phút.
- **Hợp nhất kế hoạch lệnh:** Chọn SL an toàn hơn giữa hai hệ thống (`max` cho SELL, `min` cho BUY), `TP1 = BB Middle (M5)`, `TP2 = NWE H1 Kernel`, kèm cơ chế chống trùng theo cặp nến và cooldown 15 phút cùng chiều.
- **CallMeBot:** Tự động gọi điện báo thức bằng giọng nói tiếng Việt trên Telegram cho `TIER SSS` và `SMC Tier 3` (tự chống gọi đúp khi SMC Tier 3 nâng cấp lên `TIER SSS`).

---

## Tính năng bổ trợ

- **Cảnh báo giá (`/alert`):** Theo dõi chạm mốc giá cho Vàng và Crypto (chu kỳ 12s).
- **RSI Vàng đa khung (`/gold`, `/goldalert`):** Theo dõi `RSI(14)` trên 7 khung (`M1`–`D1`) với các ngưỡng `70/30`, `75/25`, `80/20` (chu kỳ 25s).
- **Lịch kinh tế vĩ mô (`/calendar`, `/settings`):** Lấy dữ liệu ForexFactory theo cơ chế Adaptive Fast Polling (4s trong khung giờ ra tin CPI/PPI/NFP/FOMC, 30s ngoài giờ tin).
- **MT5 EA Webhook:** Endpoint `POST /api/webhook/bbatr` tiếp nhận tín hiệu trực tiếp từ Expert Advisor trong `mt5/`.

---

## Kiến trúc vận hành & Khả năng chịu lỗi

- **WebSocket Resilience:** Watchdog kiểm tra mỗi 5s, gửi ping mỗi 15s, ngắt kết nối treo sau 35s không có dữ liệu và phát hiện clock-jump (`> 30s`); reconnect theo exponential backoff kèm jitter (`1s`–`30s`) và tự động đồng bộ nến + quét tín hiệu ngay sau khi nhận `timescale_update` đầu tiên.
- **Độ trễ thấp (Low-Latency Pipeline):** Cache danh sách subscriber trong RAM (đồng bộ tức thì khi người dùng đổi cấu hình), gửi Telegram trước rồi ghi log DB bất đồng bộ (`send-first, log-later`), kích hoạt quét SMC MTF theo sự kiện WebSocket (throttle 1s leading+trailing) kết hợp memoization cho `detectOrderBlocks` và gửi batch 25 người dùng/lượt với bộ đếm chính xác số tin gửi thành công.
- **Database Resilience:** `PrismaService` tự động thử lại tối đa 5 lần với cơ chế khóa chống reconnect song song (`$disconnect()` / `$connect()`) khi gặp lỗi `P1017`, `P1001`, `P1008`, `P2024`; mặc định tắt keep-alive (`DB_KEEPALIVE_INTERVAL_MS=0`) để tối ưu cho PostgreSQL serverless.

---

## Bảng lệnh Telegram

| Nhóm | Lệnh | Chức năng |
| :--- | :--- | :--- |
| **BB + ATR (M5)** | `/bbatr`, `/bb` | Xem bảng đo kỹ thuật M5, Entry/SL/TP, Bias và trạng thái Tier |
| | `/bbatr on`, `/bbatr off` | Bật / Tắt cảnh báo tự động XAU/USD M5 |
| | `/bbatr buy`, `sell`, `both` | Lọc hướng giao dịch trong ngày (Daily Bias) |
| | `/bbatr btc`, `/bbatr alert btc` | Xem bảng đo hoặc đặt cảnh báo BB+ATR cho mã khác |
| **NWE Envelope** | `/nwe`, `/envelope` | Mở bảng điều khiển NWE (`M5–D1`) và bật/tắt từng khung |
| | `/nwe h1`, `/nwe on`, `/nwe off` | Xem nhanh khung H1 hoặc bật/tắt cảnh báo NWE |
| **Order Blocks (SMC)** | `/ob`, `/smc`, `/orderblock` | Mở bảng điều khiển Supply/Demand OB (`M5–D1`) |
| | `/ob m15`, `/ob on`, `/ob off` | Xem nhanh OB khung M15 hoặc bật/tắt cảnh báo OB |
| **Tier 3 (VIP)** | `/tier3`, `/tier2`, `/sweep` | Bật / Tắt riêng cảnh báo Tier 3 VIP |
| **Gọi báo thức** | `/testcall`, `/testcall smc` | Kiểm tra kết nối gọi điện báo thức qua CallMeBot |
| **Cảnh báo giá** | `/alert <mã> <giá>`, `/alerts` | Tạo và quản lý cảnh báo chạm giá |
| **RSI Vàng** | `/gold`, `/goldalert` | Xem bảng RSI 7 khung và cấu hình ngưỡng |
| **Kinh tế vĩ mô** | `/calendar`, `/settings` | Xem lịch ForexFactory hôm nay và chọn mức độ tin |
| **Trợ giúp** | `/start`, `/help` | Xem hướng dẫn sử dụng |

---

## Tài liệu tham khảo

- [TIER_SYSTEM.md](TIER_SYSTEM.md) — Đặc tả chi tiết các Tier và công thức lọc râu.
- [COMMANDS.md](COMMANDS.md) — Danh sách đầy đủ câu lệnh và hướng dẫn thao tác.
- [CALLMEBOT_SETUP.md](CALLMEBOT_SETUP.md) — Hướng dẫn cấu hình gọi điện báo thức qua CallMeBot.
