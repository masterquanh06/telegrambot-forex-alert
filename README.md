# 🤖 Telegram Forex & Financial Alert Bot

Bot Telegram phân tích kỹ thuật thời gian thực và cảnh báo giao dịch chuyên biệt cho **Vàng (`XAU/USD`)**, **Crypto (`BTC`, `ETH`, `SOL`, ...)** và **Tin tức Kinh tế Vĩ mô**, xây dựng trên nền tảng **NestJS + TypeScript + Prisma (PostgreSQL) + Telegraf**.

Hệ thống sở hữu **Pure Signal Engines** độc lập (dễ kiểm thử & backtest), phân cấp cảnh báo rõ ràng theo **Tier System** cho cả 2 chiến lược cốt lõi **BB+ATR (M5)** và **SMC+NWE Chéo Khung (H1 + OB đa khung + M15)**.

---

## 🚀 Các tính năng & Chiến lược cốt lõi

### 1. 🎯 Chiến lược Bollinger Bands (20) + ATR (14) + RSI (14) — Khung M5
* **Nguồn giá thời gian thực:** Kết nối trực tiếp **TradingView Live WebSocket (`OANDA:XAUUSD`, 0ms latency)** kèm fallback TradingView Scanner và Binance REST.
* **Hệ thống phân cấp 5 mức (Pure Engine `src/indicator/signal-classifier.ts`):**
  * 🔔 **Tier 0:** Chạm dải `BB Upper` / `BB Lower` thông thường.
  * 🔥 **Tier 1:** Khớp vùng Entry mở rộng `BB Upper + ATR(14)` / `BB Lower - ATR(14)`.
  * 🔥🔥 **Tier 2A:** Khớp `BB ± ATR` **+** `RSI(14)` cực trị (`>= 70` / `<= 30`).
  * 🔥🔥 **Tier 2B:** Xuất hiện **nến rút râu từ chối M5** (Pinbar ≥ 45% hoặc nến đảo chiều thuận màu ≥ 25%) ngay tại biên `BB Upper` / `BB Lower`.
  * 🔥🔥🔥 **Tier 3 (VIP):** Khớp `BB ± ATR` **+** **nến rút râu từ chối M5** ngay tại mốc `BB ± ATR`.
* **Chống rút râu ảo & Quản trị rủi ro:** Chỉ kích hoạt bộ lọc râu từ **phút thứ 4 trở đi (≥ 80% thời gian nến M5)** hoặc trên nến vừa đóng (`prevCandle`), tự động tính Entry, SL (`= 1 ATR`), TP1 (`BB Middle`), TP2 (`1:2 R:R`) và hỗ trợ lọc Daily Trend Bias (`BUY_ONLY`, `SELL_ONLY`, `BOTH`).

### 2. 🌊 SMC Order Blocks + Nadaraya-Watson Envelope (NWE) — Hợp lưu Chéo Khung (MTF)
* **Nguồn dữ liệu chuẩn TradingView:** Kết nối 1 WebSocket đa khung trực tiếp `TVC:GOLD` (500 nến/khung cho `M5, M15, M30, H1, H4, D1`, 0ms latency) với công thức NWE khớp chính xác Pine Script v5 (`h=8, mult=3.0`, repainting 500 bars), kèm fallback Binance.
* **Hệ thống 3 tầng đồng bộ (Pure Engine `src/smc/smc-mtf-classifier.ts`):**
  * 🔔 **Tier 1:** Chạm NWE đơn lẻ hoặc OB đơn lẻ trên từng khung.
  * 🔥🔥 **Tier 2 (MTF Confluence):** Chạm biên **NWE H1** **ĐỒNG THỜI** giao cắt ≥ 1 khối **Order Block** từ các khung **`M15`, `M30`, `H1`, `H4`** (ưu tiên khối chính `H4 > H1 > M30 > M15`, tự động chống trùng với hợp lưu đơn khung H1).
  * 🔥🔥🔥 **Tier 3 (VIP):** Thỏa Tier 2 **+** xuất hiện **nến rút râu từ chối khung M15** (`detectZoneRejectionWick` lọc theo **`ATR(14)` M15** — hỗ trợ bắt râu ngay trong lòng OB rộng miễn không phá vỡ mép ngoài `ob.top`/`ob.bottom`, chống rút râu ảo ≥ phút thứ 12 của nến M15).

### 2B. 👑💎🔥🔥🔥 TIER SSS — Siêu Hợp Lưu Tối Thượng
* Tự động kích hoạt qua `SuperTierService` (`src/common/super-tier.service.ts` + pure engine `src/indicator/super-tier-classifier.ts`) khi **cả `BB+ATR M5 (Tier 3)` và `SMC+NWE M15 (Tier 3)` cùng xuất hiện 1 chiều trong cửa sổ 20 phút**.
* Hợp nhất kế hoạch vào lệnh: **SL an toàn nhất** (`max` cho SELL / `min` cho BUY giữa 2 hệ thống), **TP1 (`BB Middle M5`)**, **TP2 (`NWE H1 Kernel`)**, kèm khóa chống trùng theo cặp nến và cooldown 15 phút cùng chiều.

### 3. 🔔 Cảnh báo Giá, 🟡 RSI Vàng Đa Khung & 📰 Kinh tế Vĩ mô
* **Price Alert (`/alert`):** Cảnh báo chạm mốc giá mục tiêu tức thì cho Vàng và Crypto (Cron 12s).
* **RSI Vàng 7 khung (`/gold`, `/goldalert`):** Theo dõi `RSI(14)` từ `M1` đến `D1` với các ngưỡng tùy chỉnh `70/30`, `75/25`, `80/20` (Cron 25s).
* **Lịch Kinh tế ForexFactory (`/calendar`, `/settings`):** Cơ chế **Adaptive Fast Polling** (4 giây/lần vào giờ ra tin CPI, PPI, NFP, FOMC; 30 giây/lần ngoài giờ tin).

### 4. 📈 Tích hợp MetaTrader 5 EA & Webhook
* Endpoint `POST /api/webhook/bbatr` nhận tín hiệu tức thì từ bộ EA trong thư mục `mt5/` (`BB_ATR_Live_Alert.mq5` và `BB_ATR_AutoTrader.mq5`).

### 5. 🛡️ An toàn vận hành
* **Chống Race Condition:** Mutex lock cho các vòng quét BB+ATR (WebSocket vs Cron 3s) và SMC/NWE (Cron 15s).
* **Chống bắn trùng nến rút râu:** Khóa theo `(rejectionCandleTime, alertTier)` — cho phép nâng cấp Tier trên cùng cây nến nhưng không lặp lại khi sang nến mới.
* **Broadcast Telegram song song:** Gửi theo batch **25 users/lượt** với `Promise.allSettled()` và log rõ từng `chatId` lỗi.

---

## 📋 Bảng câu lệnh nhanh

| Nhóm | Lệnh | Chức năng |
| :--- | :--- | :--- |
| **BB + ATR (M5)** | `/bbatr` (hoặc `/bb`) | Bảng đo kỹ thuật M5, Entry/SL/TP, Bias ngày & trạng thái Tier |
| | `/bbatr on` / `/bbatr off` | Bật / Tắt cảnh báo tự động XAU/USD M5 |
| | `/bbatr buy` / `sell` / `both` | Lọc hướng giao dịch trong ngày (Daily Bias) |
| | `/bbatr btc` / `/bbatr alert btc` | Xem bảng đo hoặc đặt cảnh báo BB+ATR cho mã khác |
| **NWE Envelope** | `/nwe` (hoặc `/envelope`) | Mở Dashboard NWE (`M5–D1`), bật/tắt từng khung |
| | `/nwe h1`, `/nwe on`, `/nwe off` | Xem nhanh khung H1 hoặc bật/tắt cảnh báo NWE |
| **Order Blocks (SMC)** | `/ob` (hoặc `/smc`, `/orderblock`) | Mở Dashboard Supply/Demand OB (`M5–D1`), bật/tắt từng khung |
| | `/ob m15`, `/ob on`, `/ob off` | Xem nhanh OB khung M15 hoặc bật/tắt cảnh báo OB |
| **Tier 3 (VIP)** | `/tier3` (hoặc `/tier2`, `/sweep`) | Bật / Tắt riêng cảnh báo Tier 3 VIP (Rút râu M5 & M15) |
| **Cảnh báo Giá** | `/alert <mã> <giá>` / `/alerts` | Đặt & quản lý cảnh báo chạm giá (VD: `/alert xau 3650`) |
| **RSI Vàng** | `/gold` / `/goldalert` | Xem bảng RSI 7 khung & cài đặt ngưỡng cảnh báo |
| **Kinh tế Vĩ mô** | `/calendar` / `/settings` | Xem lịch ForexFactory hôm nay & chọn mức độ tin (Cao/TB/Thấp) |
| **Trợ giúp** | `/start` / `/help` | Xem tổng quan hướng dẫn sử dụng bot |

---

## 🏗️ Cấu trúc mã nguồn chính

```text
src/
├── indicator/
│   ├── signal-classifier.ts          # Pure Engine BB+ATR (Tier 0/1/2A/2B/3) + detectM5RejectionWick + detectZoneRejectionWick
│   ├── bb-atr.service.ts             # TradingView WS, TV Scanner, Binance, Mutex, Batch Broadcast
│   └── bb-atr-webhook.controller.ts  # POST /api/webhook/bbatr (MT5 EA)
├── smc/
│   ├── smc-mtf-classifier.ts         # Pure Engine SMC+NWE Cross-TF (NWE H1 + OB M15/M30/H1/H4 + Rút râu M15)
│   └── smc.service.ts                # Quét đơn khung & MTF, chống trùng H1, Batch Broadcast
├── services/liquiditySweep.ts        # Module phân tích Liquidity Sweep (unit-tested)
├── gold/                             # Theo dõi & cảnh báo RSI Vàng 7 khung
├── alert/                            # Cảnh báo giá chạm tức thì (XAU & Crypto)
├── macro/                            # Lịch kinh tế vĩ mô ForexFactory (Adaptive Fast Polling)
├── cron/                             # Bộ lập lịch background intervals
└── telegram/                         # Telegraf commands, inline keyboards & dashboards
mt5/                                  # Expert Advisors (BB_ATR_Live_Alert.mq5, BB_ATR_AutoTrader.mq5)
prisma/schema.prisma                  # PostgreSQL schema (TelegramUser, BbAtrAlertLog, SmcAlertLog, ...)
test/                                 # Unit tests (bbTierAlert, smcMtfTier, liquiditySweep)
```

---

## 🛠️ Cài đặt, Build & Kiểm thử

```bash
# 1. Cài dependencies & generate Prisma client
npm install
npm run prisma:generate

# 2. Đồng bộ schema lên PostgreSQL
npm run prisma:push

# 3. Build TypeScript & chạy toàn bộ unit tests (36/36 tests)
npm run build
npm test

# 4. Khởi chạy bot
npm run start:dev   # Development
npm run start:prod  # Production
```

---

## 📚 Tài liệu chi tiết
* 🔥 **Giải thích toàn bộ các Tier ở mọi chiến lược & công thức lọc râu:** 👉 **[TIER_SYSTEM.md](TIER_SYSTEM.md)**
* 📖 **Danh sách đầy đủ câu lệnh, nút bấm & hướng dẫn sử dụng:** 👉 **[COMMANDS.md](COMMANDS.md)**
