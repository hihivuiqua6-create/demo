# v2.1 (Đợt 1)

## Mới
- **Chat menu button** tự set khi bot start → hiện nút "Mở Shop" ở **góc trái dưới** input Telegram (fix lỗi MiniApp không mở trên PC).
- Lưu **mọi tin nhắn** user gửi cho bot vào `bot_messages` (in/out).
- Admin tab **"Người dùng & Tin nhắn"**: list user mọi bot, filter theo bot, search, click → xem chat history + trả lời trực tiếp.
- Admin tab **"Broadcast"**: gửi thông báo đến toàn bộ user (mọi bot hoặc 1 bot), kèm lịch sử + đếm sent/failed, throttle ~25 msg/s tránh Telegram rate limit.
- Welcome message hỗ trợ biến `{monthly_users}` (số user active 30 ngày).
- Dashboard thêm card: User/tháng, Tin nhắn.
- API mới: `GET /api/users`, `GET /api/users/:botId/:tgUserId/messages`, `POST /api/users/:botId/:tgUserId/send`, `POST /api/broadcast`, `GET /api/broadcasts`.
- Seller cũng dùng được Users/Broadcast nhưng giới hạn trong bot của mình (qua cùng API, đã check quyền).

## Anti-crack
- License check vẫn còn nhưng **mặc định TẮT** (`LICENSE_REQUIRED=0`). Bật bằng env `LICENSE_REQUIRED=1` + `LICENSE_VERIFY_URL=https://...`.

## Bỏ
- ❌ Bot war/spam (theo yêu cầu).
- ❌ Login bằng credential lạ (theo yêu cầu).

## Đã KHÔNG làm trong đợt này (đợt sau nếu cần)
- Seller UI: chưa thêm tab Users/Broadcast vào `seller.html` (API đã hỗ trợ).
- Bot factory (tạo bot theo template) — cần thiết kế chi tiết.
- "AI riêng < 20MB": không khả thi như đã giải thích.
- Auto-deploy zip lên Render từ UI.
