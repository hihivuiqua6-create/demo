const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory database (thay bằng MongoDB trong production)
const users = [];
const messages = [];
const onlineUsers = new Map();

// Secret key cho JWT
const JWT_SECRET = 'your-secret-key-change-this';

// API: Đăng ký tài khoản
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, avatar } = req.body;

    // Kiểm tra user đã tồn tại
    const existingUser = users.find(u => u.email === email || u.username === username);
    if (existingUser) {
      return res.status(400).json({ error: 'Username hoặc email đã tồn tại' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Tạo user mới
    const newUser = {
      id: Date.now().toString(),
      username,
      email,
      password: hashedPassword,
      avatar: avatar || `https://ui-avatars.com/api/?name=${username}&background=random`,
      createdAt: new Date()
    };

    users.push(newUser);

    // Tạo token
    const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        avatar: newUser.avatar
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// API: Đăng nhập
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Tìm user
    const user = users.find(u => u.email === email);
    if (!user) {
      return res.status(400).json({ error: 'Email hoặc password không đúng' });
    }

    // Kiểm tra password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(400).json({ error: 'Email hoặc password không đúng' });
    }

    // Tạo token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// API: Lấy danh sách users
app.get('/api/users', (req, res) => {
  const userList = users.map(u => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    online: onlineUsers.has(u.id)
  }));
  res.json(userList);
});

// API: Lấy tin nhắn giữa 2 users
app.get('/api/messages/:userId1/:userId2', (req, res) => {
  const { userId1, userId2 } = req.params;
  const conversation = messages.filter(m => 
    (m.from === userId1 && m.to === userId2) || 
    (m.from === userId2 && m.to === userId1)
  );
  res.json(conversation);
});

// Socket.io cho real-time chat
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User đăng nhập
  socket.on('user-online', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('user-status-change', { userId, online: true });
  });

  // Gửi tin nhắn
  socket.on('send-message', (data) => {
    const message = {
      id: Date.now().toString(),
      from: data.from,
      to: data.to,
      text: data.text,
      timestamp: new Date()
    };
    
    messages.push(message);
    
    // Gửi cho người nhận
    const recipientSocketId = onlineUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('receive-message', message);
    }
    
    // Confirm cho người gửi
    socket.emit('message-sent', message);
  });

  // User typing
  socket.on('typing', (data) => {
    const recipientSocketId = onlineUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('user-typing', data.from);
    }
  });

  socket.on('stop-typing', (data) => {
    const recipientSocketId = onlineUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('user-stop-typing', data.from);
    }
  });

  // Video call signaling
  socket.on('call-user', (data) => {
    const recipientSocketId = onlineUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('incoming-call', {
        from: data.from,
        offer: data.offer
      });
    }
  });

  socket.on('accept-call', (data) => {
    const callerSocketId = onlineUsers.get(data.to);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-accepted', {
        from: data.from,
        answer: data.answer
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const recipientSocketId = onlineUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('ice-candidate', {
        from: data.from,
        candidate: data.candidate
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Tìm và xóa user khỏi danh sách online
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        io.emit('user-status-change', { userId, online: false });
        break;
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
