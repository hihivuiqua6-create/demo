# v4.2.0 — Tăng tốc Auto-Rải

- Worker tick: 5000ms → **500ms** (kiểm tra mỗi nửa giây).
- Floor delay vòng: 10s → **1s** (mặc định mới 30s).
- Floor delay giữa kênh/mục: 1s → **0s** (mặc định mới 2s, có thể đặt 0 = gửi liền không chờ).
- Admin chỉnh trực tiếp trên tab "Auto-Rải Bot" (nút Delay) hoặc khi tạo bot.
- API `POST/PATCH /api/autorai` chấp nhận `delay_seconds ≥ 1` và `list_delay_seconds ≥ 0`.

> Lưu ý: Telegram giới hạn ~30 msg/giây toàn cục và ~1 msg/giây tới cùng 1 chat. Đặt quá thấp dễ bị FloodWait/ban token. Khuyến nghị tối thiểu vòng 5s, list 1s khi có nhiều kênh.
