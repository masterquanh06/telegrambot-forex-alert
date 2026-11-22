# 🤖 Telegram Financial Alert & Trading Bot

Bot Telegram phân tích tài chính thông minh, cảnh báo giao dịch thời gian thực cho **Vàng (XAU/USD)**, **Crypto (BTC, ETH, Altcoins)** và **Tin tức Kinh tế Vĩ mô (CPI, PPI, NFP, FED)**.

## 🚀 Tính năng nổi bật
* **Phát hiện Quét Thanh Khoản (Liquidity Sweep / SFP) & Phân cấp Alert (Tier 1 / Tier 2):**
  - Tự động quét các bể thanh khoản M15 (BSL / SSL, EQH / EQL) với cấu trúc Pivot High / Low (`left = 5`, `right = 5`).
  - Xác nhận cú quét thật: đâm thủng nhưng rút râu $\ge 40\%$ đóng ngược vào trong, độ sâu chuẩn $0.1 - 1.5 \times ATR$.
  - Phân cấp thông minh: **Tier 1 (Tín hiệu thường)** và **Tier 2 (🔥 HIGH PROBABILITY - CÓ QUÉT THANH KHOẢN)** kèm gợi ý Stop Loss tối ưu sau râu quét.
* **Chiến lược Bollinger Bands (20) + ATR (14) M5:**
  - Tự động quét và cảnh báo khi giá chạm dải Bands Upper/Lower kết hợp bộ lọc $RSI \ge 70$ (Quá mua) hoặc $RSI \le 30$ (Quá bán).
  - Tự động tính vùng Entry, Stop Loss ($1 \times ATR$) và Take Profit (Middle Band, Tỷ lệ 1:2 R:R).
* **Nadaraya-Watson Envelope (NWE) + Smart Money Concepts (SMC):**
  - Thuật toán hồi quy Kernel Gaussian ($h=8, \text{mult}=3.0$) chuẩn xác theo TradingView LuxAlgo.
  - Tự động phát hiện các khối **Order Block (Demand & Supply)** chưa bị triệt tiêu (Unmitigated) và các mốc Kháng cự / Hỗ trợ động.
  - Cảnh báo **Hợp lưu (Confluence Alert)** khi giá chạm đồng thời dải NWE và vùng Order Block.
  - Hỗ trợ đầy đủ các khung thời gian: `M5`, `M15`, `M30`, `H1`, `H4`, `D1` với giao diện nút bấm Bật/Tắt linh hoạt.
* **Cảnh báo Giá chạm tức thì (Price Alert):** Cảnh báo ngay khi Vàng hoặc Crypto chạm mốc giá mong muốn.
* **Theo dõi & Cảnh báo RSI Vàng:** Theo dõi liên tục RSI(14) trên 7 khung thời gian (`M1` đến `D1`).
* **Lịch Kinh tế Vĩ mô:** Tích hợp ForexFactory với cơ chế Adaptive Fast Polling (quét mỗi 3 giây khi vào giờ ra tin).
* **MetaTrader 5 Expert Advisor (MT5 EA):** Mã nguồn EA tự động hiển thị và giao dịch tự động trong thư mục `mt5/`.

---

## 📖 Hướng dẫn chi tiết & Toàn bộ câu lệnh
Xem bảng tổng hợp đầy đủ cú pháp các lệnh và hướng dẫn giao dịch tại:
👉 **[COMMANDS.md](COMMANDS.md)**
