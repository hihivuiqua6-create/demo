# Cập nhật v1.1

## Bot Mini App
- Tin nhắn chào mừng mặc định theo mẫu (🌟 HỆ THỐNG DỊCH VỤ TỰ ĐỘNG ...).
- Hỗ trợ biến động: `{name}`, `{first_name}`, `{last_name}`, `{username}`, `{full_name}`.
  Tên Telegram của user sẽ tự thay vào (ví dụ AuzaStore) mỗi lần /start.
- Tự HTML-escape tên user để tránh injection khi `parse_mode=HTML`.
- Nút mặc định: `🛒 Mở Shop (Mini App)`.

## Bảo mật server
- `JWT_SECRET` lấy từ env, nếu không có sẽ random mỗi lần chạy.
- `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `API_KEY` đọc từ env (mặc định cũ để tương thích).
- Login giới hạn 8 lần / 15 phút / IP (`loginLimiter`).
- So sánh chuỗi dùng `crypto.timingSafeEqual` (chống timing attack) cho login + api_key.
- Helmet + rate-limit toàn cục giữ nguyên.

## Admin UI (`public/admin.html`)
- Viết lại hoàn toàn — dark glassmorphism, Inter + JetBrains Mono, gradient tím-cyan.
- Sidebar có icon SVG, section group, footer user/logout.
- Trang Dashboard / Bots / Add / Users / Docs riêng biệt, animation fade.
- Toast notifications, responsive mobile (drawer sidebar), empty states.
- Form thêm bot có hint biến động + link BotFather + hỏi API key khi submit.

## Env nên set khi deploy
```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<mật khẩu mạnh>
JWT_SECRET=<chuỗi random 48+ byte>
API_KEY=<key cho web riêng>
PORT=3000
```
