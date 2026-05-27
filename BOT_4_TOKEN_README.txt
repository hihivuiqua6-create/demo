HƯỚNG DẪN BẢN TÁCH 4 BOT

1) Bot Mini App
- Nhập ở ô: Bot token (BotFather).
- Bot này chỉ lo /start, nút mở Mini App, menu web.

2) Bot Auto-reply
- Nhập ở ô: Auto-reply bot token.
- Có thể để trống nếu muốn dùng chung Mini App, nhưng nên dùng token riêng để đỡ lag/conflict.

3) Bot Rải
- Vào mục Bot rải / Auto-rải có sẵn trong admin.
- Add token bot rải như bình thường. Bot này độc lập với Mini App và bot lệnh.

4) Bot Lệnh bán acc/admin
- Trong popup thêm/sửa bot, nhập ô: Bot lệnh bán acc token.
- Nếu để trống thì lệnh bán acc chạy chung bot Mini App. Nếu nhập token riêng thì bot Mini App sẽ không bị dính lệnh bán acc nữa.

LỆNH USER CÔNG KHAI CỦA BOT LỆNH
/start
/nap
/khoacc
/lichsu

LỆNH ADMIN ẨN
/keyadmin KEY
/admin
/themacc
/thongbao nội dung
/taokeyadmin ghi_chú
/listkeyadmin
/setbank BANKCODE|STK|CHU TK
/bank

GHI CHÚ TỐI ƯU
- Mỗi bot dùng token khác nhau để tránh lỗi Telegram 409 Conflict.
- Không chạy cùng một token ở nhiều host/server khác nhau.
- Bot lệnh chỉ public menu command cho user; lệnh admin vẫn dùng được nhưng không hiện trong menu.
- Khi sửa token bot lệnh/auto-reply, server sẽ tự restart đúng bot đó.
