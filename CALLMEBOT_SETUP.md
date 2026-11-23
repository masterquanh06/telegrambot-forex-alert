# 📞 HƯỚNG DẪN CÀI ĐẶT GỌI ĐIỆN BÁO THỨC TELEGRAM (CALLMEBOT) — STEP BY STEP

Tài liệu này hướng dẫn từng bước cách cấu hình **CallMeBot Telegram Voice Call** để bot tự động **gọi điện đổ chuông trực tiếp trên Telegram** (đọc thông báo bằng giọng nói tiếng Việt như báo thức), giúp bạn không bao giờ bỏ lỡ kèo VIP ngay cả khi đang ngủ hoặc không nhìn màn hình.

---

## 🎯 1. Khi nào bot sẽ tự động gọi điện?

Để tránh làm phiền, hệ thống **CHỈ kích hoạt cuộc gọi điện báo thức trong đúng 2 trường hợp VIP nhất**:

1. 👑💎 **TIER SSS (Siêu Hợp Lưu):** Khi **BB+ATR M5 (Tier 3)** và **SMC+NWE M15 (Tier 3)** cùng chiều trong cửa sổ 20 phút.
2. 🔥🔥🔥 **SMC Order Blocks + Nadaraya-Watson Envelope — Tier 3 (VIP):** Khi giá chạm **NWE H1 + OB (M15/M30/H1/H4) + Nến rút râu M15**.

> **Chống gọi trùng thông minh:** Nếu một tín hiệu **SMC+NWE Tier 3** xảy ra và lập tức nâng cấp lên **TIER SSS**, bot sẽ **chỉ gọi 1 lần duy nhất** với kịch bản **TIER SSS** (không gọi đúp 2 cuộc liên tiếp).  
> Các tín hiệu thông thường (`BB+ATR Tier 0/1/2/3 đơn lẻ`, `SMC Tier 1/2`, `RSI`, `Macro`, `Price Alert`) vẫn gửi tin nhắn Telegram bình thường và **không gọi điện**.

---

## 🛠️ 2. Hướng dẫn cài đặt từng bước (Làm đúng 5 bước)

### Bước 1: Cấp quyền cho CallMeBot trên tài khoản Telegram của bạn
1. Mở Telegram trên điện thoại hoặc máy tính.
2. Tìm bot **`@CallMeBot_txtbot`** (tên hiển thị: *CallMeBot API*, có chữ `bot` ở dưới tên) → bấm **Start** (gửi `/start`).
   - *Hoặc mở link cấp quyền nhanh trên trình duyệt:* `https://api2.callmebot.com/txt/login.php` rồi bấm đăng nhập bằng Telegram.
3. Khi thấy bot trả lời **`the bot is already active for this user`** hoặc **`This is a test from Callmebot`** là đã cấp quyền thành công.

---

### Bước 2 (QUAN TRỌNG NHẤT): Thêm `@CallMeBot_API` vào Danh bạ & Nhắn tin `hi`

> ⚠️ **CỰC KỲ LƯU Ý — ĐỪNG NHẦM 2 TÀI KHOẢN KHÁC NHAU:**
> CallMeBot có **2 tài khoản Telegram hoàn toàn khác nhau**:
> - **`@CallMeBot_txtbot`** *(có chữ `bot`)*: Chỉ là **con bot** dùng để đăng ký `/start` ở Bước 1. **KHÔNG có nút Add to Contacts và KHÔNG thể gọi điện.**
> - **`@CallMeBot_API`** *(có chữ `last seen recently`)*: Là **tài khoản người dùng thật** trực tiếp bấm gọi điện cho bạn!

Do thỉnh thoảng có người report spam nên Telegram sẽ chặn không cho `@CallMeBot_API` gọi bạn nếu bạn chưa kết bạn và nhắn tin trước. Hãy làm đúng 3 thao tác sau:

1. Ở ô tìm kiếm (Search) trên Telegram, gõ chính xác: **`@CallMeBot_API`** (có dấu gạch dưới `_API`, không có chữ `txtbot`).
2. Mở trang cá nhân của **`CallMeBot_API`** → bấm **Add to Contacts** (Thêm vào danh bạ).
3. Ngay trên trang cá nhân đó, bấm nút xanh **Message** (Nhắn tin) để mở khung chat riêng với **`CallMeBot_API`** → gõ và gửi một tin nhắn bất kỳ (ví dụ: `hi`).
   - *(Đừng gửi `hi` vào cửa sổ chat với `@CallMeBot_txtbot` — sẽ báo `Command "hi" not found` vì đó là bot!)*

---

### Bước 3: Kiểm tra quyền riêng tư cuộc gọi trên Telegram
1. Vào **Telegram → Settings (Cài đặt) → Privacy and Security (Quyền riêng tư & Bảo mật) → Calls (Cuộc gọi)**.
2. Ở mục **Who can call me (Ai có thể gọi cho tôi)**:
   - Chọn **Everybody (Mọi người)** hoặc **My Contacts (Danh bạ của tôi)**.
   - **KHÔNG** để `Nobody (Không ai cả)` (nếu để `Nobody`, hãy thêm `@CallMeBot_API` vào mục ngoại lệ *Always Allow*).
3. Đảm bảo điện thoại/máy tính không bật chế độ im lặng hoặc tắt thông báo cuộc gọi Telegram (nếu muốn kêu cả khi ngủ, hãy cho phép Telegram vượt qua chế độ *Do Not Disturb / Focus*).

---

### Bước 4: Cấu hình file `.env` (hoặc biến môi trường trên Server / Northflank)

Mở file `.env` ở thư mục gốc dự án và thêm/cập nhật các dòng sau:

```env
CALLMEBOT_ENABLED=true
CALLMEBOT_USERS=@username_ca_nhan_cua_ban
CALLMEBOT_LANG=vi-VN-Standard-A
CALLMEBOT_REPEAT=2
CALLMEBOT_CC=missed
CALLMEBOT_COOLDOWN_SEC=60
```

#### Giải thích các biến cấu hình:
| Biến môi trường | Ý nghĩa | Giá trị khuyến nghị |
| :--- | :--- | :--- |
| `CALLMEBOT_ENABLED` | Bật/tắt toàn bộ tính năng gọi điện CallMeBot | `true` (đặt `false` để tạm tắt) |
| `CALLMEBOT_USERS` | **Username Telegram cá nhân** của người nhận cuộc gọi (cách lấy: *Telegram → Settings → My Profile → Username*). Hỗ trợ nhiều người cách nhau bởi dấu phẩy: `@user1,@user2`. | `@username_ca_nhan` *(**TUYỆT ĐỐI KHÔNG** điền `@username` của con bot!)* |
| `CALLMEBOT_LANG` | Giọng đọc Text-to-Speech (TTS) | `vi-VN-Standard-A` (tiếng Việt) |
| `CALLMEBOT_REPEAT` | Số lần lặp lại nội dung cảnh báo khi bạn bắt máy | `2` (hoặc `3`) |
| `CALLMEBOT_CC` | Có gửi thêm tin nhắn text nếu bạn không kịp nghe máy hay không | `missed` (chỉ nhắn khi gọi nhỡ) |
| `CALLMEBOT_COOLDOWN_SEC` | Thời gian giãn cách tối thiểu giữa 2 cuộc gọi cho cùng 1 user (tối thiểu 15s) | `60` |

> **Cách xem lại `@username` cá nhân của bạn:**  
> Mở Telegram → **Settings** → **My Profile** (hoặc **Edit Profile**) → nhìn dòng **Username** (có dạng `@TenCuaBan`). Nếu chưa có, hãy tạo một Username ngay tại đó.

---

### Bước 5: Khởi động lại Bot & Test gọi điện trực tiếp trên Telegram

1. Sau khi lưu `.env`, **khởi động lại bot** để nạp biến môi trường mới:
   ```bash
   # Môi trường local (dev)
   npm run start:dev

   # Hoặc môi trường production
   npm run build
   npm run start:prod
   ```
   *(Nếu deploy trên cloud như Northflank / Railway / Render, hãy thêm các biến ở Bước 4 vào mục **Environment Variables** rồi redeploy/restart service.)*

2. Mở chat với con bot Telegram của bạn và gõ lệnh:
   - **`/testcall`** (hoặc `/calltest`) → Gọi thử kịch bản **TIER SSS (SELL)**.
   - **`/testcall smc`** → Gọi thử kịch bản **SMC + NWE Tier 3 (SELL)**.
   - **`/testcall buy`** hoặc **`/testcall smc buy`** → Gọi thử chiều **BUY**.

3. Chờ **3–10 giây** → Telegram sẽ đổ chuông cuộc gọi đến từ **`CallMeBot_API`**, bắt máy sẽ nghe giọng tiếng Việt đọc rõ kịch bản, chiều vào lệnh, giá và SL!

#### Cách test nhanh trực tiếp bằng trình duyệt (không cần qua bot):
Nếu muốn kiểm tra xem tài khoản CallMeBot của riêng bạn còn hoạt động không, dán link sau vào trình duyệt (thay `@username_ca_nhan` bằng username thật của bạn):
```text
https://api.callmebot.com/start.php?user=@username_ca_nhan&text=Test+goi+dien+canh+bao+vang&lang=vi-VN-Standard-A&rpt=2
```

---

## 🩺 3. Bảng xử lý sự cố thường gặp (Troubleshooting)

| Triệu chứng / Lỗi gặp phải | Nguyên nhân | Cách khắc phục |
| :--- | :--- | :--- |
| Bot báo gửi thành công nhưng **không thấy điện thoại đổ chuông**, và `@CallMeBot_txtbot` nhắn: *"Someone reported CallMeBot as spammer, please add @CallMeBot_API..."* | Chưa thêm đúng tài khoản **`@CallMeBot_API`** vào danh bạ, hoặc mới gửi `hi` cho bot `@CallMeBot_txtbot` thay vì `@CallMeBot_API`. | Tìm đúng **`@CallMeBot_API`** (tài khoản người dùng), bấm **Add to Contacts**, sau đó bấm nút **Message** trên chính profile `@CallMeBot_API` và gửi `hi`. |
| Mở trang cá nhân không thấy nút **Add to Contacts** (chỉ thấy *Add To Group*, *Help*). | Đang mở nhầm con bot **`@CallMeBot_txtbot`**. | Quay lại thanh Search, tìm đúng **`@CallMeBot_API`**. |
| Đã cấu hình `.env` nhưng gọi không kêu, log không lỗi. | Điền nhầm **`@username` của con bot** (VD: `@AkiraXaubot`) vào `CALLMEBOT_USERS` thay vì username cá nhân. Bot Telegram không thể nghe điện thoại! | Sửa `CALLMEBOT_USERS` thành `@username` cá nhân của bạn trong `.env` và khởi động lại bot. |
| Gõ `/testcall` bot báo *"Chưa cấu hình CallMeBot trong file `.env`"*. | Chưa lưu `.env`, quên `CALLMEBOT_ENABLED=true`, hoặc chưa khởi động lại server sau khi sửa `.env`. | Kiểm tra lại `.env`, đảm bảo `CALLMEBOT_ENABLED=true` và `CALLMEBOT_USERS=@...`, sau đó restart bot. |
| Đã làm đủ các bước trên nhưng vẫn không đổ chuông. | Cài đặt quyền riêng tư Telegram đang chặn cuộc gọi (`Calls = Nobody`), hoặc CallMeBot server đang bận/giới hạn tần suất (1 cuộc/60s). | Kiểm tra *Settings → Privacy and Security → Calls*, chờ 60 giây rồi thử lại `/testcall`. |
| Muốn tạm tắt tính năng gọi điện khi đang bận/họp. | Không muốn bị đổ chuông tạm thời. | Đổi `CALLMEBOT_ENABLED=false` trong `.env` và khởi động lại bot (mọi cảnh báo tin nhắn Telegram vẫn chạy bình thường). |
