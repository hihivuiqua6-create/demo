# v5.0.0 — Userbot Mode (MTProto / gramjs)

## Tính năng mới — gửi tin từ TÀI KHOẢN, không cần bot

- **Tab "Tài khoản TG"**: đăng nhập tài khoản Telegram thật bằng `api_id` + `api_hash` (lấy ở https://my.telegram.org) + số điện thoại. Hệ thống lưu session, tự kết nối lại khi bật server.
  - Hỗ trợ 2FA password.
  - Bật / Tắt / Xoá tài khoản.
- **Tab "Rải tin (Acc)"**: tạo Job rải tin gắn vào 1 tài khoản. Mỗi job có:
  - Danh sách nội dung (xoay vòng từng vòng).
  - Danh sách kênh/nhóm đích (`@username`, link `t.me/...`, hoặc `chat_id`).
  - `delay_seconds` (vòng) + `list_delay_seconds` (giữa các kênh) — **đặt 0 = gửi liền không chờ**.
  - Bật/Tắt từng job độc lập.
- **Yêu cầu**: tài khoản phải đã là thành viên của các nhóm/kênh đích. Không cần add bot vào nhóm nữa.

## Bỏ giới hạn tốc độ

- Floor delay vòng & delay giữa kênh/mục đều hạ về **0** (cả autorai-bot lẫn account-jobs).
- Worker tick: 500ms → **250ms** (autorai-bot) / **100ms** (account-jobs).

## API mới

- `POST /api/accounts/login/start` `{api_id, api_hash, phone, label, owner_seller_id?}` → `{login_id}`
- `POST /api/accounts/login/code` `{login_id, code, password?}` → `{ok, account}`
- `GET / PATCH / DELETE /api/accounts[/id]`
- `GET / POST / PATCH / DELETE /api/account-jobs[/id]`

## Cảnh báo

Telegram giới hạn ~30 msg/giây/acc và ~1 msg/giây tới cùng 1 chat. Đặt delay quá nhỏ + nhiều kênh dễ bị FloodWait hoặc khoá acc tạm thời. Khuyến nghị: nhiều kênh thì giữ `list_delay_seconds >= 1`.

## Cài đặt

```bash
npm install        # cài thêm telegram (gramjs) + input
npm start
```

DB tự migrate (thêm 2 bảng `user_accounts`, `account_jobs`). Không cần xoá data cũ.
