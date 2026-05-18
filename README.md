# 🤖 Telegram Mini App Platform

> Một server, nhiều bot, mỗi bot view 1 web riêng của bạn.

## Tổng quan

```
Web của bạn → POST /api/create-bot (token + web_url)
                    ↓
         Bot Telegram tự khởi động
                    ↓
  User /start → Nút "Mở App" → Mở web của bạn trong Telegram
```

---

## 🚀 Deploy lên Render.com (5 phút)

### Bước 1: Fork / Upload lên GitHub
Upload toàn bộ source này lên GitHub repo của bạn.

### Bước 2: Tạo Web Service trên Render

1. Vào [render.com](https://render.com) → **New** → **Web Service**
2. Connect GitHub repo
3. Cấu hình:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Node version**: 18+

### Bước 3: Cài đặt Environment Variables

Thêm các biến sau trong Render dashboard → Environment:

| Key | Value | Ghi chú |
|-----|-------|---------|
| `JWT_SECRET` | random_32_chars | Tự tạo chuỗi random |
| `PLATFORM_API_KEY` | random_key | Tự tạo, dùng làm master API key |
| `ADMIN_USERNAME` | admin | Tên đăng nhập dashboard |
| `ADMIN_PASSWORD` | YourPassword123 | **Đổi ngay!** |
| `DB_PATH` | /tmp/platform.db | Render free tier dùng /tmp |

### Bước 4: Deploy

Nhấn **Deploy** → Đợi ~2 phút → Truy cập `https://your-app.onrender.com`

---

## 📋 Sử dụng API từ web của bạn

### Lấy API Key

1. Vào Dashboard: `https://your-app.onrender.com/dashboard`
2. Đăng nhập (admin / mật khẩu đã set)
3. **API Keys** → **Tạo API Key**
4. Copy key (chỉ hiện 1 lần)

### Tạo Bot

```javascript
const response = await fetch('https://your-app.onrender.com/api/create-bot', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': 'YOUR_API_KEY'   // ← Key vừa tạo
  },
  body: JSON.stringify({
    token: '1234567890:ABCDefGHIJklm...',   // Token từ @BotFather
    web_url: 'https://yourwebsite.com',      // Web bạn muốn hiện
    welcome_message: 'Xin chào! 👋 Nhấn nút bên dưới để mở ứng dụng.',
    button_text: '🚀 Mở Mini App'
  })
});

const data = await response.json();
// data.bot.telegram_link = "https://t.me/your_bot_username"
```

### Toàn bộ API endpoints

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| POST | `/api/create-bot` | Tạo bot mới |
| GET | `/api/bots` | Danh sách bot |
| GET | `/api/bot/:id` | Chi tiết bot |
| PUT | `/api/bot/:id` | Cập nhật bot (URL, tin nhắn) |
| DELETE | `/api/bot/:id` | Xóa bot |
| GET | `/api/bot/:id/analytics` | Thống kê |
| POST | `/api/bot/:id/broadcast` | Gửi tin hàng loạt |
| POST | `/api/bot/:id/webhook` | Thêm webhook |
| POST | `/api/bot/:id/restart` | Restart bot |

---

## 📱 Luồng người dùng

```
Người dùng tìm thấy bot → /start
                                ↓
                  Bot gửi tin nhắn chào mừng
                  + Nút inline [🚀 Mở Mini App]
                                ↓
                  Người dùng nhấn nút
                                ↓
              Telegram mở web_url của bạn
              trong WebView trong app Telegram
```

---

## 🎛️ Dashboard Admin

URL: `https://your-app.onrender.com/dashboard`

- Xem tất cả bot và trạng thái
- Thêm/sửa/xóa bot
- Xem analytics và người dùng
- Quản lý API keys
- Broadcast tin nhắn

---

## ⚠️ Lưu ý

- **Render Free Tier**: Server tắt sau 15 phút không có request. Dùng UptimeRobot để ping mỗi 10 phút.
- **DB**: Free tier dùng `/tmp` → **mất dữ liệu khi restart**. Nâng cấp Render Persistent Disk ($7/tháng) hoặc dùng Render PostgreSQL.
- **Bot Token**: Phải là token hợp lệ từ @BotFather, và bot không được đang chạy ở nơi khác.
- **HTTPS**: `web_url` phải là HTTPS (yêu cầu của Telegram Web App).
