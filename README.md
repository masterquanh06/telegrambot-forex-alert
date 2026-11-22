# 🤖 Telegram Forex & Financial Alert Bot

Bot Telegram thông minh chuyên biệt cho giao dịch **Vàng (XAU/USD)**, **Ngoại hối (Forex)**, **Tiền mã hóa (Crypto)** và **Tin tức Kinh tế Vĩ mô**.

Hệ thống tích hợp các thuật toán phân tích kỹ thuật thời gian thực, tự động phát hiện các vùng giá kiệt sức, khối lệnh tổ chức và các cú săn thanh khoản của thị trường.

---

## 🚀 Tính năng nổi bật

### 1. 🔥 Quét Thanh Khoản (True Liquidity Sweep / SFP) & Phân cấp Alert
* **Xác định Bể Thanh Khoản (Liquidity Pools):** Quét cấu trúc đỉnh/đáy Pivot (`left = 5`, `right = 5`) trên khung M15 để bắt các mức thanh khoản **BSL (Buy-side)** và **SSL (Sell-side)**.
* **Lọc Equal Highs / Lows (EQH/EQL):** Tự động phát hiện các vùng 2 đỉnh hoặc 2 đáy có mức giá sát nhau ($\le 0.2 \times ATR$) và đánh dấu là Bể thanh khoản lớn.
* **Xác nhận cú quét thật:** Giá đâm thủng mức cản/đỡ nhưng rút râu mạnh ($\ge 40\%$ chiều dài nến) đóng cửa ngược vào trong, với độ sâu quét chuẩn $0.1 - 1.5 \times ATR$.
* **Phân cấp cảnh báo (Tiered Alert System):**
  - **Tier 1 (Tín hiệu Chuẩn):** Khi giá chạm vùng kỹ thuật thông thường của chiến lược.
  - **Tier 2 (🔥 HIGH PROBABILITY):** Khi tín hiệu xuất hiện đồng thời với cú quét thanh khoản thật, kèm mức Stop Loss tối ưu ngay sau râu nến quét.

### 2. 🎯 Chiến lược Bollinger Bands (20) + ATR (14) Khung M5
* **Tín hiệu đồng pha M5:** Tự động quét và cảnh báo khi giá nến M5 chạm/thủng dải Bands Upper/Lower kết hợp bộ lọc chỉ báo $RSI \ge 70$ (Quá mua) hoặc $RSI \le 30$ (Quá bán).
* **Quản trị rủi ro tự động:** Tính toán tự động điểm Buy/Sell Entry mở rộng ($\pm 1 \times ATR$), Stop Loss cố định ($1 \times ATR$) và 2 mốc Take Profit (TP1 tại Bands Middle, TP2 theo tỷ lệ R:R chuẩn 1:2).
* **Bộ lọc xu hướng ngày (Daily Bias):** Tùy chọn chỉ canh BUY, chỉ canh SELL hoặc nhận cả 2 chiều.

### 3. 🌊 Nadaraya-Watson Envelope (NWE) & SMC Order Blocks (Cung / Cầu)
* **Hồi quy hạt nhân Gauss (Gaussian Kernel Regression):** Tính toán dải bao bọc động ($h=8, \text{mult}=3.0$) chuẩn xác theo TradingView LuxAlgo.
* **Smart Money Concepts (SMC):** Tự động định vị các khối **Bullish Order Block (Vùng Cầu / Demand)** và **Bearish Order Block (Vùng Cung / Supply)** chưa bị triệt tiêu (Unmitigated).
* **Hợp lưu siêu mạnh (Super Confluence):** Cảnh báo đặc biệt khi giá chạm đồng thời biên dải NWE và khối Order Block.
* **Đa khung thời gian:** Hỗ trợ đầy đủ các khung: `M5`, `M15`, `M30`, `H1`, `H4`, `D1` với giao diện nút bấm bật/tắt độc lập.

### 4. 🔔 Cảnh báo Giá chạm tức thì (Price Alert)
* Đặt cảnh báo giá thị trường chạm mốc kỳ vọng cho Vàng (XAU/USD) và các cặp Crypto (BTC, ETH, SOL, v.v.).

### 5. 🟡 Theo dõi & Cảnh báo RSI Vàng Đa Khung
* Giám sát liên tục chỉ số $RSI(14)$ trên 7 khung thời gian (`M1` đến `D1`), tùy chỉnh các bộ ngưỡng cảnh báo Quá Mua / Quá Bán (`70/30`, `75/25`, `80/20`).

### 6. 📰 Lịch Kinh tế Vĩ mô & Tin tức Tức thì
* Kết nối lịch kinh tế ForexFactory với cơ chế Adaptive Fast Polling (tăng tốc độ quét mỗi 3-4 giây khi bước vào giờ ra tin CPI, PPI, Non-Farm Payrolls, Lãi suất FED...).

### 7. 📈 MetaTrader 5 Expert Advisors (MT5 EA)
* Bộ mã nguồn EA chuyên dụng trong thư mục `mt5/` hỗ trợ hiển thị trực quan các mức Entry/SL/TP và tự động hóa giao dịch trên nền tảng MT5.

---

## 📋 Bảng tổng hợp câu lệnh nhanh

| Nhóm | Lệnh | Chức năng |
| :--- | :--- | :--- |
| **NWE Envelope** | `/nwe` (hoặc `/envelope`) | Mở Dashboard riêng dải Nadaraya-Watson Envelope & Dynamic S/R |
| | `/nwe m5`, `/nwe m15`, `/nwe h1` | Xem dải biên NWE Upper, Kernel, Lower cho từng khung |
| | `/nwe on` / `/nwe off` | Bật / Tắt nhanh cảnh báo tự động NWE |
| **Order Blocks (SMC)** | `/ob` (hoặc `/smc`, `/orderblock`) | Mở Dashboard riêng SMC Order Blocks (Vùng Cung - Cầu) |
| | `/ob m5`, `/ob m15`, `/ob h1` | Xem các vùng Supply & Demand chưa triệt tiêu (Unmitigated) |
| | `/ob on` / `/ob off` | Bật / Tắt nhanh cảnh báo tự động Order Block |
| **Tier 3 (VIP)** | `/tier3` (hoặc `/tier2`, `/sweep`) | Bật / Tắt riêng cảnh báo Quét Thanh Khoản VIP (🔥🔥🔥) |
| **BB + ATR (M5)** | `/bbatr` (hoặc `/bb`) | Mở bảng đo kỹ thuật M5, vùng Entry Buy/Sell, SL, TP, Bias ngày |
| | `/bbatr on` / `/bbatr off` | Bật / Tắt nhận cảnh báo tự động XAU/USD M5 |
| | `/bbatr bias buy` / `sell` / `both` | Lọc hướng giao dịch: Chỉ Buy, Chỉ Sell hoặc Cả 2 chiều |
| | `/bbatr btc` / `/bbatr alert btc` | Xem hoặc đặt cảnh báo BB+ATR riêng cho coin khác |
| **Cảnh báo Giá** | `/alert <mã> <giá>` | Đặt cảnh báo giá chạm (VD: `/alert xau 4200`, `/alert btc 95000`) |
| | `/alerts` | Quản lý danh sách cảnh báo giá đang chờ khớp |
| | `/alert del <id>` / `/alert clear` | Hủy 1 cảnh báo theo ID hoặc hủy toàn bộ |
| **RSI Vàng** | `/gold` (hoặc `/xau`) | Bảng giá và chỉ số RSI 7 khung thời gian (M1 đến D1) |
| | `/goldalert` (hoặc `/xaualert`) | Cài đặt cảnh báo Quá Mua / Quá Bán Vàng |
| **Kinh tế Vĩ mô** | `/calendar` (hoặc `/macro`) | Lịch sự kiện kinh tế ForexFactory hôm nay |
| | `/settings` | Cài đặt bộ lọc tin tức theo mức độ: 🔴 Cao, 🟠 Trung bình, 🟡 Thấp |
| **Trợ giúp** | `/start` / `/help` | Xem bảng hướng dẫn tổng quan |

---

## 📖 Hướng dẫn chi tiết & Công thức kỹ thuật
Xem tài liệu hướng dẫn đầy đủ, nguyên lý hoạt động và công thức toán học tại:  
👉 **[COMMANDS.md](COMMANDS.md)**
