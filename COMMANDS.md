# 📖 BẢNG TỔNG HỢP TOÀN BỘ CÂU LỆNH & HƯỚNG DẪN SỬ DỤNG BOT TELEGRAM

> **Hệ thống Bot:** Cảnh báo Giao dịch Tài chính, Vĩ mô, Bollinger Bands (20) + ATR (14), Nadaraya-Watson Envelope & Smart Money Concepts (Order Blocks / Cung Cầu).  
> **Tài sản trọng tâm:** Vàng (XAU/USD), Crypto (BTC, ETH, SOL, v.v.), Ngoại hối & Tin tức Kinh tế Vĩ mô.

---

## 📑 MỤC LỤC
1. [Bảng tóm tắt nhanh toàn bộ câu lệnh](#1-bảng-tóm-tắt-nhanh-toàn-bộ-câu-lệnh)
2. [Chiến lược 1: Bollinger Bands (20) + ATR (14) M5](#2-chiến-lược-1-bollinger-bands-20--atr-14-m5)
3. [Chiến lược 2: Nadaraya-Watson Envelope + SMC Order Blocks (Cung/Cầu)](#3-chiến-lược-2-nadaraya-watson-envelope--smc-order-blocks-cungcầu)
4. [Hệ thống Phân cấp Cảnh báo: Tier 1 vs Tier 2 (Quét Thanh Khoản)](#4-hệ-thống-phân-cấp-cảnh-báo-tier-1-vs-tier-2-quét-thanh-khoản)
5. [Cảnh báo Giá chạm tức thì (Vàng & Crypto)](#5-cảnh-báo-giá-chạm-tức-thì-vàng--crypto)
6. [Theo dõi & Cài đặt Cảnh báo RSI Vàng đa khung](#6-theo-dõi--cài-đặt-cảnh-báo-rsi-vàng-đa-khung)
7. [Lịch Kinh tế Vĩ mô & Tin tức nóng (CPI / NFP / FED)](#7-lịch-kinh-tế-vĩ-mô--tin-tức-nóng-cpi--nfp--fed)
8. [Expert Advisor trên MetaTrader 5 (MT5 EA)](#8-expert-advisor-trên-metatrader-5-mt5-ea)

---

## 1. Bảng tóm tắt nhanh toàn bộ câu lệnh

| Nhóm tính năng | Câu lệnh chính | Lệnh viết tắt / Bí danh | Mô tả chức năng |
| :--- | :--- | :--- | :--- |
| **Hệ thống** | `/start` | `/help` | Hiển thị bảng chào mừng và hướng dẫn tổng quan toàn bộ bot. |
| **BB + ATR (M5)** | `/bbatr` | `/bb`, `/bb_atr`, `/bba`, `/bollinger`, `/strat` | Mở bảng đo kỹ thuật BB(20) + ATR(14) M5, giá Entry, SL, TP, Bias ngày. |
| | `/bbatr on` / `/bbatr off` | | Bật hoặc tắt nhận cảnh báo tự động XAU/USD M5. |
| | `/bbatr bias buy` | `/bb buy` | Lọc chỉ nhận cảnh báo Mua (Buy), bỏ qua chiều Bán. |
| | `/bbatr bias sell` | `/bb sell` | Lọc chỉ nhận cảnh báo Bán (Sell), bỏ qua chiều Mua. |
| | `/bbatr bias both` | `/bb both` | Bật cảnh báo cả 2 chiều Mua & Bán. |
| | `/bbatr <mã> [khung]` | `/bb btc`, `/bb eth 15m` | Xem bảng đo BB+ATR cho coin/tài sản bất kỳ. |
| | `/bbatr alert <mã>` | | Đặt cảnh báo cá nhân riêng cho mã bất kỳ. |
| | `/bbatr list` | | Xem danh sách các cảnh báo BB+ATR cá nhân. |
| | `/bbatr del <id>` | | Xóa một cảnh báo cá nhân theo mã ID. |
| | `/bbatr clear` | | Xóa toàn bộ cảnh báo BB+ATR cá nhân của bạn. |
| **NWE + SMC (Cung/Cầu)** | `/smc` | `/nwe`, `/ob`, `/orderblock`, `/zone` | Mở menu cài đặt Bật/Tắt NWE & SMC đa khung thời gian (`M5` đến `D1`). |
| | `/smc <khung>` | `/smc m5`, `/smc m15`, `/smc h1` | Xem bảng phân tích NWE (Upper, Kernel, Lower) & Order Blocks gần nhất. |
| | `/smc on` | | Bật nhận tất cả cảnh báo NWE & SMC trên mọi khung thời gian. |
| | `/smc off` | | Tắt tạm thời toàn bộ cảnh báo NWE & SMC. |
| **Cảnh báo Giá tức thì** | `/alert <mã> <giá>` | `/canhbao`, `/pricealert` | Đặt cảnh báo giá thị trường chạm mốc kỳ vọng (VD: `/alert xau 4200`). |
| | `/alerts` | `/alert list`, `/dsalert` | Quản lý danh sách cảnh báo giá đang hoạt động của bạn. |
| | `/alert del <id>` | `/alert remove <id>` | Hủy một cảnh báo giá theo ID (VD: `/alert del 2`). |
| | `/alert clear` | `/alert del all` | Hủy toàn bộ cảnh báo giá đang chờ của bạn. |
| **RSI Vàng (XAU/USD)** | `/gold` | `/xau`, `/vang`, `/goldrsi`, `/xaursi` | Xem bảng giá Vàng live và chỉ số RSI đa khung từ M1 đến D1. |
| | `/goldalert` | `/xaualert`, `/goldsetting` | Mở menu cài đặt Bật/Tắt cảnh báo Quá Mua / Quá Bán RSI Vàng. |
| **Kinh tế Vĩ mô** | `/calendar` | `/macro`, `/forex` | Xem lịch sự kiện kinh tế vĩ mô hôm nay (ForexFactory). |
| | `/settings` | `/macro_settings`, `/setting` | Cài đặt bộ lọc nhận tin vĩ mô theo mức độ: 🔴 Đỏ, 🟠 Cam, 🟡 Vàng. |

---

## 2. Chiến lược 1: Bollinger Bands (20) + ATR (14) M5

Chiến lược bám sát hành vi kiệt sức của giá tại biên dao động kết hợp với biên độ trung bình thực tế ATR.

### 📐 Công thức toán học
* **Đường trung tâm (Middle Band):** $SMA(20)$
* **Dải trên (Upper Band):** $SMA(20) + 2 \times \sigma$
* **Dải dưới (Lower Band):** $SMA(20) - 2 \times \sigma$
* **Điểm vào lệnh Bán (Sell Entry):** $\text{Bands}(20)\text{ Upper} + \text{ATR}(14)$
* **Điểm vào lệnh Mua (Buy Entry):** $\text{Bands}(20)\text{ Lower} - \text{ATR}(14)$
* **Mức Cắt Lỗ (Stop Loss - SL):** Cố định bằng $1 \times \text{ATR}(14)$ từ điểm Entry.
* **Mức Chốt Lời (Take Profit - TP):**
  - **TP1:** Đường trục giữa Bollinger Bands Middle ($SMA(20)$).
  - **TP2:** Tỷ lệ R:R chuẩn $1:2$ so với khoảng cách SL.

### 🎯 Điều kiện nến phát tín hiệu cảnh báo
* **Khung thời gian:** 5 Phút (M5).
* **Tín hiệu BUY:** Giá nến M5 chạm/thủng dải Bands Lower **ĐỒNG THỜI** $RSI \le 30$.
* **Tín hiệu SELL:** Giá nến M5 chạm/vượt dải Bands Upper **ĐỒNG THỜI** $RSI \ge 70$.

### ⌨️ Các lệnh điều khiển
* `/bbatr` hoặc `/bb`: Mở dashboard chiến lược khung M5.
* `/bbatr on`: Bật nhận cảnh báo tự động.
* `/bbatr off`: Tắt nhận cảnh báo.
* `/bbatr bias buy`: Chỉ lọc kèo BUY.
* `/bbatr bias sell`: Chỉ lọc kèo SELL.
* `/bbatr bias both`: Nhận cả 2 chiều.
* `/bbatr btc`: Xem bảng đo BB+ATR cho Bitcoin M5.
* `/bbatr alert eth 15m`: Đặt cảnh báo riêng cho ETH khung 15m.
* `/bbatr list`: Xem danh sách cảnh báo cá nhân.
* `/bbatr del 3`: Xóa cảnh báo cá nhân mang số ID 3.

---

## 3. Chiến lược 2: Nadaraya-Watson Envelope + SMC Order Blocks (Cung/Cầu)

Chiến lược kết hợp toán học làm mượt phi tuyến tính (Kernel Regression) với trường phái Dòng Tiền Thông Minh (Smart Money Concepts).

### 📐 Thuật toán áp dụng
1. **Nadaraya-Watson Envelope (NWE)** ($h=8, \text{mult}=3.0$):
   - Đường cong trung tâm được tính bằng trọng số Kernel Gaussian:
     $$w_i = \exp\left(-\frac{i^2}{2h^2}\right)$$
   - Biên bao ngoài tính dựa trên độ lệch tuyệt đối trung bình ($MAE \times 3.0$).
   - **Dynamic S/R:** Tự động bắt các đỉnh dao động (Swing Highs) làm Kháng cự động và đáy dao động (Swing Lows) làm Hỗ trợ động.
2. **Order Blocks (SMC Demand & Supply)**:
   - **Vùng Cầu (Demand Zone / Bullish OB):** Khối nến giảm cuối cùng trước nhịp tăng mạnh phá vỡ cấu trúc đỉnh cũ.
   - **Vùng Cung (Supply Zone / Bearish OB):** Khối nến tăng cuối cùng trước nhịp giảm mạnh xả hàng phá vỡ đáy cũ.
   - **Lọc Unmitigated:** Tự động loại bỏ các khối OB đã bị giá triệt tiêu.
3. **Tín hiệu Hợp lưu Siêu cấp (Confluence Alert)**:
   - 🚨🟢🟢 **Hợp lưu MUA:** Giá chạm đồng thời **Dải dưới NWE** + **Vùng Cầu (Bullish OB)**.
   - 🚨🔴🔴 **Hợp lưu BÁN:** Giá chạm đồng thời **Dải trên NWE** + **Vùng Cung (Bearish OB)**.

### 🎛 Bảng Dashboard & Menu Cài Đặt Riêng Biệt (Tách biệt NWE và OB)

Hệ thống đã tách riêng thành 2 bảng Dashboard độc lập, trực quan và dễ theo dõi:

#### 🌊 Bảng 1: Nadaraya-Watson Envelope (`/nwe`)
* **Lệnh mở bảng:** `/nwe` (hoặc `/envelope`)
* **Xem theo từng khung thời gian:** `/nwe m5`, `/nwe m15`, `/nwe h1`, `/nwe h4`, `/nwe d1`
* **Bật/Tắt nhanh cảnh báo:** `/nwe on` | `/nwe off`
* **Giao diện nút bấm trực tiếp trên Telegram:**
  - `🔄 Làm Mới Dữ Liệu` | `🔔 Bật / 🔕 Tắt Cảnh Báo NWE`
  - Chọn khung xem ngay: `M5` | `M15` | `H1` | `H4` | `D1`
  - Bật/Tắt nhận tin độc lập từng khung: `Báo M5`, `Báo M15`, `Báo M30`, `Báo H1`, `Báo H4`, `Báo D1`
  - `🔥 Tier 2 (Quét TK): ✅ BẬT` / `❌ TẮT`
  - `ℹ️ Hướng Dẫn NWE`

#### 🧱 Bảng 2: SMC Order Blocks - Vùng Cung & Cầu (`/ob`)
* **Lệnh mở bảng:** `/ob` (hoặc `/smc`, `/orderblock`, `/zone`)
* **Xem theo từng khung thời gian:** `/ob m5`, `/ob m15`, `/ob h1`, `/ob h4`, `/ob d1`
* **Bật/Tắt nhanh cảnh báo:** `/ob on` | `/ob off`
* **Giao diện nút bấm trực tiếp trên Telegram:**
  - `🔄 Làm Mới Dữ Liệu` | `🔔 Bật / 🔕 Tắt Cảnh Báo OB`
  - Chọn khung xem ngay: `M5` | `M15` | `H1` | `H4` | `D1`
  - Bật/Tắt nhận tin độc lập từng khung: `Báo M5`, `Báo M15`, `Báo M30`, `Báo H1`, `Báo H4`, `Báo D1`
  - `🔥 Tier 2 (Quét TK): ✅ BẬT` / `❌ TẮT`
  - `ℹ️ Hướng Dẫn OB`

---

## 4. Hệ thống Phân cấp Cảnh báo: Tier 1 vs Tier 2 (Quét Thanh Khoản)

Hệ thống tự động phân loại tất cả các tín hiệu vào lệnh thành 2 cấp độ cảnh báo rõ rệt:

### 🔹 Tier 1: Tín hiệu Tiêu chuẩn (Standard Confluence)
* Khớp đầy đủ các điều kiện kỹ thuật gốc của chiến lược:
  - **BB + ATR (M5):** Giá chạm dải Bands Upper/Lower kết hợp $RSI \ge 70$ hoặc $RSI \le 30$.
  - **NWE + SMC:** Giá chạm dải NWE hoặc vùng Order Block (Demand / Supply).
* Format cảnh báo chuẩn, cung cấp đầy đủ thông số Entry, SL, TP1, TP2.

### 🔥🔥 Tier 2: Xác suất Cực Cao (High Probability - True Liquidity Sweep / SFP)
* Tự động kích hoạt khi nến tín hiệu **vừa thực hiện cú quét thanh khoản thật (True Liquidity Sweep)** trên cấu trúc bể thanh khoản M15 (BSL / SSL hoặc EQH / EQL):
  - **Quét Đáy (SSL Sweep -> Canh BUY):** Nến đâm thủng đáy cũ M15 nhưng rút râu ngược lên đóng cửa bên trên.
  - **Quét Đỉnh (BSL Sweep -> Canh SELL):** Nến bung vượt đỉnh cũ M15 nhưng rút râu ngược xuống đóng cửa bên dưới.
  - **Độ sâu quét hợp lệ:** Chuẩn từ $0.1 \times ATR$ đến $1.5 \times ATR$ (loại trừ chạm nhẹ hoặc nến xả gãy cấu trúc).
  - **Tỷ lệ râu nến:** Râu nến đảo chiều chiếm $\ge 40\%$ tổng chiều dài cây nến.
* **Gợi ý Stop Loss tối ưu:** Đặt an toàn ngay sau râu nến quét:
  - BUY: $SL = \text{Candle Low} - 0.2 \times ATR(14)$
  - SELL: $SL = \text{Candle High} + 0.2 \times ATR(14)$
* **Tỷ lệ thắng (Winrate) và R:R của Tier 2 vượt trội**, phù hợp cho trader tự tin vào lệnh với biên độ cắt lỗ cực ngắn!

---

## 5. Cảnh báo Giá chạm tức thì (Vàng & Crypto)

Bot theo dõi liên tục giá thị trường thời gian thực (real-time) và phát thông báo ngay lập tức khi giá thị trường chạm hoặc vượt ngưỡng kỳ vọng của bạn.

### ⌨️ Cú pháp đặt lệnh
```bash
/alert <MÃ> <GIÁ_MỤC_TIÊU>
```

### 💡 Ví dụ cụ thể
* **Vàng (XAU/USD):**
  - `/alert xau 4200` *(Báo khi giá Vàng chạm mốc $4,200)*
  - `/alert gold 3550.5`
* **Crypto (Bitcoin, Ethereum, Altcoins):**
  - `/alert btc 95000` hoặc `/alert btc 95k`
  - `/alert eth 3600`
  - `/alert sol 220`
  - `/alert pepe 0.000015`

### 📋 Quản lý cảnh báo
* `/alerts` hoặc `/alert list`: Liệt kê các lệnh đang chờ khớp kèm ID.
* `/alert del <ID>`: Hủy 1 lệnh (VD: `/alert del 5`).
* `/alert clear` hoặc `/alert del all`: Xóa toàn bộ danh sách đang chờ.

---

## 6. Theo dõi & Cài đặt Cảnh báo RSI Vàng đa khung

Theo dõi xung lượng giá Vàng (XAU/USD) theo chu kỳ RSI(14) trên 7 khung thời gian: `M1`, `M5`, `M15`, `M30`, `H1`, `H4`, `D1`.

### ⌨️ Các lệnh điều khiển
* `/gold` hoặc `/xau`: Hiển thị bảng tổng hợp giá hiện tại và chỉ số RSI của cả 7 khung thời gian.
* `/goldalert` hoặc `/xaualert`: Mở menu cài đặt cảnh báo RSI:
  - **Nút Master:** Bật/Tắt toàn bộ nhận tin RSI Vàng.
  - **Nút chọn khung:** Bật/Tắt từng khung từ M1 đến D1.
  - **Nút chọn bộ ngưỡng:**
    - `70 / 30`: Ngưỡng chuẩn quốc tế.
    - `75 / 25`: Bộ lọc giảm bớt nhiễu trong thị trường biến động mạnh.
    - `80 / 20`: Bắt đỉnh/đáy cực trị.

---

## 7. Lịch Kinh tế Vĩ mô & Tin tức nóng (CPI / NFP / FED)

Hệ thống kết nối nguồn dữ liệu lịch kinh tế ForexFactory với cơ chế **Adaptive Fast Polling** (tăng tốc độ quét lên mỗi 3-4 giây khi bước vào khung giờ vàng ra tin).

### ⌨️ Các lệnh điều khiển
* `/calendar` hoặc `/macro`: Xem danh sách tất cả các sự kiện kinh tế công bố trong ngày (giờ Việt Nam), bao gồm số liệu:
  - **Previous (Kỳ trước)**
  - **Forecast (Dự báo của chuyên gia)**
  - **Actual (Số liệu thực tế vừa công bố)**
* `/settings`: Mở menu cài đặt mức độ ảnh hưởng của tin tức muốn nhận cảnh báo:
  - 🔴 **Tin Đỏ (High Impact):** CPI, PPI, Non-Farm Payrolls (NFP), Tuyên bố lãi suất FOMC, Tỷ lệ thất nghiệp...
  - 🟠 **Tin Cam (Medium Impact):** PMI sản xuất/dịch vụ, Doanh số bán lẻ, Niềm tin người tiêu dùng...
  - 🟡 **Tin Vàng (Low Impact):** Các báo cáo phụ trợ.

---

## 8. Expert Advisor trên MetaTrader 5 (MT5 EA)

Mã nguồn EA đã được tích hợp sẵn trong thư mục `mt5/` của dự án để bạn có thể gắn trực tiếp vào MT5:

1. **`mt5/BB_ATR_Live_Alert.mq5`**:
   - EA chuyên dụng chạy trên biểu đồ MT5, hiển thị trực quan dải Bands(20) Upper/Lower và ngưỡng Entry $\pm 1 \times ATR(14)$.
   - Phát âm thanh cảnh báo (Alert sound) và Push Notification về điện thoại khi giá chạm vùng Entry.
2. **`mt5/BB_ATR_AutoTrader.mq5`**:
   - EA tự động hóa đặt lệnh (Auto Trading) theo chiến lược BB+ATR:
   - Tự động tính khối lượng Lot theo % rủi ro tài khoản (Risk Management).
   - Tự động đặt Stop Loss ($1 \times ATR$) và Take Profit (Middle Band hoặc Tỷ lệ 1:2 R:R).
   - Tích hợp Trailing Stop và hòa vốn (Breakeven).

---

## ⚙️ Cơ chế hoạt động nền tảng
* **Độ trễ thấp:** Dữ liệu nến và giá được cập nhật liên tục thông qua kết nối trực tiếp, loại bỏ độ trễ.
* **Chống spam cảnh báo (Anti-spam Cooldown):** Khi giá chạm vùng, bot gửi cảnh báo ngay lập tức và tự động kích hoạt bộ đếm cooldown (2 - 3 phút) để tránh tình trạng spam tin nhắn liên tục khi nến rút râu nhiều lần trong 1 vùng hẹp.
* **Tự phục hồi dữ liệu:** Cấu hình người dùng được lưu an toàn vào PostgreSQL database qua Prisma ORM, đồng thời luôn có bộ đệm In-Memory fallback đảm bảo cảnh báo không bao giờ bị gián đoạn.
