# v5.1.0 — Tag user khi rải + Admin UI mobile

## Tag user trong Job rải tin (Acc)
- Mỗi job có thêm danh sách **Tag user**: `@username`, link `t.me/user`, hoặc `user_id`.
- 2 chế độ:
  - **Append**: tự nối các mention vào cuối nội dung tin nhắn.
  - **Placeholder**: thay vào `{mentions}` trong nội dung (tự đặt vị trí).
- **Số user tag mỗi lần** (mentions_per_send): 0 = tag tất cả; >0 = xoay vòng N user mỗi vòng (tránh spam, giảm risk).
- API: thêm field `mentions[]`, `mention_mode`, `mentions_per_send` trên `POST/PATCH /api/account-jobs`.

> Mục đích chính: rải link nhóm có ping thành viên để kéo người vào nhóm. Đừng lạm dụng — tag nhiều dễ bị report ⚠️.

## Admin UI tối ưu cho điện thoại
- Sidebar chuyển thành drawer trượt từ trái + nút hamburger nổi ở góc.
- Bảng có scroll ngang, modal full-width, input cỡ ≥16px (không zoom iOS).
- Topbar stack dọc, grid 2 cột tự đổ về 1 cột trên màn ≤480px.
- Áp dụng cho cả `admin.html` và `seller.html`.

## Migration
DB tự `ALTER TABLE account_jobs` thêm 3 cột mới — không cần migrate tay.
