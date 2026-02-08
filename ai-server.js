require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Khởi tạo Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Lưu conversation theo session
const conversations = new Map();

app.use(cors());
app.use(express.json());

// Middleware kiểm tra API key (optional, để debug)
app.use((req, res, next) => {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ GROQ_API_KEY chưa được set trong Environment Variables!');
  }
  next();
});

// Endpoint chat chính - thông minh nhờ Groq LLM
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    // Lấy hoặc tạo history cho session
    if (!conversations.has(sessionId)) {
      conversations.set(sessionId, []);
    }
    const history = conversations.get(sessionId);

    // Thêm tin nhắn user vào history
    history.push({ role: 'user', content: message.trim() });

    // Lấy 12 tin nhắn gần nhất để làm context (tiết kiệm token)
    const context = history.slice(-12);

    // Gọi Groq API
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Bạn là một AI Assistant siêu thông minh, hài hước, thân thiện, trả lời tự nhiên bằng tiếng Việt (hoặc ngôn ngữ người dùng dùng). 
          Luôn hữu ích, chính xác, đôi khi troll nhẹ nhàng. Dùng kiến thức rộng, suy nghĩ logic, trả lời chi tiết nhưng ngắn gọn khi cần.
          Nhớ context từ lịch sử hội thoại để trả lời liền mạch.`
        },
        ...context  // gửi lịch sử làm context
      ],
      model: 'llama-3.3-70b-versatile',          // model mạnh + nhanh, free tier ok
      // model: 'mixtral-8x7b-32768',             // nếu muốn thay đổi
      temperature: 0.7,                           // sáng tạo vừa phải
      max_tokens: 1200,
      top_p: 0.9,
      stream: false
    });

    const aiResponse = completion.choices[0]?.message?.content?.trim() || 'Không có phản hồi từ AI. Thử lại nhé!';

    // Thêm response của AI vào history
    history.push({ role: 'assistant', content: aiResponse });

    // Giới hạn history để không tràn RAM
    if (history.length > 40) {
      history.splice(0, history.length - 30);
    }

    res.json({
      success: true,
      response: aiResponse,
      source: 'Groq LLM (Llama 3.3 70B)',
      timestamp: new Date().toISOString(),
      sessionId
    });

  } catch (error) {
    console.error('Groq API error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Lỗi khi gọi AI. Có thể API key sai hoặc rate limit.',
      details: error.message
    });
  }
});

// Lấy lịch sử hội thoại
app.get('/api/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const history = conversations.get(sessionId) || [];
  res.json({
    success: true,
    history,
    count: history.length
  });
});

// Xóa lịch sử
app.delete('/api/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  conversations.delete(sessionId);
  res.json({
    success: true,
    message: 'Đã xóa lịch sử hội thoại'
  });
});

// Health check cho Render
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI Server Groq-integrated is running',
    version: '4.0',
    groq_key_set: !!process.env.GROQ_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Super Smart AI Chat Server (Groq Powered)',
    version: '4.0',
    description: 'Chat với AI thông minh gần giống Grok, dùng Llama 3.3 70B',
    features: [
      'Context-aware conversation',
      'Natural & humorous responses',
      'Tiếng Việt mượt mà',
      'Session-based memory',
      'Groq API integration'
    ],
    endpoints: {
      'POST /api/chat': 'Gửi tin nhắn chat',
      'GET /api/history/:sessionId': 'Xem lịch sử',
      'DELETE /api/history/:sessionId': 'Xóa lịch sử',
      'GET /health': 'Kiểm tra server'
    }
  });
});

// Khởi động server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║ 🧠 SUPER SMART AI SERVER (GROQ) v4.0 STARTED 🧠 ║
╚════════════════════════════════════════════════════╝
🚀 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔑 Groq Key: ${process.env.GROQ_API_KEY ? 'SET' : 'MISSING - Check Env Vars!'}
Model: llama-3.3-70b-versatile
Ready to chat siêu thông minh! 💬
  `);
});

// Graceful shutdown cho Render
process.on('SIGTERM', () => {
  console.log('SIGTERM received → Shutting down gracefully...');
  process.exit(0);
});
