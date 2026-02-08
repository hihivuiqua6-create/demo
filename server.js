import express from 'express';
import session from 'express-session';
import bcrypt from 'bcrypt';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from '@xenova/transformers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session config
app.use(session({
  secret: 'ai-chat-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ============ DATABASE (In-Memory) ============
const users = [
  {
    id: 1,
    username: 'admin',
    password: await bcrypt.hash('admin123', 10),
    role: 'admin',
    vip: true
  },
  {
    id: 2,
    username: 'user',
    password: await bcrypt.hash('123456', 10),
    role: 'user',
    vip: false
  },
  {
    id: 3,
    username: 'vip',
    password: await bcrypt.hash('vip123', 10),
    role: 'user',
    vip: true
  }
];

// ============ AI MODELS (FREE - NO API KEY) ============
let normalAI = null;
let vipAI = null;

console.log('🤖 Đang tải AI models...');

// Load AI models
async function loadAIModels() {
  try {
    console.log('📦 Loading Normal AI...');
    normalAI = await pipeline('text-generation', 'Xenova/DialoGPT-small');
    
    console.log('📦 Loading VIP AI...');
    vipAI = await pipeline('text-generation', 'Xenova/Qwen2.5-0.5B-Instruct', {
      quantized: true
    });
    
    console.log('✅ AI models loaded!');
  } catch (error) {
    console.error('❌ Error loading AI:', error);
  }
}

// ============ MIDDLEWARE ============
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Chưa đăng nhập!' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = users.find(u => u.id === req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Không có quyền admin!' });
  }
  next();
}

// ============ AUTH ROUTES ============

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ!' });
    }
    
    if (users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Username đã tồn tại!' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: users.length + 1,
      username,
      password: hashedPassword,
      role: 'user',
      vip: false
    };
    
    users.push(newUser);
    res.json({ success: true, message: 'Đăng ký thành công!' });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server!' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(400).json({ error: 'Sai tài khoản hoặc mật khẩu!' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Sai tài khoản hoặc mật khẩu!' });
    }
    
    req.session.userId = user.id;
    res.json({ 
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        vip: user.vip
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi server!' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireLogin, (req, res) => {
  const user = users.find(u => u.id === req.session.userId);
  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    vip: user.vip
  });
});

// ============ AI CHAT ============

app.post('/api/chat', requireLogin, async (req, res) => {
  try {
    const { message } = req.body;
    const user = users.find(u => u.id === req.session.userId);
    
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Tin nhắn trống!' });
    }
    
    if (!normalAI || !vipAI) {
      return res.status(503).json({ error: 'AI đang khởi động...' });
    }
    
    let reply = '';
    let modelName = '';
    
    if (user.vip) {
      modelName = '🌟 Qwen AI (VIP)';
      const prompt = `<|im_start|>system
Bạn là trợ lý AI thông minh.<|im_end|>
<|im_start|>user
${message}<|im_end|>
<|im_start|>assistant`;
      
      const result = await vipAI(prompt, {
        max_new_tokens: 200,
        temperature: 0.7,
        do_sample: true
      });
      
      reply = result[0].generated_text.split('<|im_start|>assistant')[1] || result[0].generated_text;
      reply = reply.split('<|im_end|>')[0].trim();
      
    } else {
      modelName = '💬 DialoGPT (Free)';
      const result = await normalAI(message, {
        max_new_tokens: 100,
        temperature: 0.8
      });
      
      reply = result[0].generated_text;
      if (reply.includes(message)) {
        reply = reply.split(message)[1] || reply;
      }
      reply = reply.trim();
    }
    
    if (!reply) {
      reply = user.vip ? 'Tôi có thể giúp gì?' : 'Xin chào!';
    }
    
    res.json({ 
      success: true,
      reply: reply,
      model: modelName,
      isVip: user.vip
    });
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Lỗi AI!' });
  }
});

// ============ ADMIN ROUTES ============

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const userList = users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    vip: u.vip
  }));
  res.json(userList);
});

app.post('/api/admin/toggle-vip/:userId', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userId);
  const user = users.find(u => u.id === userId);
  
  if (!user) {
    return res.status(404).json({ error: 'User không tồn tại!' });
  }
  
  if (user.role === 'admin') {
    return res.status(400).json({ error: 'Không thể sửa admin!' });
  }
  
  user.vip = !user.vip;
  res.json({ 
    success: true,
    message: `${user.vip ? 'Cấp' : 'Hủy'} VIP cho ${user.username}!`,
    user: { id: user.id, username: user.username, vip: user.vip }
  });
});

app.delete('/api/admin/delete-user/:userId', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userId);
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User không tồn tại!' });
  }
  
  if (users[userIndex].role === 'admin') {
    return res.status(400).json({ error: 'Không thể xóa admin!' });
  }
  
  const deletedUser = users.splice(userIndex, 1)[0];
  res.json({ success: true, message: `Đã xóa ${deletedUser.username}!` });
});

// ============ START ============

const PORT = process.env.PORT || 3000;

loadAIModels().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════╗
║  🚀 SERVER: http://localhost:${PORT}
║  👤 admin / admin123
║  👤 user / 123456  
║  👤 vip / vip123
╚════════════════════════════════╝
    `);
  });
});
