# v4.0.0
- Tách bot **auto-reply** (autoreply_token) khỏi bot mini-app — 2 bot chạy độc lập
- **License key** bắt buộc: bot chỉ chạy khi server xác thực (local HMAC hoặc remote LICENSE_SERVER_URL)
- Lệnh `/autorep <nội dung> | <số_lần>` và `/autorep_off` (chỉ controller_tg_id dùng được)
- Tạo seller có thể **gán bot quản lý ngay** (assign_bot_id)
- Upload nguồn web: chấp nhận **ZIP** hoặc **Folder**, có **index.html / .htm / .php**
- `public_url_override` cho từng bot → fix nút Mini App khi dùng ZIP (cần HTTPS)
- Sửa bug nút Mini App không hiện khi web là localhost HTTP

# v3.1.0 (cũ)
- ZIP web hosting, auto-reply + exceptions, seller expiry, broadcast, message tools.
