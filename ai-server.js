const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// AI Knowledge Base - Được mở rộng liên tục
const aiKnowledge = {
  greetings: ['xin chào', 'hello', 'hi', 'chào', 'hế lô', 'halo', 'hey'],
  farewells: ['tạm biệt', 'bye', 'goodbye', 'chào tạm biệt', 'hẹn gặp lại'],
  thanks: ['cảm ơn', 'thank', 'thanks', 'cám ơn', 'thank you'],
  
  // Từ khóa cần tìm kiếm web
  webSearchKeywords: [
    'tin tức', 'news', 'mới nhất', 'latest', 'hiện tại', 'current',
    'giá', 'price', 'thời tiết', 'weather', 'điểm số', 'score',
    'bao nhiêu', 'how much', 'khi nào', 'when', 'ở đâu', 'where',
    'ai là', 'who is', 'cách', 'how to', 'hướng dẫn', 'guide',
    'tìm kiếm', 'search', 'cho tôi biết', 'tell me about'
  ],
  
  // Code-related keywords
  codeKeywords: ['code', 'lập trình', 'programming', 'bug', 'lỗi', 'function', 
                 'class', 'variable', 'array', 'object', 'debug', 'fix'],
  
  // Math keywords
  mathKeywords: ['tính', 'calculate', '+', '-', '*', '/', '=', 'bằng'],
};

// Hàm phân tích intent của user
function analyzeIntent(message) {
  const lower = message.toLowerCase();
  
  // Kiểm tra greeting
  if (aiKnowledge.greetings.some(g => lower.includes(g))) {
    return { type: 'greeting', confidence: 0.9 };
  }
  
  // Kiểm tra farewell
  if (aiKnowledge.farewells.some(f => lower.includes(f))) {
    return { type: 'farewell', confidence: 0.9 };
  }
  
  // Kiểm tra thanks
  if (aiKnowledge.thanks.some(t => lower.includes(t))) {
    return { type: 'thanks', confidence: 0.9 };
  }
  
  // Kiểm tra cần web search
  if (aiKnowledge.webSearchKeywords.some(k => lower.includes(k))) {
    return { type: 'web_search', confidence: 0.8 };
  }
  
  // Kiểm tra về code
  if (aiKnowledge.codeKeywords.some(k => lower.includes(k))) {
    return { type: 'code', confidence: 0.7 };
  }
  
  // Kiểm tra math
  if (aiKnowledge.mathKeywords.some(k => lower.includes(k)) || /\d+\s*[\+\-\*\/]\s*\d+/.test(message)) {
    return { type: 'math', confidence: 0.85 };
  }
  
  // Default: general question
  return { type: 'general', confidence: 0.5 };
}

// Hàm search web (giả lập - bạn có thể thay bằng API thật)
async function searchWeb(query) {
  // Trong production, bạn dùng API như:
  // - Google Custom Search API
  // - Bing Search API
  // - SerpAPI
  // - DuckDuckGo API
  
  try {
    // Giả lập search với DuckDuckGo Instant Answer API (free)
    const response = await axios.get('https://api.duckduckgo.com/', {
      params: {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1
      },
      timeout: 5000
    });
    
    const data = response.data;
    
    if (data.Abstract) {
      return {
        success: true,
        answer: data.Abstract,
        source: data.AbstractSource,
        url: data.AbstractURL,
        type: 'instant_answer'
      };
    }
    
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      const firstTopic = data.RelatedTopics[0];
      if (firstTopic.Text) {
        return {
          success: true,
          answer: firstTopic.Text,
          source: 'DuckDuckGo',
          url: firstTopic.FirstURL,
          type: 'related_topic'
        };
      }
    }
    
    return {
      success: false,
      message: 'Không tìm thấy thông tin chính xác'
    };
    
  } catch (error) {
    console.error('Search error:', error.message);
    return {
      success: false,
      message: 'Không thể tìm kiếm lúc này',
      error: error.message
    };
  }
}

// Hàm tính toán
function calculate(expression) {
  try {
    // Sanitize input
    const sanitized = expression.replace(/[^0-9+\-*/().]/g, '');
    
    // Sử dụng Function thay vì eval cho an toàn hơn
    const result = Function('"use strict"; return (' + sanitized + ')')();
    
    return {
      success: true,
      result: result,
      expression: sanitized
    };
  } catch (error) {
    return {
      success: false,
      message: 'Không thể tính toán biểu thức này'
    };
  }
}

// Hàm phân tích code
function analyzeCode(code) {
  const issues = [];
  const suggestions = [];
  
  if (code.includes('var ')) {
    issues.push('Nên dùng let hoặc const thay vì var');
  }
  
  if (code.includes('==') && !code.includes('===')) {
    issues.push('Cân nhắc dùng === thay vì == để tránh type coercion');
  }
  
  if (code.includes('eval(')) {
    issues.push('CẢNH BÁO: eval() rất nguy hiểm, tránh sử dụng!');
  }
  
  const openBraces = (code.match(/{/g) || []).length;
  const closeBraces = (code.match(/}/g) || []).length;
  if (openBraces !== closeBraces) {
    issues.push(`Số lượng dấu ngoặc nhọn không khớp: ${openBraces} mở, ${closeBraces} đóng`);
  }
  
  if (code.includes('async') || code.includes('await')) {
    suggestions.push('Đừng quên xử lý errors với try-catch khi dùng async/await');
  }
  
  if (code.includes('.then(') && !code.includes('.catch(')) {
    suggestions.push('Nên thêm .catch() để xử lý errors cho Promise');
  }
  
  return { issues, suggestions };
}

// Generate response dựa trên intent
async function generateResponse(message, intent) {
  const responses = {
    greeting: [
      'Xin chào! Tôi là AI Assistant. Tôi có thể giúp bạn tìm kiếm thông tin, trả lời câu hỏi, phân tích code và nhiều thứ khác. Bạn cần gì?',
      'Chào bạn! Rất vui được gặp bạn. Hãy hỏi tôi bất cứ điều gì bạn muốn biết!',
      'Hello! Tôi sẵn sàng hỗ trợ bạn. Bạn muốn tìm hiểu về điều gì?'
    ],
    farewell: [
      'Tạm biệt! Chúc bạn một ngày tuyệt vời! 👋',
      'Hẹn gặp lại bạn! Đừng ngại quay lại nếu cần giúp đỡ nhé!',
      'Bye bye! Take care! 😊'
    ],
    thanks: [
      'Không có gì! Rất vui được giúp bạn.',
      'Tôi rất vui vì có thể giúp ích! Nếu cần gì thêm cứ hỏi nhé.',
      'You\'re welcome! Luôn sẵn sàng hỗ trợ bạn.'
    ]
  };
  
  // Trả lời cố định cho các intent đơn giản
  if (responses[intent.type]) {
    return {
      message: responses[intent.type][Math.floor(Math.random() * responses[intent.type].length)],
      type: intent.type,
      source: 'built-in'
    };
  }
  
  // Xử lý web search
  if (intent.type === 'web_search') {
    const searchResult = await searchWeb(message);
    
    if (searchResult.success) {
      return {
        message: searchResult.answer,
        type: 'web_search',
        source: searchResult.source,
        url: searchResult.url,
        metadata: {
          searchType: searchResult.type
        }
      };
    } else {
      return {
        message: 'Xin lỗi, tôi không tìm thấy thông tin chính xác về câu hỏi này. Bạn có thể diễn đạt lại hoặc hỏi chi tiết hơn không?',
        type: 'web_search',
        source: 'error',
        error: searchResult.message
      };
    }
  }
  
  // Xử lý math
  if (intent.type === 'math') {
    // Trích xuất biểu thức toán học
    const mathMatch = message.match(/[\d+\-*/().]+/);
    if (mathMatch) {
      const result = calculate(mathMatch[0]);
      if (result.success) {
        return {
          message: `Kết quả: ${result.expression} = ${result.result}`,
          type: 'math',
          source: 'calculator',
          metadata: {
            expression: result.expression,
            result: result.result
          }
        };
      }
    }
  }
  
  // Xử lý code
  if (intent.type === 'code') {
    return {
      message: 'Tôi có thể giúp bạn phân tích code. Hãy paste code vào và tôi sẽ tìm lỗi, đề xuất cải thiện cho bạn!',
      type: 'code',
      source: 'built-in'
    };
  }
  
  // General response với knowledge base
  return {
    message: generateGeneralResponse(message),
    type: 'general',
    source: 'knowledge-base'
  };
}

// Hàm generate câu trả lời chung
function generateGeneralResponse(message) {
  const lower = message.toLowerCase();
  
  // AI/ML related
  if (lower.includes('ai') || lower.includes('trí tuệ nhân tạo')) {
    return 'AI (Artificial Intelligence - Trí tuệ nhân tạo) là khả năng của máy tính để thực hiện các nhiệm vụ thường đòi hỏi trí thông minh của con người, như học tập, suy luận, nhận diện mẫu và ra quyết định. Bạn muốn tìm hiểu về khía cạnh nào của AI?';
  }
  
  // Programming
  if (lower.includes('javascript') || lower.includes('js')) {
    return 'JavaScript là ngôn ngữ lập trình phổ biến nhất cho web development. Nó chạy trên browser (client-side) và cả server (Node.js). Bạn đang gặp vấn đề gì với JavaScript?';
  }
  
  if (lower.includes('python')) {
    return 'Python là ngôn ngữ lập trình đa năng, dễ học và rất mạnh cho data science, AI/ML, web development và automation. Bạn cần giúp gì về Python?';
  }
  
  // Technology
  if (lower.includes('react')) {
    return 'React là thư viện JavaScript phổ biến để xây dựng user interfaces, được phát triển bởi Meta. Nó sử dụng component-based architecture và virtual DOM để render hiệu quả.';
  }
  
  // Default thoughtful response
  const thoughtfulResponses = [
    'Đó là một câu hỏi hay! Để tôi tìm kiếm thông tin chính xác nhất cho bạn... Bạn có thể cho tôi biết thêm chi tiết không?',
    'Hmm, câu hỏi thú vị đấy. Tôi muốn hiểu rõ hơn để đưa ra câu trả lời tốt nhất. Bạn có thể diễn đạt cụ thể hơn được không?',
    'Tôi hiểu bạn đang tìm kiếm thông tin về vấn đề này. Hãy để tôi suy nghĩ... Bạn có thể cho tôi thêm ngữ cảnh không?'
  ];
  
  return thoughtfulResponses[Math.floor(Math.random() * thoughtfulResponses.length)];
}

// Conversation history (trong production nên dùng database)
const conversations = new Map();

function getConversationHistory(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }
  return conversations.get(sessionId);
}

function addToHistory(sessionId, role, message) {
  const history = getConversationHistory(sessionId);
  history.push({
    role,
    message,
    timestamp: new Date().toISOString()
  });
  
  // Giữ tối đa 50 messages
  if (history.length > 50) {
    history.shift();
  }
}

// API Endpoints

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default', code } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        error: 'Message is required',
        success: false 
      });
    }
    
    // Lưu message của user
    addToHistory(sessionId, 'user', message);
    
    // Phân tích intent
    const intent = analyzeIntent(message);
    
    // Generate response
    let response = await generateResponse(message, intent);
    
    // Nếu có code, phân tích code
    if (code && code.trim()) {
      const codeAnalysis = analyzeCode(code);
      response.codeAnalysis = codeAnalysis;
      
      if (codeAnalysis.issues.length > 0 || codeAnalysis.suggestions.length > 0) {
        let analysisText = '\n\nPhân tích code:\n';
        if (codeAnalysis.issues.length > 0) {
          analysisText += '⚠️ Vấn đề: ' + codeAnalysis.issues.join(', ') + '\n';
        }
        if (codeAnalysis.suggestions.length > 0) {
          analysisText += '💡 Gợi ý: ' + codeAnalysis.suggestions.join(', ');
        }
        response.message += analysisText;
      }
    }
    
    // Lưu response của AI
    addToHistory(sessionId, 'assistant', response.message);
    
    res.json({
      success: true,
      response: response.message,
      intent: intent.type,
      source: response.source,
      metadata: response.metadata || {},
      url: response.url || null,
      timestamp: new Date().toISOString(),
      sessionId
    });
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      success: false,
      error: 'Đã xảy ra lỗi khi xử lý tin nhắn',
      details: error.message
    });
  }
});

// Get conversation history
app.get('/api/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const history = getConversationHistory(sessionId);
  
  res.json({
    success: true,
    sessionId,
    messages: history,
    count: history.length
  });
});

// Clear conversation history
app.delete('/api/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  conversations.delete(sessionId);
  
  res.json({
    success: true,
    message: 'Conversation history cleared',
    sessionId
  });
});

// Web search endpoint (riêng)
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ 
        error: 'Query is required',
        success: false 
      });
    }
    
    const result = await searchWeb(query);
    res.json(result);
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Code analysis endpoint
app.post('/api/analyze-code', (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ 
        error: 'Code is required',
        success: false 
      });
    }
    
    const analysis = analyzeCode(code);
    
    res.json({
      success: true,
      analysis,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Calculate endpoint
app.post('/api/calculate', (req, res) => {
  try {
    const { expression } = req.body;
    
    if (!expression) {
      return res.status(400).json({ 
        error: 'Expression is required',
        success: false 
      });
    }
    
    const result = calculate(expression);
    res.json(result);
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'AI Server is running',
    version: '2.0',
    features: [
      'chat',
      'web-search',
      'code-analysis',
      'calculator',
      'conversation-history'
    ],
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'AI Chat Server',
    version: '2.0',
    description: 'Intelligent AI server with web search, code analysis, and conversation',
    endpoints: {
      'POST /api/chat': 'Main chat endpoint',
      'GET /api/history/:sessionId': 'Get conversation history',
      'DELETE /api/history/:sessionId': 'Clear conversation history',
      'POST /api/search': 'Web search',
      'POST /api/analyze-code': 'Code analysis',
      'POST /api/calculate': 'Math calculator',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║     🤖 AI CHAT SERVER STARTED 🤖          ║
╚════════════════════════════════════════════╝

📡 Server: http://localhost:${PORT}
🌐 Environment: ${process.env.NODE_ENV || 'development'}
⚡ Features: Web Search, Code Analysis, Chat, Calculator

Ready to chat! 💬
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
