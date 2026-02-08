const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Conversation Context Storage
const conversations = new Map();

class AIAssistant {
  constructor() {
    this.conversationHistory = [];
    this.userProfile = {};
  }

  // Phân tích câu hỏi để quyết định có cần search web không
  needsWebSearch(message) {
    const lower = message.toLowerCase();
    
    // Indicators cần search
    const searchIndicators = [
      // Time-sensitive
      /hiện nay|hiện tại|bây giờ|hôm nay|năm nay|mới nhất|latest|current|now|today/i,
      // Questions about current state
      /ai là.*(?:hiện|đang|năm|2024|2025)/i,
      /giá|price|cost|bao nhiêu tiền/i,
      /thời tiết|weather|nhiệt độ/i,
      /tin tức|news|sự kiện/i,
      // Questions needing factual data
      /khi nào|when|ngày nào/i,
      /ở đâu|where|địa chỉ|location/i,
      /số lượng|how many|bao nhiêu người/i,
      /ai thắng|who won|kết quả|result|score/i,
    ];
    
    // Nếu match bất kỳ pattern nào → cần search
    if (searchIndicators.some(pattern => pattern.test(lower))) {
      return true;
    }
    
    // Check cho câu hỏi về người hoặc sự kiện cụ thể
    if (/(ai là|who is|what is|về) .{3,}/i.test(message)) {
      return true;
    }
    
    return false;
  }

  // Search web thông minh
  async searchWeb(query) {
    try {
      console.log(`🔍 Searching for: ${query}`);
      
      // Try DuckDuckGo Instant Answer
      const ddgResponse = await axios.get('https://api.duckduckgo.com/', {
        params: {
          q: query,
          format: 'json',
          no_html: 1,
          skip_disambig: 1
        },
        timeout: 5000
      });

      if (ddgResponse.data.Abstract) {
        return {
          success: true,
          text: ddgResponse.data.Abstract,
          source: ddgResponse.data.AbstractSource || 'Web',
          url: ddgResponse.data.AbstractURL
        };
      }

      if (ddgResponse.data.RelatedTopics && ddgResponse.data.RelatedTopics.length > 0) {
        const topics = ddgResponse.data.RelatedTopics
          .filter(t => t.Text)
          .slice(0, 3)
          .map(t => t.Text)
          .join('\n\n');
        
        if (topics) {
          return {
            success: true,
            text: topics,
            source: 'Web Search',
            url: ddgResponse.data.RelatedTopics[0].FirstURL
          };
        }
      }

      // Fallback: Try Wikipedia API
      const wikiResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
        params: {
          action: 'query',
          format: 'json',
          prop: 'extracts',
          exintro: true,
          explaintext: true,
          titles: query,
          origin: '*'
        },
        timeout: 5000
      });

      const pages = wikiResponse.data.query?.pages;
      if (pages) {
        const page = Object.values(pages)[0];
        if (page.extract) {
          return {
            success: true,
            text: page.extract,
            source: 'Wikipedia',
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`
          };
        }
      }

      return { success: false };
    } catch (error) {
      console.error('Search error:', error.message);
      return { success: false };
    }
  }

  // Generate response dựa trên context và knowledge
  async generateResponse(message) {
    // Lưu message vào history
    this.conversationHistory.push({ role: 'user', content: message });

    // Kiểm tra xem có cần search không
    const needsSearch = this.needsWebSearch(message);
    let searchResult = null;

    if (needsSearch) {
      searchResult = await this.searchWeb(message);
    }

    // Tạo response
    let response = '';
    let source = 'ai';

    if (searchResult && searchResult.success) {
      // Có kết quả search → dùng để trả lời
      response = this.formulateAnswerFromSearch(message, searchResult.text);
      source = searchResult.source;
    } else {
      // Không có search hoặc search thất bại → dùng knowledge base
      response = this.generateKnowledgeBasedResponse(message);
    }

    // Lưu response vào history
    this.conversationHistory.push({ role: 'assistant', content: response });

    // Giữ history trong giới hạn
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }

    return {
      response,
      source,
      url: searchResult?.url
    };
  }

  // Tạo câu trả lời tự nhiên từ search results
  formulateAnswerFromSearch(question, searchText) {
    // Lấy phần đầu của search text (không quá dài)
    let answer = searchText.substring(0, 800);
    
    // Cắt ở câu cuối hoàn chỉnh
    const lastPeriod = answer.lastIndexOf('.');
    if (lastPeriod > 200) {
      answer = answer.substring(0, lastPeriod + 1);
    }

    // Thêm intro tự nhiên
    const intros = [
      'Dựa trên thông tin tôi tìm được: ',
      'Theo những gì tôi tìm thấy: ',
      'Đây là thông tin tôi tìm được: ',
      'Để trả lời câu hỏi của bạn: ',
    ];
    
    const intro = intros[Math.floor(Math.random() * intros.length)];
    return intro + answer;
  }

  // Generate response từ knowledge base (không search)
  generateKnowledgeBasedResponse(message) {
    const lower = message.toLowerCase();

    // Programming & Tech
    if (this.isAbout(lower, ['javascript', 'js', 'node', 'react', 'web dev'])) {
      return this.getTechResponse(lower);
    }

    if (this.isAbout(lower, ['python', 'django', 'flask', 'pandas'])) {
      return 'Python là ngôn ngữ lập trình đa năng, dễ học và rất mạnh mẽ. Nó được sử dụng rộng rãi trong data science, machine learning, web development, automation và nhiều lĩnh vực khác. Python có cú pháp rõ ràng, thư viện phong phú và cộng đồng lớn. Bạn muốn tìm hiểu khía cạnh nào của Python?';
    }

    if (this.isAbout(lower, ['ai', 'trí tuệ nhân tạo', 'machine learning', 'deep learning'])) {
      return 'AI (Artificial Intelligence) là khả năng của máy móc để thực hiện các nhiệm vụ đòi hỏi trí thông minh như con người: học tập, suy luận, nhận diện mẫu, xử lý ngôn ngữ tự nhiên. Machine Learning là một nhánh của AI, cho phép máy tính học từ dữ liệu mà không cần lập trình chi tiết. Deep Learning sử dụng neural networks nhiều lớp để giải quyết các vấn đề phức tạp như nhận diện hình ảnh, xử lý giọng nói, và tạo nội dung. Bạn muốn đi sâu vào chủ đề nào?';
    }

    // Code help
    if (this.isAbout(lower, ['bug', 'lỗi', 'error', 'debug', 'fix'])) {
      return 'Tôi có thể giúp bạn debug! Hãy paste đoạn code bị lỗi vào, kèm theo thông báo lỗi (nếu có). Tôi sẽ phân tích và đề xuất cách fix. Một số tips debug: (1) Đọc kỹ error message, (2) Dùng console.log để track giá trị biến, (3) Kiểm tra syntax như dấu ngoặc, dấu chấm phẩy, (4) Google error message để tìm giải pháp.';
    }

    // General questions
    if (this.isQuestion(lower)) {
      return this.getGeneralAnswer(lower);
    }

    // Greetings
    if (this.isAbout(lower, ['xin chào', 'chào', 'hello', 'hi', 'hey'])) {
      const greetings = [
        'Xin chào! Tôi là AI Assistant, sẵn sàng giúp bạn với bất kỳ câu hỏi nào. Bạn muốn biết về điều gì?',
        'Chào bạn! Rất vui được nói chuyện. Hãy hỏi tôi bất cứ điều gì - từ kiến thức chung đến lập trình!',
        'Hey! Tôi có thể giúp gì cho bạn hôm nay?'
      ];
      return greetings[Math.floor(Math.random() * greetings.length)];
    }

    // Thanks
    if (this.isAbout(lower, ['cảm ơn', 'cám ơn', 'thank', 'thanks'])) {
      return 'Rất vui được giúp đỡ! Nếu có câu hỏi gì khác, cứ hỏi tôi nhé! 😊';
    }

    // Fallback - encourage more specific question
    return this.getThoughtfulResponse(message);
  }

  // Tech response generator
  getTechResponse(query) {
    if (query.includes('react')) {
      return 'React là thư viện JavaScript phổ biến nhất để xây dựng user interfaces. Ưu điểm: component-based architecture (tái sử dụng code dễ), virtual DOM (performance cao), ecosystem phong phú, và cộng đồng lớn. React dùng JSX để viết UI, hooks để quản lý state, và có thể kết hợp với Redux/Context API cho state management phức tạp. Bạn đang học React hay cần giúp về vấn đề cụ thể nào?';
    }
    
    if (query.includes('node')) {
      return 'Node.js cho phép chạy JavaScript ở server-side, sử dụng V8 engine của Chrome. Ưu điểm: non-blocking I/O (xử lý nhiều requests đồng thời), NPM ecosystem khổng lồ, cùng ngôn ngữ frontend-backend, và performance tốt cho I/O operations. Node.js phù hợp với real-time apps, APIs, microservices. Bạn cần giúp build ứng dụng gì với Node.js?';
    }
    
    return 'JavaScript là ngôn ngữ lập trình linh hoạt nhất cho web development. Nó chạy trên mọi browser (client-side) và cả server với Node.js. JS có syntax dễ học, event-driven, async programming với Promises/async-await, và ecosystem cực lớn. Modern JS (ES6+) có arrow functions, destructuring, modules, classes... Bạn muốn học JS ở mảng nào: frontend, backend, hay fullstack?';
  }

  // General answer cho câu hỏi chung
  getGeneralAnswer(query) {
    if (query.includes('làm sao') || query.includes('how to') || query.includes('cách')) {
      return 'Đó là câu hỏi hay! Để tôi giúp bạn tốt hơn, bạn có thể cụ thể hơn được không? Ví dụ: bạn muốn làm điều gì, với công nghệ gì, hoặc đang gặp vấn đề gì?';
    }

    if (query.includes('tại sao') || query.includes('why')) {
      return 'Câu hỏi thú vị! Để giải thích rõ hơn, bạn có thể cho tôi biết thêm context không? Bạn đang thắc mắc về khía cạnh kỹ thuật, lý do thiết kế, hay ứng dụng thực tế?';
    }

    if (query.includes('là gì') || query.includes('what is')) {
      return 'Tôi có thể giải thích! Nhưng để câu trả lời hữu ích nhất, bạn có thể cho tôi biết thêm: bạn muốn hiểu về khía cạnh nào (technical, practical, historical)?';
    }

    return this.getThoughtfulResponse(query);
  }

  // Thoughtful response khi không chắc
  getThoughtfulResponse(query) {
    const responses = [
      'Đó là câu hỏi thú vị! Tôi nghĩ bạn đang hỏi về một chủ đề khá rộng. Bạn có thể cụ thể hơn hoặc cho tôi thêm context được không? Điều này giúp tôi trả lời chính xác hơn.',
      
      'Hmm, tôi muốn đảm bảo trả lời đúng những gì bạn cần. Bạn có thể diễn đạt lại câu hỏi hoặc cho tôi biết thêm chi tiết không? Ví dụ như bạn đang làm việc với công nghệ gì, hoặc muốn giải quyết vấn đề gì?',
      
      'Câu hỏi hay đấy! Để tôi trả lời tốt nhất, bạn có thể cho biết:\n• Bạn đang làm gì/học gì?\n• Mục tiêu của bạn là gì?\n• Có vấn đề cụ thể nào bạn đang gặp phải không?',
      
      'Tôi hiểu bạn đang tìm kiếm thông tin. Để giúp bạn tốt hơn, hãy thử:\n• Hỏi cụ thể hơn về một khía cạnh\n• Đưa ra ví dụ hoặc context\n• Cho tôi biết level kiến thức của bạn (beginner/intermediate/advanced)',
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }

  // Helper functions
  isAbout(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
  }

  isQuestion(text) {
    const questionWords = ['sao', 'gì', 'ai', 'đâu', 'nào', 'thế nào', 'how', 'what', 'why', 'when', 'where', 'who'];
    return questionWords.some(word => text.includes(word)) || text.includes('?');
  }

  // Get conversation context
  getContext() {
    return this.conversationHistory.slice(-6); // Last 6 messages
  }
}

// Session management
function getAssistant(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, new AIAssistant());
  }
  return conversations.get(sessionId);
}

// API Endpoints

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    const assistant = getAssistant(sessionId);
    const result = await assistant.generateResponse(message.trim());

    res.json({
      success: true,
      response: result.response,
      source: result.source,
      url: result.url,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      success: false,
      error: 'Có lỗi xảy ra khi xử lý tin nhắn',
      details: error.message
    });
  }
});

// Get conversation history
app.get('/api/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const assistant = getAssistant(sessionId);
  
  res.json({
    success: true,
    history: assistant.conversationHistory,
    count: assistant.conversationHistory.length
  });
});

// Clear conversation
app.delete('/api/history/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  conversations.delete(sessionId);
  
  res.json({
    success: true,
    message: 'Conversation cleared'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI Server is running',
    version: '3.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Intelligent AI Chat Server',
    version: '3.0',
    description: 'Smart AI with web search and natural conversation',
    features: [
      'Natural language understanding',
      'Automatic web search',
      'Context-aware responses',
      'Conversation memory',
      'Tech knowledge base'
    ],
    endpoints: {
      'POST /api/chat': 'Chat with AI',
      'GET /api/history/:sessionId': 'Get conversation history',
      'DELETE /api/history/:sessionId': 'Clear conversation',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🧠 INTELLIGENT AI SERVER v3.0 🧠        ║
╚════════════════════════════════════════════╝

🚀 Server: http://localhost:${PORT}
🌐 Environment: ${process.env.NODE_ENV || 'development'}

Features:
  ✅ Smart conversation AI
  ✅ Automatic web search
  ✅ Context awareness
  ✅ Natural language processing
  ✅ Tech knowledge base

Ready to chat! 💬
  `);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

module.exports = app;
