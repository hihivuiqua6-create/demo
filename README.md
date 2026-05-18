# 🤖 Telegram Mini App Platform

Một server trung tâm để quản lý **nhiều Telegram bot** và **nhiều Mini App HTML** trên **một GitHub repo + một Render deploy**.

---

## ✨ Tính năng

- 🤖 **Multi-bot**: Thêm nhiều bot chỉ bằng token
- 📱 **Multi Mini App**: Nhiều file HTML trên 1 bot
- 📝 **HTML Editor**: Viết/sửa HTML ngay trên dashboard
- 🎨 **HTML Builder**: Kéo-thả component tạo Mini App
- 📊 **Analytics**: Theo dõi users, events, app opens
- 👥 **User Management**: Xem danh sách Telegram users
- 📣 **Broadcast**: Gửi tin nhắn hàng loạt
- 🔗 **Webhooks**: Tích hợp với hệ thống ngoài
- 💾 **Database**: SQLite tự động
- 🔐 **Admin login**: JWT authentication

---

## 🚀 Deploy lên Render (miễn phí)

### Bước 1: Fork / Push lên GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/tma-platform.git
git push -u origin main
```

### Bước 2: Tạo Web Service trên Render

1. Vào [render.com](https://render.com) → New → **Web Service**
2. Connect GitHub repo vừa push
3. Cài đặt:
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run setup`
   - **Start Command**: `npm start`

### Bước 3: Set Environment Variables trên Render

| Key | Value |
|-----|-------|
| `BASE_URL` | `https://your-app.onrender.com` |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | `your_strong_password` |
| `JWT_SECRET` | `random_secret_string_here` |
| `PORT` | `3000` |

### Bước 4: Deploy!

Render sẽ tự build và deploy. Vào `https://your-app.onrender.com/dashboard` để đăng nhập.

---

## 📱 Cách dùng

### Thêm Bot

1. Tạo bot với [@BotFather](https://t.me/BotFather) → lấy token
2. Vào Dashboard → **Quản lý Bots** → **+ Thêm Bot**
3. Paste token vào → nhấn **Tạo Bot**

### Upload Mini App

1. Chọn bot trong sidebar
2. Vào **Mini Apps** → **+ Upload** hoặc **✏️ Editor HTML**
3. Upload file `.html` hoặc viết HTML trực tiếp
4. Nhấn **Save**

### Bot sẽ hoạt động như thế nào?

Khi user gửi `/start` cho bot:

```
👋 Xin chào Nguyễn!

Chào mừng! Nhấn nút bên dưới để mở Mini App.

[🚀 Mở Mini App]  ← Nút mở web app
```

### URL Mini App

```
https://your-app.onrender.com/app/{botId}/{miniappId}
```

---

## 🗂️ Cấu trúc thư mục

```
telegram-miniapp-platform/
├── src/
│   ├── server.js          # Entry point
│   ├── database.js        # SQLite setup
│   ├── botManager.js      # Quản lý nhiều bot
│   ├── setup.js           # Tạo admin user
│   ├── middleware/
│   │   └── auth.js        # JWT auth
│   └── routes/
│       ├── auth.js        # Login API
│       ├── bots.js        # Bot CRUD API
│       ├── miniapps.js    # Mini App upload API
│       ├── stats.js       # Analytics & Users API
│       └── webhooks.js    # Webhook API
├── public/
│   ├── dashboard/
│   │   └── index.html     # Admin dashboard
│   └── miniapps/
│       └── demo.html      # Example mini app
├── data/                  # SQLite DB (auto-created)
├── uploads/               # Uploaded files (auto-created)
├── .env.example
├── package.json
└── README.md
```

---

## 🔧 Local Development

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/tma-platform.git
cd tma-platform

# Install
npm install

# Copy env
cp .env.example .env
# Sửa .env: set BASE_URL=https://your-ngrok-url.ngrok.io

# Setup admin
npm run setup

# Start
npm run dev
```

> **Lưu ý**: Mini App của Telegram **bắt buộc HTTPS**. Khi dev local, dùng [ngrok](https://ngrok.com): `ngrok http 3000`

---

## 📡 API Reference

### Auth
- `POST /api/auth/login` - Đăng nhập
- `POST /api/auth/change-password` - Đổi mật khẩu

### Bots
- `GET /api/bots` - Danh sách bots
- `POST /api/bots` - Tạo bot mới (body: `{token, welcomeMessage, welcomeButtonText}`)
- `GET /api/bots/:id` - Chi tiết bot
- `PUT /api/bots/:id` - Cập nhật cài đặt
- `DELETE /api/bots/:id` - Xoá bot
- `POST /api/bots/:id/start|stop|restart` - Điều khiển bot
- `POST /api/bots/:id/broadcast` - Gửi broadcast

### Mini Apps
- `GET /api/bots/:botId/miniapps` - Danh sách apps
- `POST /api/bots/:botId/miniapps` - Upload app (multipart hoặc `{htmlContent, name}`)
- `PUT /api/bots/:botId/miniapps/:id` - Cập nhật app
- `DELETE /api/bots/:botId/miniapps/:id` - Xoá app
- `GET /api/bots/:botId/miniapps/:id/content` - Lấy HTML để edit
- `POST /api/bots/:botId/miniapps/:id/set-default` - Đặt làm default

### Analytics & Users
- `GET /api/bots/:botId/analytics?days=7` - Thống kê
- `GET /api/bots/:botId/users` - Danh sách users

### Webhooks
- `GET/POST /api/bots/:botId/webhooks` - Quản lý webhooks

---

## 🔐 Bảo mật

- Đổi `ADMIN_PASSWORD` và `JWT_SECRET` ngay sau khi deploy
- Token bot được lưu encrypted trong database
- Rate limiting: 200 requests/15 phút per IP

---

## 📝 Ghi chú

- Render free tier có thể sleep sau 15 phút không hoạt động. Dùng [UptimeRobot](https://uptimerobot.com) để ping `/health` mỗi 5 phút.
- SQLite data bị reset khi Render restart (free tier). Nâng cấp hoặc dùng [Turso](https://turso.tech) cho persistent DB.
- Mini App Telegram **yêu cầu HTTPS** và domain không phải `localhost`.

---

Made with ❤️ for the Telegram Mini App community
