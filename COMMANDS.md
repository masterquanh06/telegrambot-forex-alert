# 📖 BẢNG TỔNG HỢP TOÀN BỘ CÂU LỆNH & HƯỚNG DẪN SỬ DỤNG BOT TELEGRAM

> **Hệ thống Bot:** Cảnh báo Giao dịch Tài chính, Vĩ mô, Bollinger Bands (20) + ATR (14) + RSI (14), Nadaraya-Watson Envelope (NWE) & Smart Money Concepts (SMC Order Blocks Chéo Khung).  
> **Tài sản trọng tâm:** Vàng (`XAU/USD`), Crypto (`BTC`, `ETH`, `SOL`, ...), Ngoại hối & Tin tức Kinh tế Vĩ mô.  
> **Chi tiết công thức từng Tier:** Xem đầy đủ tại 👉 **[TIER_SYSTEM.md](TIER_SYSTEM.md)**

---

## 📑 MỤC LỤC
1. [Bảng tóm tắt nhanh toàn bộ câu lệnh](#1-bảng-tóm-tắt-nhanh-toàn-bộ-câu-lệnh)
2. [Chiến lược 1: Bollinger Bands (20) + ATR (14) + RSI (14) M5](#2-chiến-lược-1-bollinger-bands-20--atr-14--rsi-14-m5)
3. [Chiến lược 2: Nadaraya-Watson Envelope (NWE) + SMC Order Blocks Chéo Khung](#3-chiến-lược-2-nadaraya-watson-envelope-nwe--smc-order-blocks-chéo-khung)
4. [Công tắc VIP Tier 3 & Quyền nhận tin](#4-công-tắc-vip-tier-3--quyền-nhận-tin)
5. [Cảnh báo Giá chạm tức thì (Vàng & Crypto)](#5-cảnh-báo-giá-chạm-tức-thì-vàng--crypto)
6. [Theo dõi & Cài đặt Cảnh báo RSI Vàng đa khung](#6-theo-dõi--cài-đặt-cảnh-báo-rsi-vàng-đa-khung)
7. [Lịch Kinh tế Vĩ mô & Tin tức nóng (CPI / NFP / FED)](#7-lịch-kinh-tế-vĩ-mô--tin-tức-nóng-cpi--nfp--fed)
8. [MetaTrader 5 Expert Advisors (MT5 EA) & Webhook](#8-metatrader-5-expert-advisors-mt5-ea--webhook)

---

## 1. Bảng tóm tắt nhanh toàn bộ câu lệnh

| Nhóm tính năng | Câu lệnh chính | Bí danh / Lệnh viết tắt | Mô tả chức năng |
| :--- | :--- | :--- | :--- |
| **Hệ thống** | `/start` | `/help` | Hiển thị bảng chào mừng và danh sách tính năng tổng quan. |
| **BB + ATR (M5)** | `/bbatr` | `/bb`, `/bb_atr`, `/bba`, `/bollinger`, `/strat` | Mở Dashboard BB(20) + ATR(14) + RSI(14) M5, vùng Entry, SL, TP, Bias ngày. |
| | `/bbatr on` / `/bbatr off` | `/bb on`, `/bb off` | Bật hoặc tắt cảnh báo tự động XAU/USD M5 (Tier 0, 1, 2A, 2B). |
| | `/bbatr bias buy` | `/bbatr buy`, `/bb buy`, `/bb long`, `/bb mua` | Lọc Daily Bias: chỉ nhận chiều **BUY** (bỏ qua SELL). |
| | `/bbatr bias sell` | `/bbatr sell`, `/bb sell`, `/bb short`, `/bb ban` | Lọc Daily Bias: chỉ nhận chiều **SELL** (bỏ qua BUY). |
| | `/bbatr bias both` | `/bbatr both`, `/bb both`, `/bb all` | Nhận cả 2 chiều **BUY & SELL**. |
| | `/bbatr <mã> [khung]` | `/bb btc`, `/bb eth 15m` | Xem bảng đo BB+ATR cho mã Crypto/Vàng bất kỳ (`M1` đến `D1`). |
| | `/bbatr alert <mã> [khung]` | `/bb dat btc 15m` | Tạo cảnh báo BB+ATR cá nhân cho mã bất kỳ. |
| | `/bbatr list` | `/bb ds` | Xem danh sách cảnh báo BB+ATR cá nhân đang chạy. |
| | `/bbatr del <id>` / `all` | `/bb xoa <id>`, `/bb huy <id>` | Xóa 1 cảnh báo cá nhân theo ID hoặc xóa toàn bộ. |
| | `/bbatr help` | `/bb ?` | Xem hướng dẫn chiến lược & bảng Tier System BB+ATR. |
| **NWE Envelope** | `/nwe` | `/envelope` | Mở Dashboard riêng dải Nadaraya-Watson Envelope & Dynamic S/R (`M15` mặc định). |
| | `/nwe <khung>` | `/nwe m5`, `/nwe m15`, `/nwe h1`, `/nwe h4` | Xem thông số NWE Upper, Kernel, Lower theo khung cụ thể. |
| | `/nwe on` / `/nwe off` | | Bật / Tắt cảnh báo tự động NWE. |
| **Order Blocks (SMC)** | `/ob` | `/smc`, `/orderblock`, `/zone` | Mở Dashboard riêng SMC Order Blocks (Vùng Cung / Cầu Unmitigated). |
| | `/ob <khung>` | `/ob m5`, `/ob m15`, `/ob h1`, `/ob h4` | Xem các khối Supply/Demand OB còn hiệu lực theo khung. |
| | `/ob on` / `/ob off` | `/smc on`, `/smc off` | Bật / Tắt cảnh báo tự động Order Block. |
| **VIP Tier 3** | `/tier3` | `/tier2`, `/sweep`, `/sfp` | Bật / Tắt riêng cảnh báo **Tier 3 VIP** (Rút râu M5 của BB+ATR & Rút râu M15 của SMC+NWE). |
| **Cảnh báo Giá** | `/alert <mã> <giá>` | `/canhbao`, `/pricealert` | Đặt cảnh báo chạm giá tức thì (VD: `/alert xau 3650`, `/alert btc 95k`). |
| | `/alerts` | `/alert list`, `/dsalert` | Xem và quản lý các cảnh báo giá đang chờ khớp. |
| | `/alert del <id>` | `/alert remove <id>`, `/alert xoa <id>` | Hủy 1 cảnh báo giá theo ID. |
| | `/alert clear` | `/alert del all` | Hủy toàn bộ cảnh báo giá đang chờ. |
| **RSI Vàng** | `/gold` | `/xau`, `/vang`, `/goldrsi`, `/xaursi` | Xem bảng giá Vàng & chỉ số RSI(14) 7 khung (`M1` đến `D1`). |
| | `/goldalert` | `/xaualert`, `/goldsetting`, `/goldsettings` | Cài đặt bật/tắt khung & bộ ngưỡng RSI (`70/30`, `75/25`, `80/20`). |
| **Kinh tế Vĩ mô** | `/calendar` | `/macro`, `/forex` | Xem lịch kinh tế ForexFactory hôm nay (giờ Việt Nam). |
| | `/settings` | `/macro_settings`, `/macrosetting`, `/setting` | Chọn mức độ tin tức muốn nhận: 🔴 Cao, 🟠 Trung bình, 🟡 Thấp. |

---

## 2. Chiến lược 1: Bollinger Bands (20) + ATR (14) + RSI (14) M5

Chiến lược đo lực kiệt sức (Exhaustion) trên khung **M5** sử dụng dữ liệu **TradingView Live WebSocket (`OANDA:XAUUSD`, 0ms latency)** kết hợp TradingView Scanner và Binance fallback.

### 📐 Công thức cơ bản
* **Bollinger Bands (20, 2):** `Middle = SMA(20)`, `Upper = Middle + 2σ`, `Lower = Middle - 2σ`.
* **ATR(14) & RSI(14):** Wilder's Smoothing.
* **Vùng Entry mở rộng:**
  - 🔴 **Sell Entry:** `BB Upper + ATR(14)` → **SL:** `Sell Entry + ATR(14)`
  - 🟢 **Buy Entry:** `BB Lower - ATR(14)` → **SL:** `Buy Entry - ATR(14)`
  - **TP1:** `BB Middle` | **TP2:** Tỷ lệ `1:2 R:R`.

### 🔥 Hệ thống phân cấp 5 mức (Tier 0 → Tier 3 VIP)
* 🔔 **Tier 0:** Chạm dải `BB Upper` / `BB Lower` thông thường.
* 🔥 **Tier 1:** Khớp vùng Entry mở rộng `BB Upper + ATR` (SELL) hoặc `BB Lower - ATR` (BUY).
* 🔥🔥 **Tier 2A:** Khớp `BB ± ATR` **VÀ** `RSI(14) >= 70` (SELL) hoặc `RSI(14) <= 30` (BUY).
* 🔥🔥 **Tier 2B:** Xuất hiện **nến rút râu từ chối M5** (Pinbar hoặc nến đảo chiều thuận màu) ngay tại biên `BB Upper` / `BB Lower` *(không bắt buộc phải chạm `BB ± ATR`; Entry tại biên BB, SL = 1 ATR từ biên BB)*.
* 🔥🔥🔥 **Tier 3 (VIP):** Khớp `BB ± ATR` **VÀ** xuất hiện **nến rút râu từ chối M5** ngay tại mốc `BB ± ATR`.

> Chi tiết công thức lọc nến rút râu M5 (`totalRange >= 0.5 ATR`, `wick >= 0.25 ATR`, `closePos`, Dạng A/B, chống rút râu ảo ≥ 80% thời gian nến M5) xem tại **[TIER_SYSTEM.md](TIER_SYSTEM.md)**.

### 🎛 Các nút bấm trên Dashboard `/bbatr`
* `🔄 Làm Mới Dữ Liệu` | `🔔 Bật / 🔕 Tắt Cảnh Báo XAU M5`
* Bộ lọc Daily Bias: `🟢 Chỉ Buy` | `🔴 Chỉ Sell` | `⚖️ Cả 2 chiều`
* Đổi khung xem nhanh: `M5` | `M15` | `H1` | `H4`
* `🔥 Tier 3 (Rút Râu M5): ✅ BẬT / ❌ TẮT` | `ℹ️ Hướng Dẫn`

---

## 3. Chiến lược 2: Nadaraya-Watson Envelope (NWE) + SMC Order Blocks Chéo Khung

Kết hợp đường hồi quy hạt nhân **Gaussian Kernel Regression** (`h=8, mult=3.0`) với các khối **Order Block (Supply / Demand)** chưa bị triệt tiêu theo **hệ thống 3 tầng đồng bộ**:

### 🔥 Hệ thống 3 tầng SMC + NWE
* 🔔 **Tier 1 (Đơn khung):** Chạm biên NWE đơn lẻ hoặc chạm khối OB đơn lẻ trên từng khung `M5, M15, M30, H1, H4, D1`.
* 🔥🔥 **Tier 2 (MTF Confluence — Hợp lưu Chéo Khung):**
  - Giá chạm dải biên **NWE khung H1** (`Upper Band` / `Lower Band`) **ĐỒNG THỜI** giao cắt ít nhất 1 khối **Order Block** chưa triệt tiêu thuộc các khung **`M15`, `M30`, `H1`, `H4`**.
  - Nếu giao cắt nhiều OB cùng lúc, bot liệt kê tất cả các khối và ưu tiên khối khung lớn nhất làm khối chính (`H4 > H1 > M30 > M15`).
  - Tự động chống bắn trùng với cảnh báo hợp lưu đơn khung `H1` cũ.
* 🔥🔥🔥 **Tier 3 (VIP — MTF + Nến Rút Râu Khung M15):**
  - Thỏa điều kiện Tier 2 **VÀ** xuất hiện **nến rút râu từ chối khung M15** (lọc theo **`ATR(14)` khung M15**).
  - Cho phép xác nhận rút râu ngay **bên trong lòng OB rộng** (miễn giá đóng nến không phá vỡ `ob.top` với SELL / `ob.bottom` với BUY), kèm bộ lọc chống rút râu ảo (≥ phút thứ 12 của nến M15 hoặc nến M15 vừa đóng).

### 🎛 2 bảng Dashboard độc lập trên Telegram
* **Dashboard NWE (`/nwe`):** Chọn khung xem (`M5, M15, H1, H4, D1`), bật/tắt nhận tin riêng từng khung (`M5–D1`), nút `🔥 Tier 3 (Rút Râu M15)`, nút `ℹ️ Hướng Dẫn NWE`.
* **Dashboard Order Blocks (`/ob`):** Hiển thị danh sách Supply/Demand OB chưa triệt tiêu và khoảng cách hiện tại, bật/tắt nhận tin riêng từng khung (`M5–D1`), nút `🔥 Tier 3 (Rút Râu M15)`, nút `ℹ️ Hướng Dẫn OB`.

---

## 4. Công tắc VIP Tier 3 & Quyền nhận tin

* Lệnh `/tier3` (hoặc `/tier2`, `/sweep`, `/sfp`) bật/tắt riêng **cảnh báo VIP Tier 3** cho cả **BB+ATR (Rút râu M5)** lẫn **SMC+NWE (Rút râu M15)**.
* **Lưu ý quan trọng:**
  - Khi tắt `/bbatr off`, bot tắt cả cụm **Tier 0 + Tier 1 + Tier 2A + Tier 2B**, chỉ giữ lại **Tier 3 VIP** (nếu nút Tier 3 đang BẬT).
  - Bộ lọc Daily Bias (`/bbatr buy` / `sell`) áp dụng cho **Tier 0, 1, 2A, 2B**, không chặn **Tier 3 VIP**.

---

## 5. Cảnh báo Giá chạm tức thì (Vàng & Crypto)

```bash
/alert <MÃ> <GIÁ_MỤC_TIÊU>
```

* **Ví dụ:** `/alert xau 3650`, `/alert gold 3580.5`, `/alert btc 95k`, `/alert eth 3600`, `/alert sol 220`, `/alert pepe 0.000015`.
* **Quản lý:** `/alerts` (xem danh sách + nút xóa nhanh), `/alert del <ID>`, `/alert clear`.

---

## 6. Theo dõi & Cài đặt Cảnh báo RSI Vàng đa khung

* `/gold` (hoặc `/xau`): Bảng giá Vàng & chỉ số `RSI(14)` 7 khung `M1, M5, M15, M30, H1, H4, D1`.
* `/goldalert` (hoặc `/xaualert`): Bật/tắt master, chọn từng khung thời gian và chọn preset ngưỡng `70/30`, `75/25` hoặc `80/20`.

---

## 7. Lịch Kinh tế Vĩ mô & Tin tức nóng (CPI / NFP / FED)

* `/calendar` (hoặc `/macro`): Lịch sự kiện kinh tế hôm nay (giờ Việt Nam) kèm số liệu `Actual / Forecast / Previous`.
* `/settings`: Chọn mức độ ảnh hưởng muốn nhận thông báo: 🔴 Cao (`High`), 🟠 Trung bình (`Medium`), 🟡 Thấp (`Low`).
* **Adaptive Fast Polling:** Tự động tăng tốc quét lên **4 giây/lần** khi sắp đến giờ công bố tin quan trọng (30 giây/lần ngoài khung giờ tin).

---

## 8. MetaTrader 5 Expert Advisors (MT5 EA) & Webhook

Endpoint nhận tín hiệu trực tiếp từ MT5: `POST /api/webhook/bbatr` (`src/indicator/bb-atr-webhook.controller.ts`).

Thư mục `mt5/` đi kèm 2 EA:
1. **`mt5/BB_ATR_Live_Alert.mq5`**: Tính BB(20), ATR(14), RSI(14) trực tiếp theo báo giá sàn MT5 của bạn và bắn Webhook HTTP POST về Telegram Bot với độ trễ 0ms.
2. **`mt5/BB_ATR_AutoTrader.mq5`**: EA tự động hóa giao dịch theo chiến lược BB+ATR (tính Lot theo % rủi ro, đặt SL = 1 ATR, TP1/TP2, Trailing/Breakeven) và bắn thông báo khớp lệnh qua Webhook về Telegram.

---

## ⚙️ Cơ chế vận hành & An toàn hệ thống
* **Pure Signal Engines:** Toàn bộ logic phân loại Tier của BB+ATR (`src/indicator/signal-classifier.ts`) và SMC+NWE (`src/smc/smc-mtf-classifier.ts`) được tách thành pure functions độc lập, sẵn sàng cho unit test và backtest.
* **Chống Race Condition:** Khóa Mutex cho cả vòng quét BB+ATR (WebSocket vs Cron 3s) và vòng quét SMC/NWE (Cron 15s).
* **Broadcast song song:** Gửi tin nhắn Telegram theo batch **25 users/lượt** bằng `Promise.allSettled()`, loại bỏ nghẽn cổ chai khi đông người dùng.
* **Chịu lỗi DB:** Lưu cấu hình & lịch sử cảnh báo trên PostgreSQL qua Prisma ORM kèm retry tự động và bộ nhớ đệm In-Memory fallback.
