# TGBot Platform v3.0

**Hệ thống quản lý đa Bot Telegram + Mini App + Auto-reply + Web hosting từ ZIP.**

---

## ✨ Có gì mới ở v3.0

| Tính năng | Mô tả |
|---|---|
| 🤖 **Auto-reply (trả lời tự động)** | Bật/tắt riêng từng bot, có template với biến `{full_name}`, `{username}`... và **danh sách ngoại lệ** (user không nhận auto-reply) |
| 📦 **Upload ZIP web** | Thay vì dán link, bạn có thể **upload file ZIP chứa nguyên source web** — bot sẽ tự host và phục vụ tại `/site/<bot_id>/`. Vẫn dùng được làm Mini App. |
| ⏳ **Hạn dùng cho seller** | Admin cấp seller theo **số ngày** (vd 30, 60). Hết hạn → hệ thống **tự khoá tài khoản, dừng bot, xoá web đã host, xoá seller**. Có check 60 giây/lần. |
| 🗑 **Xoá tin nhắn** | Chọn nhiều tin xoá, xoá toàn bộ tin với 1 user, xoá toàn bộ tin của 1 bot, hoặc **admin xoá toàn hệ thống**. |
| 🎨 **Admin UI mới** | Sidebar tab, dashboard có cảnh báo seller sắp hết hạn, modal sửa bot gọn gàng. |
| 👤 **Gán bot cho seller** | Admin có thể tạo bot rồi gán cho 1 seller làm chủ (seller chỉ thấy & quản bot của mình). |

---

## 🚀 Cài đặt

```bash
npm install
npm start             # chạy production
npm run dev           # chạy dev (nodemon)
```

Mở: <http://localhost:3000> → đăng nhập **admin / admin123456**.

### Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng |
| `ADMIN_USERNAME` | `admin` | Tài khoản admin |
| `ADMIN_PASSWORD` | `admin123456` | **Bắt buộc đổi khi lên production** |
| `JWT_SECRET` | random | Đặt cố định để session ổn định |
| `PUBLIC_BASE_URL` | (trống) | URL HTTPS công khai. **Cần khi dùng bot ZIP web** (Telegram chỉ chấp nhận HTTPS cho Mini App). VD `https://yourdomain.com` |
| `ZIP_MAX_MB` | `50` | Giới hạn dung lượng zip web |
| `DB_PATH` | `database/tgbot.db` | Đường dẫn SQLite |

---

## 📦 Cách dùng tính năng ZIP web

1. Vào **Admin → Bots → Sửa bot → mở mục "📦 Upload ZIP source web"**.
2. Chọn file `.zip` (chứa `index.html` ở thư mục gốc, hoặc trong 1 thư mục bao ngoài duy nhất).
3. Bấm **Upload**.
4. Bot tự khởi động lại, nút Menu của bot sẽ trỏ tới `https://<PUBLIC_BASE_URL>/site/<bot_id>/`.

> **Lưu ý**: nếu server chưa có HTTPS công khai (vd đang chạy localhost), Telegram Mini App **không mở được**. Trong dev có thể test bằng cách mở thẳng URL `/site/<bot_id>/` trên trình duyệt.

---

## 🤖 Cách dùng auto-reply

1. Sửa bot → mục **🤖 Auto-reply** → tick "Bật".
2. Nhập template (hoặc để trống dùng mặc định). Hỗ trợ biến:
   - `{full_name}`, `{first_name}`, `{last_name}`, `{username}`, `{monthly_users}`
   - HTML: `<b>`, `<i>`, `<a href>`, ...
3. **Ngoại lệ**: thêm TG user ID không muốn bị auto-reply (vd admin, support).
4. `/start` luôn dùng welcome message (không bị thay bằng auto-reply).

---

## ⏳ Cách cấp seller có hạn

- Tạo seller mới → nhập "Hạn dùng (số ngày)", vd `30` = 30 ngày.
- Hết hạn: **hệ thống tự xoá** seller + tất cả bot của họ + web ZIP đã host.
- Gia hạn: bấm **+ Ngày** ở dòng seller, nhập số ngày cộng thêm.
- Để seller dùng vĩnh viễn: bỏ trống ô số ngày khi tạo.

---

## 🗑 Xoá tin nhắn

| Cách | Ai dùng | Tác dụng |
|---|---|---|
| Tab Tin nhắn → chọn checkbox → "Xoá đã chọn" | Admin + Seller | Xoá từng tin riêng lẻ |
| "Xoá hết tin với user này" | Admin + Seller | Xoá hết log chat 1 user |
| API `DELETE /api/bots/:id/messages` | Admin + Seller (bot của mình) | Xoá hết tin của 1 bot |
| Nút "🗑 Xoá toàn hệ thống" | **Chỉ Admin** | Xoá toàn bộ tin nhắn của mọi bot |

---

## 🗂 Cấu trúc thư mục

```
tgbot-platform/
├─ src/server.js           # toàn bộ backend
├─ public/
│  ├─ login.html
│  ├─ admin.html           # admin UI mới
│  ├─ seller.html          # seller UI mới
│  ├─ app.css
│  └─ uploads/             # ảnh QR, file upload
├─ sites/                  # ZIP web đã giải nén, mỗi bot 1 thư mục bot-<id>/
├─ database/tgbot.db       # SQLite
└─ package.json
```

---

## 🔌 API chính (dùng JWT trong header `Authorization: Bearer <token>`)

### Bot
- `GET /api/bots` — list (filter theo quyền)
- `POST /api/bots` — tạo
- `PATCH /api/bots/:id` — sửa (web_url, welcome, auto_reply_enabled, auto_reply_text, button_label, active, owner_seller_id\*, web_mode)
- `DELETE /api/bots/:id` — xoá toàn bộ
- `POST /api/bots/:id/site-zip` — upload zip (multipart, field `zip`)
- `DELETE /api/bots/:id/site-zip` — gỡ web hosted
- `GET/POST/DELETE /api/bots/:id/autoreply/exceptions` — quản ngoại lệ

### Seller (admin)
- `GET /api/admin/sellers`
- `POST /api/admin/sellers` — body: `{username,password,display_name,days}`
- `PATCH /api/admin/sellers/:id` — `{add_days, set_expires_at, clear_expiry, balance_delta, password, active}`
- `DELETE /api/admin/sellers/:id`

### Tin nhắn
- `GET /api/users?bot_id&q`
- `GET /api/users/:botId/:tgUserId/messages`
- `POST /api/users/:botId/:tgUserId/send` — admin/seller gửi tin trực tiếp
- `POST /api/messages/delete` — body: `{ids:[...]}`
- `DELETE /api/users/:botId/:tgUserId/messages`
- `DELETE /api/bots/:id/messages`
- `DELETE /api/admin/messages/all` — **admin only**

### Khác
- `POST /api/broadcast` — `{text, bot_id?}`
- `GET /api/stats`
- `POST /api/seller/topups` `{amount}` → trả mã CK
- `POST /api/admin/topups/:id/approve` / `reject`

---

## 🛡 Bảo mật

- Mật khẩu seller: scrypt + salt.
- JWT 7 ngày.
- Rate-limit login (20 / 15 phút) và broadcast (5 / phút).
- ZIP upload: kiểm tra path-traversal, bắt buộc có `index.html`, giới hạn dung lượng.
- Seller chỉ xem/sửa được bot của mình (kiểm tra `owner_seller_id`).

---

## 📝 Bản quyền

Bạn được toàn quyền sửa, deploy. **Đổi `ADMIN_PASSWORD` và `JWT_SECRET` trước khi lên production.**
