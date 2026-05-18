
const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname,'../public')));

app.get('/', (req,res)=>{
const user = req.query.user || 'AuzaStore';
res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AuzaStore Mini App</title>
<style>
body{
font-family:Arial;
background:linear-gradient(135deg,#ffc6f0,#d8a6ff);
display:flex;
justify-content:center;
align-items:center;
height:100vh;
margin:0;
}
.card{
width:90%;
max-width:450px;
background:white;
border-radius:28px;
padding:22px;
box-shadow:0 10px 30px rgba(0,0,0,.15);
}
.title{
font-size:32px;
font-weight:bold;
}
.btn{
margin-top:25px;
width:100%;
padding:18px;
border:none;
border-radius:18px;
background:#d56cff;
color:white;
font-size:24px;
font-weight:bold;
}
</style>
</head>
<body>
<div class="card">
<div class="title">🌟 HỆ THỐNG DỊCH VỤ TỰ ĐỘNG</div>
<hr>
<h2>👋 Chào 🌸 <b>${user}</b>, hệ thống đã được đồng bộ.</h2>
<p>🚀 Vui lòng nhấn nút bên dưới hoặc Menu để mở App.</p>
<button class="btn">🛒 MỞ SHOP (MINI APP)</button>
</div>
</body>
</html>
`);
});

app.listen(3000, ()=>{
console.log('AuzaStore running...');
});
