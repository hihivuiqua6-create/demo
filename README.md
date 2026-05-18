# 🤖 TGBot Platform

> Deploy **1 lần** lên Render.com → chạy **nhiều bot** Telegram Mini App

---

## 🚀 Deploy lên Render.com

### Bước 1: Push lên GitHub
```bash
git init
git add .
git commit -m "TGBot Platform"
git remote add origin https://github.com/YOUR_USER/tgbot-platform.git
git push -u origin main
```

### Bước 2: Tạo Web Service trên Render
1. Vào https://render.com → **New → Web Service**
2. Connect GitHub repo vừa tạo
3. Cấu hình:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Click **Deploy**

> ⚠️ **KHÔNG cần** thêm bất kỳ Environment Variable nào. Tất cả đã hard-code trong `src/server.js`.

---

## 🔑 Thông tin đăng nhập mặc định

| | |
|---|---|
| Admin URL | `https://your-app.onrender.com/admin` |
| Username | `admin` |
| Password | `admin123456` |
| API Key | `admin123456` |

> ✏️ Để đổi: sửa biến `CONFIG` trong `src/server.js` dòng 12-19

---

## 📡 API để gắn vào web riêng của bạn

### Thêm bot mới
```http
POST https://your-app.onrender.com/api/create-bot
Content-Type: application/json

{
  "token": "BOT_TOKEN_TỪ_BOTFATHER",
  "web_url": "https://your-shop.com",
  "welcome_message": "Chào mừng! 👋 Nhấn để mở shop.",
  "button_text": "🛒 Mở Shop",
  "api_key": "admin123456"
}
```

**Response thành công:**
```json
{
  "success": true,
  "bot_username": "your_bot",
  "bot_name": "Your Bot",
  "message": "Bot @your_bot đã được kích hoạt thành công!"
}
```

### Cập nhật bot
```http
PUT /api/update-bot
{ "token": "...", "web_url": "...", "api_key": "admin123456" }
```

### Xóa bot
```http
DELETE /api/delete-bot
{ "token": "...", "api_key": "admin123456" }
```

### Kiểm tra trạng thái
```http
GET /api/bot-status?token=BOT_TOKEN&api_key=admin123456
```

---

## 💻 Ví dụ form HTML gắn vào web của bạn

```html
<form>
  <input id="botToken" placeholder="Bot Token" />
  <input id="shopUrl" placeholder="https://shop.com" />
  <button type="button" onclick="activateBot()">Kích hoạt Bot</button>
</form>

<script>
async function activateBot() {
  const res = await fetch('https://YOUR-APP.onrender.com/api/create-bot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: document.getElementById('botToken').value,
      web_url: document.getElementById('shopUrl').value,
      welcome_message: 'Chào mừng bạn đến shop của chúng tôi! 👋',
      button_text: '🛒 Mở Shop Ngay',
      api_key: 'admin123456'
    })
  });
  const data = await res.json();
  alert(data.success ? '✅ ' + data.message : '❌ ' + data.error);
}
</script>
```

---

## 🎯 Luồng hoạt động

```
Người dùng thêm token + link web vào web của bạn
        ↓
Web của bạn gọi POST /api/create-bot
        ↓
Server lưu vào SQLite DB + khởi động bot polling
        ↓
User mở Telegram, nhắn /start với bot đó
        ↓
Bot trả về: tin nhắn chào + nút "Mở Mini App"
        ↓
User nhấn nút → Telegram mở web_url của bạn trong WebApp
```

---

## 📁 Cấu trúc thư mục

```
tgbot-platform/
├── src/
│   └── server.js          ← Server chính (Express + Bot Manager)
├── public/
│   └── admin.html         ← Dashboard quản trị
├── database/              ← SQLite DB (tự tạo khi chạy)
├── package.json
└── README.md
```

---

## ⚠️ Lưu ý quan trọng

1. **Render.com Free Plan**: Server tự ngủ sau 15 phút không có request. Bot sẽ tự khởi động lại khi có request tiếp theo (~30 giây). Để luôn bật, dùng Paid plan hoặc cài UptimeRobot ping 10 phút/lần.

2. **SQLite**: Render.com free plan xóa data khi redeploy. Nếu cần data persistent, upgrade lên Render Disk hoặc dùng PlanetScale/Turso.

3. **Bot Token bảo mật**: Không share `api_key`. Đổi password trong `CONFIG` trước khi deploy production.

4. **HTTPS bắt buộc**: Telegram Mini App (`web_app`) chỉ chấp nhận HTTPS URL. Render.com tự cấp HTTPS nên không cần lo.
