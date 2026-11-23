# 🔥 HỆ THỐNG PHÂN CẤP CẢNH BÁO (TIER SYSTEM) — TẤT CẢ CHIẾN LƯỢC

Tài liệu này giải thích chi tiết **từng cấp độ Tier**, điều kiện toán học, cách tính Entry/SL/TP và cơ chế bật/tắt thông báo cho toàn bộ các phương pháp trong bot.

---

## 1. Ma trận tổng quan toàn bộ phương pháp & Tier

| Phương pháp | Khung chính | Nguồn dữ liệu | Cấp độ cảnh báo (Tiers) | Tần suất quét |
| :--- | :--- | :--- | :--- | :--- |
| **1. BB(20) + ATR(14) + RSI(14)** | `M5` | TradingView WS `OANDA:XAUUSD` (0ms) → TV Scanner → Binance fallback | **Tier 0** → **Tier 1** → **Tier 2A / 2B** → **Tier 3 (VIP)** | Tức thì theo tick WS + Cron backup 3s |
| **2. SMC Order Blocks + NWE** | `NWE H1` + `OB M15/M30/H1/H4` + `Nến M15` | TradingView WS `TVC:GOLD` (500 nến/khung, 0ms) → Binance fallback | **Tier 1** → **Tier 2 (MTF)** → **Tier 3 (VIP)** | Cron 15s |
| **3. Siêu Hợp Lưu (TIER SSS)** | `BB+ATR M5 (Tier 3)` + `SMC+NWE M15 (Tier 3)` | Kết hợp 2 luồng qua `SuperTierService` | **👑💎🔥🔥🔥 TIER SSS** *(cùng chiều trong cửa sổ 20 phút)* | Tức thì khi trụ cột thứ 2 khớp |
| **3. RSI Vàng đa khung** | `M1, M5, M15, M30, H1, H4, D1` | TradingView / Binance | Không phân Tier lửa — theo ngưỡng `70/30`, `75/25`, `80/20` | Cron 25s |
| **4. Price Alert** | Real-time | TradingView / Binance | Không phân Tier — báo 1 lần khi chạm giá mục tiêu | Cron 12s |
| **5. Tin tức Kinh tế Vĩ mô** | Real-time | ForexFactory | Phân theo độ nóng: 🔴 Cao (`1`), 🟠 Trung bình (`0`), 🟡 Thấp (`-1`) | Adaptive 4s–30s |
| **6. MT5 EA Webhook** | `M5` (tùy sàn MT5) | Trực tiếp từ sàn MT5 (`POST /api/webhook/bbatr`) | Phát theo tín hiệu từ EA (`ENTRY_*`, `*_CONFLUENCE`, khớp lệnh AutoTrader) | 0ms theo tick MT5 |

---

## 2. Chiến lược 1: Bollinger Bands (20, 2) + ATR (14) + RSI (14) — Khung M5

> **Code nguồn:** `src/indicator/signal-classifier.ts` (`detectM5RejectionWick`, `classifySignalTier`) & `src/indicator/bb-atr.service.ts`.

### 📐 Các mốc tham chiếu cơ bản
- **Bollinger Bands (20, 2):** `BB Upper`, `BB Middle (SMA20)`, `BB Lower`.
- **ATR (14):** Wilder's Smoothing trên nến M5.
- **Vùng Entry mở rộng (`BB ± ATR`):**
  - `Upper Entry (SELL)` = `BB Upper + ATR(14)`
  - `Lower Entry (BUY)` = `BB Lower - ATR(14)`

### 🔥 Giải thích chi tiết 5 cấp độ (xét theo thứ tự ưu tiên từ cao xuống thấp)

#### 🔔 Tier 0 — Chạm dải BB thông thường (`alertTier = 0`)
- **Điều kiện:**
  - **SELL:** Giá (`close` hoặc `high`) chạm/vượt `BB Upper`, nhưng **chưa** tới `BB Upper + ATR` và **chưa** có nến rút râu M5 đạt chuẩn.
  - **BUY:** Giá (`close` hoặc `low`) chạm/thủng `BB Lower`, nhưng **chưa** tới `BB Lower - ATR` và **chưa** có nến rút râu M5 đạt chuẩn.
- **Mã tín hiệu:** `TOUCH_UPPER_BB` / `TOUCH_LOWER_BB` (hoặc `SELL_CONFLUENCE` / `BUY_CONFLUENCE` nếu đi kèm RSI ≥ 70 / ≤ 30 nhưng vẫn ở mức Tier 0).
- **Ý nghĩa:** Cảnh báo theo dõi sớm. Trong xu hướng mạnh bám biên (band walk), Tier 0 có thể báo nhiều lần liên tiếp theo từng nến M5 mới hoặc sau cooldown 90 giây.

#### 🔥 Tier 1 — Khớp vùng Entry mở rộng `BB ± ATR` (`alertTier = 1`)
- **Điều kiện:**
  - **SELL (`ENTRY_SELL`):** `close >= Upper Entry` hoặc `high >= Upper Entry` (RSI < 70, chưa có nến rút râu M5 tại `Upper Entry`).
  - **BUY (`ENTRY_BUY`):** `close <= Lower Entry` hoặc `low <= Lower Entry` (RSI > 30, chưa có nến rút râu M5 tại `Lower Entry`).
- **Ý nghĩa:** Giá đã bị kéo dãn ra khỏi dải BB đúng bằng 1 biên độ ATR — dấu hiệu quá mua/quá bán ngắn hạn (exhaustion).
- **Kế hoạch Entry / SL / TP:**
  - **Entry:** `Upper Entry` (SELL) / `Lower Entry` (BUY)
  - **SL:** `Entry ± 1 ATR` (`Upper Entry + ATR` / `Lower Entry - ATR`)
  - **TP1:** `BB Middle` | **TP2:** Tỷ lệ `1:2 R:R` (`Entry ∓ 2 ATR`)

#### 🔥🔥 Tier 2A — Hợp lưu `BB ± ATR` + RSI Cực Trị (`alertTier = 2`, `TIER_2A_RSI`)
- **Điều kiện:**
  - **SELL (`ENTRY_SELL`):** Chạm/vượt `BB Upper + ATR` **VÀ** `RSI(14) >= 70`.
  - **BUY (`ENTRY_BUY`):** Chạm/thủng `BB Lower - ATR` **VÀ** `RSI(14) <= 30`.
- **Ý nghĩa:** Hợp lưu kép giữa biên độ giá cực đại và xung lượng RSI quá mua/quá bán. Phản ứng tức thì ngay cả ở đầu nến M5 (không phải chờ đóng nến).
- **Kế hoạch Entry / SL / TP:** Giống Tier 1 (`Entry = BB ± ATR`, `SL = 1 ATR`, `TP1 = BB Middle`, `TP2 = 1:2 R:R`).

#### 🔥🔥 Tier 2B — Nến rút râu từ chối M5 ngay tại biên BB (`alertTier = 2`, `TIER_2B_M5_WICK`)
- **Điều kiện:**
  - **SELL (`SELL_CONFLUENCE`):** Thỏa `detectM5RejectionWick(nến M5, level = BB Upper, atrM5, 'SELL')`.
  - **BUY (`BUY_CONFLUENCE`):** Thỏa `detectM5RejectionWick(nến M5, level = BB Lower, atrM5, 'BUY')`.
  - **Không bắt buộc** phải chạm tới `BB ± ATR` hay RSI 70/30.
- **Ý nghĩa:** Bắt các cú đảo chiều sớm khi giá vừa chọc qua biên BB đã bị từ chối rút râu quyết liệt mà không kịp kéo đủ 1 ATR.
- **Kế hoạch Entry / SL / TP:**
  - **Entry:** Ngay tại biên `BB Upper` (SELL) / `BB Lower` (BUY)
  - **SL:** `Entry ± 1 ATR` (`BB Upper + ATR` / `BB Lower - ATR`)
  - **TP1:** `BB Middle` | **TP2:** Tỷ lệ `1:2 R:R` (`Entry ∓ 2 ATR`)

#### 🔥🔥🔥 Tier 3 (VIP) — `BB ± ATR` + Nến rút râu M5 (`alertTier = 3`, `TIER_3_M5_WICK`)
- **Điều kiện:**
  - **SELL (`ENTRY_SELL`):** Thỏa `detectM5RejectionWick(nến M5, level = BB Upper + ATR, atrM5, 'SELL')`.
  - **BUY (`ENTRY_BUY`):** Thỏa `detectM5RejectionWick(nến M5, level = BB Lower - ATR, atrM5, 'BUY')`.
- **Ý nghĩa:** Cấp độ cao nhất của chiến lược BB+ATR — giá không chỉ kéo giãn cực hạn vượt `BB ± ATR` mà còn xác nhận bị phe đối ứng đạp rút râu đóng thụt ngược vào trong.
- **Nâng cấp tự động:** Nếu đầu nến M5 đã báo Tier 1 hoặc Tier 2A, đến phút thứ 4 trở đi (hoặc lúc đóng nến) hình thành râu đạt chuẩn → bot **tự động bắn tiếp thông báo nâng cấp lên Tier 3 (VIP)**.
- **Kế hoạch Entry / SL / TP:** `Entry = BB ± ATR`, `SL = 1 ATR`, `TP1 = BB Middle`, `TP2 = 1:2 R:R`.

---

### 🔬 Bộ lọc Nến rút râu M5 (`detectM5RejectionWick`) — Chi tiết toán học

Một cây nến M5 chỉ được công nhận là **nến rút râu từ chối thật** tại mốc `level` khi thỏa **TẤT CẢ** các điều kiện sau:

1. **Lọc nhiễu nến bé (loại Doji siêu nhỏ):** `totalRange = high - low >= 0.5 * ATR(14)`.
2. **Đâm xuyên & đóng thụt vào trong:**
   - SELL: `high > level` **VÀ** `close < level`
   - BUY: `low < level` **VÀ** `close > level`
3. **Chiều dài râu tối thiểu:** `upperWick >= 0.25 * ATR` (SELL) / `lowerWick >= 0.25 * ATR` (BUY).
4. **Vị trí giá đóng cửa (`closePos = (close - low) / totalRange`):**
   - SELL: `closePos <= 0.45` (đóng ở nửa dưới thân nến — loại bẫy trượt biên)
   - BUY: `closePos >= 0.55` (đóng ở nửa trên thân nến — loại bẫy trượt biên)
5. **Thỏa 1 trong 2 dạng từ chối (OR):**
   - **Dạng A — Pinbar (bất kể màu nến):** `wick / totalRange >= 0.45` (râu chiếm ≥ 45% cây nến).
   - **Dạng B — Nến đảo chiều thuận màu:**
     - SELL: nến đỏ (`close < open`) **VÀ** `upperWick / totalRange >= 0.25`
     - BUY: nến xanh (`close > open`) **VÀ** `lowerWick / totalRange >= 0.25`
6. **Chống rút râu ảo đầu nến:** Chỉ kích hoạt kiểm tra rút râu khi:
   - Nến M5 đang chạy đã đi qua **≥ 80% thời gian** (từ **phút thứ 4 trở đi** của cây nến 5 phút), **HOẶC**
   - Kiểm tra trên **nến M5 vừa đóng (`prevCandle`)** để không bỏ sót cú rút râu ở giây cuối.

---

## 3. Chiến lược 2: SMC Order Blocks + Nadaraya-Watson Envelope (NWE)

> **Code nguồn:** `src/smc/smc-mtf-classifier.ts` (`classifySmcMtfTier`) & `src/smc/smc.service.ts`.

Hệ thống SMC + NWE được thiết kế đồng bộ **3 tầng rõ ràng (Tier 1 → Tier 2 → Tier 3 VIP)** và hỗ trợ **hợp lưu chéo khung thời gian (Multi-Timeframe)**:

### 🔔 Tier 1 — Tín hiệu đơn khung (`alertTier = 1`)
- Quét độc lập trên 6 khung `M5, M15, M30, H1, H4, D1`:
  - `TOUCH_NWE_UPPER` / `TOUCH_NWE_LOWER`: Giá chạm biên trên/dưới dải NWE (`h=8, mult=3.0`) trên khung đang theo dõi.
  - `TOUCH_SUPPLY_OB` / `TOUCH_DEMAND_OB`: Giá đi vào vùng Bearish OB / Bullish OB chưa bị triệt tiêu (Unmitigated) trên khung đang theo dõi.
  - `CONFLUENCE_SELL` / `CONFLUENCE_BUY` cùng khung (ngoại trừ `H1` — vì hợp lưu `NWE H1 + OB H1` đã được nâng cấp và gom vào luồng MTF Tier 2/3 để **không bao giờ bắn trùng**).

### 🔥🔥 Tier 2 — Hợp lưu Chéo Khung MTF (`alertTier = 2`, `SMC_TIER_2_MTF_CONFLUENCE`)
- **Khung Neo (Anchor):** Dải biên **NWE khung H1** (`Upper Band` cho SELL / `Lower Band` cho BUY).
- **Tập Order Block hợp lưu:** Toàn bộ các khối OB chưa triệt tiêu từ 4 khung **`M15`, `M30`, `H1`, `H4`** (không lấy `M5` để tránh nhiễu, không lấy `D1` để tránh vùng quá rộng).
- **Điều kiện kích hoạt:**
  - **SELL (`CONFLUENCE_SELL`):** Giá chạm/vượt dải trên **NWE H1** **ĐỒNG THỜI** giao cắt ít nhất 1 khối **Supply OB** thuộc `M15, M30, H1` hoặc `H4`.
  - **BUY (`CONFLUENCE_BUY`):** Giá chạm/thủng dải dưới **NWE H1** **ĐỒNG THỜI** giao cắt ít nhất 1 khối **Demand OB** thuộc `M15, M30, H1` hoặc `H4`.
- **Ưu tiên khối chính (`primaryOb`):** Nếu giá giao cắt nhiều OB cùng lúc (VD: vừa chạm OB M15 vừa chạm OB H1), tin nhắn liệt kê đầy đủ tất cả các khối và chọn khối có khung lớn nhất làm khối chính theo thứ tự `H4 > H1 > M30 > M15`.

### 🔥🔥🔥 Tier 3 (VIP) — Hợp lưu Chéo Khung + Nến Rút Râu Khung M15 (`alertTier = 3`, `SMC_TIER_3_MTF_WICK`)
- **Khung nến xác nhận:** **Bắt buộc khung M15** (lọc theo **`ATR(14)` khung M15** — `atrM15`).
- **Hàm kiểm tra vùng OB rộng (`detectZoneRejectionWick`):**
  Vì Order Block H1/H4 thường rộng 10–20 giá, bot cho phép xác nhận nến M15 rút râu **ngay bên trong lòng OB** miễn không đóng phá vỡ mép ngoài OB:
  - **SELL:**
    - `m15.high >= Math.max(nweH1.upperBand, ob.bottom)` *(đã chọc vào cả NWE H1 lẫn Supply OB)*
    - **VÀ** `m15.close < ob.top` *(đóng nến không phá vỡ mép trên OB)*
  - **BUY:**
    - `m15.low <= Math.min(nweH1.lowerBand, ob.top)` *(đã chọc vào cả NWE H1 lẫn Demand OB)*
    - **VÀ** `m15.close > ob.bottom` *(đóng nến không phá vỡ mép dưới OB)*
  - **VÀ** thỏa nguyên bộ lọc hình dáng râu chuẩn với `atrM15` (`totalRange >= 0.5 * atrM15`, râu `>= 0.25 * atrM15`, `closePos <= 0.45 / >= 0.55`, Dạng A Pinbar `>= 45%` hoặc Dạng B thuận màu `>= 25%`).
- **Chống rút râu ảo đầu nến M15:** Chỉ kích hoạt khi nến M15 đang chạy đã đi qua **≥ 80% thời gian** (từ **phút thứ 12 trở đi** của cây nến 15 phút), hoặc trên **nến M15 vừa đóng (`m15PrevCandle`)**.
- **Gợi ý quản trị rủi ro trên tin nhắn:**
  - **Mép vùng hợp lưu:** `Math.max(nweH1.upperBand, primaryOb.bottom)` (SELL) / `Math.min(nweH1.lowerBand, primaryOb.top)` (BUY).
  - **SL gợi ý:** Ngoài mép khối OB chính + `0.5 * ATR(14) M15`.
  - **TP1:** Đường Kernel trung tâm của NWE H1.

---

## 3B. Cấp Tối Thượng — 👑💎🔥🔥🔥 TIER SSS (Siêu Hợp Lưu)

> **Code nguồn:** `src/indicator/super-tier-classifier.ts` (`evaluateTierSss`, `shouldSuppressDuplicateSss`) & `src/common/super-tier.service.ts`.

- **Điều kiện kích hoạt:**
  1. Cả **BB+ATR M5** và **SMC+NWE MTF** đều đạt **Tier 3 (VIP)**.
  2. **Cùng chiều tuyệt đối** (`BUY` với `BUY`, hoặc `SELL` với `SELL`).
  3. Khoảng cách thời gian giữa 2 tín hiệu nằm trong cửa sổ trượt **≤ 20 phút** (`SSS_CONFLUENCE_WINDOW_MS`).
- **Kế hoạch vào lệnh hợp nhất:**
  - **Entry tham chiếu:** Giá thị trường của tín hiệu khớp sau cùng.
  - **SL an toàn nhất:** `Math.max(SL_BB_ATR, SL_SMC_NWE)` với SELL; `Math.min(SL_BB_ATR, SL_SMC_NWE)` với BUY.
  - **TP1:** `BB Middle (M5)` | **TP2:** `NWE H1 Kernel`.
- **Chống spam & Phân quyền:** Chặn trùng cặp `(bbCandleTimeMs, smcCandleTimeMs)` hoặc cooldown **15 phút cùng chiều**; gửi song song batch 25 users tới toàn bộ VIP subscribers (`tier2AlertEnabled !== false`).
- **Gọi điện báo thức Telegram (CallMeBot):** Tự động gọi điện thoại Telegram (đọc giọng tiếng Việt `vi-VN-Standard-A`) **CHỈ cho 2 trường hợp**: **TIER SSS** và **SMC+NWE Tier 3** (nếu SMC Tier 3 đồng thời kích hoạt TIER SSS thì chỉ gọi 1 cuộc TIER SSS, không gọi trùng). Cấu hình trong `.env`: `CALLMEBOT_ENABLED=true`, `CALLMEBOT_USERS=@username` (nhớ nhắn `/start` 1 lần với `@CallMeBot_txtbot` trước).

---

## 4. Quyền nhận tin, Công tắc Bật/Tắt & Bộ lọc Bias

### Bảng điều khiển công tắc hiện tại

| Công tắc / Lệnh | Tác dụng thực tế lên từng Tier |
| :--- | :--- |
| **BB+ATR Master:** `/bbatr on` / `/bbatr off` *(Cảnh báo tự động XAU M5)* | Bật/Tắt **cả cụm Tier 0 + Tier 1 + Tier 2A + Tier 2B** của BB+ATR (chỉ chừa Tier 3 VIP nếu nút Tier 3 đang BẬT). |
| **BB+ATR Tier 0:** `/bbatr tier0` *(hoặc nút `🔔 Tier 0 (Chạm BB)` trên Dashboard `/bbatr`)* | Bật/Tắt **riêng Tier 0 (chạm dải BB thường)**. Khi TẮT (và vẫn bật `/bbatr on`), bot im lặng với Tier 0 nhưng **vẫn bắn đầy đủ Tier 1, Tier 2A, Tier 2B và Tier 3**. |
| **BB+ATR Bias:** `/bbatr buy` / `sell` / `both` | Áp dụng lọc hướng cho **Tier 0, Tier 1, Tier 2A, Tier 2B**. **Không chặn Tier 3 VIP** (luôn báo 2 chiều khi có tín hiệu VIP). |
| **NWE:** `/nwe on` / `/nwe off` & chọn khung | Bật/Tắt cảnh báo **Tier 1 NWE** theo từng khung. Nếu bật `NWE H1`, tự động nhận cả **SMC+NWE Tier 2 (MTF)**. |
| **Order Block:** `/ob on` / `/ob off` & chọn khung | Bật/Tắt cảnh báo **Tier 1 OB** theo từng khung. Nếu bật khung thuộc `M15/M30/H1/H4`, tự động nhận **SMC+NWE Tier 2 (MTF)** khi khối khung đó khớp với NWE H1. |
| **Công tắc VIP chung:** `/tier3` *(hoặc nút `🔥 Tier 3` trên Dashboard BB / NWE / OB)* | Bật/Tắt độc lập **Tier 3 VIP** của cả **BB+ATR (Rút râu M5)** lẫn **SMC+NWE (Rút râu M15)**. Khi BẬT, vẫn nhận Tier 3 ngay cả khi đã tắt cảnh báo thường. |

### Cơ chế chống spam & chống bắn trùng
- **BB+ATR M5:**
  - Báo ngay khi sang nến M5 mới, khi **nâng cấp Tier** (VD: `0 → 1 → 2A/2B → 3`), hoặc sau cooldown **90 giây**.
  - Khóa `(lastWickAlertCandleTime, lastWickAlertTier)`: trên cùng 1 nến vẫn cho phép upgrade `Tier 2B → Tier 3`, nhưng **không bao giờ bắn lặp lại** tín hiệu rút râu đó khi chuyển sang đầu nến mới.
  - Khóa Mutex `isCheckingGlobalXau`: ngăn WebSocket tick và Cron 3s chạy đè nhau.
- **SMC + NWE:**
  - Cooldown **150 giây (2.5 phút)** cho tín hiệu cùng loại; báo ngay khi sang nến M15 mới hoặc nâng cấp `Tier 2 → Tier 3`.
  - Khóa `(lastMtfWickCandleTime, lastMtfWickTier)` chống lặp Tier 3 từ `m15PrevCandle` và khóa Mutex `isCheckingSmc`.
- **Gửi Telegram song song:** Broadcast theo batch **25 users/lượt** bằng `Promise.allSettled()` để giảm tối đa độ trễ.
