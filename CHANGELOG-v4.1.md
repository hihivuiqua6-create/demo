# v4.1.0
- THÊM loại bot mới: **Auto-Rải Bot** (tách hẳn khỏi bot mini-app).
  Lệnh trong Telegram: `/start`, `/key <KEY>`, `/channel l1 | l2 | ...`,
  `/autoraitinnhan <nd>`, `/list nd1 | nd2 | nd3`, `/run`, `/stop`, `/status`.
- Admin chỉnh `delay_seconds` (giây giữa các vòng) và `list_delay_seconds`
  (giây giữa các kênh/mục) để chống lạm dụng.
- Tạo seller giờ nhận thêm: nhiều bot quản lý (`assign_bot_ids`) và list `@bot`
  mà seller cần quản lí (`managed_bot_usernames`) — lưu ở bảng `seller_managed_bots`.
- API mới: `GET/POST/PATCH/DELETE /api/autorai`, `GET /api/admin/autorai/:id/key`,
  `GET /api/admin/sellers/:id/managed`, `GET /api/seller/managed`.
