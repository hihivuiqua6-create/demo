# TGBot Platform v2 — Changelog

## v2.0 (2026-05-18)

### 🎯 Tính năng mới
- **Seller system**: Admin tạo tài khoản seller (không có public signup). Mỗi seller có số dư riêng.
- **Topup / Nạp tiền**: Seller tạo yêu cầu nạp → nhận nội dung CK random → admin duyệt → cộng tiền.
- **Bank settings**: Admin cấu hình tên bank, STK, chủ TK, upload QR ảnh (PNG/JPG ≤ 2MB).
- **License key**: Tạo bot bắt buộc qua verify với server license (`LICENSE_VERIFY_URL`, default `https://bucac.onrender.com/api/verify-key`). Gửi `{key, device_id}`.
- **Seller portal** tại `/seller` (đăng nhập role=seller).

### 🔒 Bảo mật
- **Bỏ hoàn toàn `X-API-Key`** trong UI admin — chỉ dùng JWT từ /api/auth/login.
- **Strict auth gate** (`/admin`, `/seller` đều check `/api/me` trước khi render; 401 → redirect /login).
- **Không có cách bypass**: file admin.html/seller.html không thể vào được nếu không có token hợp lệ.
- Password seller hash bằng **scrypt + salt**.
- `crypto.timingSafeEqual` cho mọi so sánh secret.
- `helmet`, rate-limit login (10/15min).
- Bot token + web_url validate format trước khi insert.

### ENV
```
PORT=3000
ADMIN_USERNAME=auzastore
ADMIN_PASSWORD=<mật khẩu mạnh>
JWT_SECRET=<random 48+ bytes>
LICENSE_VERIFY_URL=https://bucac.onrender.com/api/verify-key
DEVICE_ID=<định danh máy chủ, default = hostname>
DB_PATH=./database/tgbot.db
```

### Endpoints chính
- `POST /api/auth/login` `{username,password,role}` — login admin hoặc seller
- `GET  /api/me` — info user hiện tại
- `POST /api/bots` `{license_key,token,web_url,...}` — tạo bot (verify license trước)
- `GET/POST /api/admin/sellers` — quản lý seller
- `GET/POST /api/admin/bank`, `POST /api/admin/bank/qr-upload` — cấu hình bank
- `POST /api/seller/topups` — tạo yêu cầu nạp (tự sinh nội dung CK random)
- `POST /api/admin/topups/:id/approve|reject` — duyệt nạp

### Welcome message
Hỗ trợ biến: `{name} {first_name} {last_name} {username} {full_name}` — tự thay theo user `/start`.

## v1.0
- Multi-bot Telegram Mini App, admin panel cơ bản.
