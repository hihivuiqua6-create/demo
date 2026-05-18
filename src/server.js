const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

// ============================================================
// HARD-CODED CONFIG (không cần env Render)
// ============================================================
const crypto = require("crypto");
const CONFIG = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(48).toString("hex"),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123456",
  API_KEY: process.env.API_KEY || process.env.ADMIN_PASSWORD || "admin123456",
  DB_PATH: path.join(__dirname, "../database/bots.db"),
  BASE_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:3000`,
};

// Mặc định welcome message (giống mẫu) — hỗ trợ biến: {name} {first_name} {username} {full_name}
const DEFAULT_WELCOME = `🌟 <b>HỆ THỐNG DỊCH VỤ TỰ ĐỘNG</b>
━━━━━━━━━━━━━━━━━━━━━━━

👋 Chào 🌸 <b>{name}</b>, hệ thống đã được đồng bộ.

🚀 Vui lòng nhấn nút bên dưới hoặc thanh Menu để mở App.`;
const DEFAULT_BUTTON = "🛒 Mở Shop (Mini App)";

// Escape HTML để tránh injection khi chèn tên user vào parse_mode=HTML
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderWelcome(tpl, user) {
  const first = escapeHtml(user.first_name || "");
  const last = escapeHtml(user.last_name || "");
  const uname = escapeHtml(user.username || "");
  const full = [first, last].filter(Boolean).join(" ") || uname || "bạn";
  const display = first || uname || full || "bạn";
  return String(tpl || DEFAULT_WELCOME)
    .replaceAll("{name}", display)
    .replaceAll("{first_name}", first || display)
    .replaceAll("{last_name}", last)
    .replaceAll("{username}", uname || display)
    .replaceAll("{full_name}", full);
}

// ============================================================
// DATABASE SETUP
// ============================================================
if (!fs.existsSync(path.dirname(CONFIG.DB_PATH))) {
  fs.mkdirSync(path.dirname(CONFIG.DB_PATH), { recursive: true });
}

const db = new Database(CONFIG.DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    bot_username TEXT,
    web_url TEXT NOT NULL,
    welcome_message TEXT,
    button_text TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_token TEXT NOT NULL,
    telegram_user_id TEXT,
    telegram_username TEXT,
    event_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tg_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_token TEXT NOT NULL,
    telegram_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_token, telegram_id)
  );
`);

// ============================================================
// BOT MANAGER (chạy nhiều bot trong 1 process)
// ============================================================
const activeBots = new Map(); // token → TelegramBot instance

function startBot(botConfig) {
  const { token, web_url, welcome_message, button_text } = botConfig;

  if (activeBots.has(token)) {
    console.log(`Bot ${token.slice(0, 10)}... đang chạy rồi`);
    return { success: true, already_running: true };
  }

  try {
    const bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const user = msg.from;

      // Lưu user vào DB
      try {
        db.prepare(`
          INSERT INTO tg_users (bot_token, telegram_id, username, first_name, last_name)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(bot_token, telegram_id) DO UPDATE SET
            last_seen = CURRENT_TIMESTAMP,
            username = excluded.username,
            first_name = excluded.first_name
        `).run(token, String(user.id), user.username || "", user.first_name || "", user.last_name || "");

        // Analytics
        db.prepare(`INSERT INTO analytics (bot_token, telegram_user_id, telegram_username, event_type) VALUES (?, ?, ?, ?)`)
          .run(token, String(user.id), user.username || "", "start");
      } catch (e) { /* ignore */ }

      // Cập nhật last_active
      db.prepare("UPDATE bots SET last_active = CURRENT_TIMESTAMP WHERE token = ?").run(token);

      // Gửi tin nhắn chào mừng + nút mở Mini App (render tên user động)
      const rendered = renderWelcome(welcome_message || DEFAULT_WELCOME, user);
      await bot.sendMessage(chatId, rendered, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: button_text || DEFAULT_BUTTON, web_app: { url: web_url } }
          ]]
        }
      });
    });

    // Xử lý khi user mở Mini App
    bot.on("web_app_data", async (msg) => {
      const chatId = msg.chat.id;
      const data = msg.web_app_data?.data;
      try {
        db.prepare(`INSERT INTO analytics (bot_token, telegram_user_id, event_type) VALUES (?, ?, ?)`)
          .run(token, String(msg.from.id), "webapp_opened");
        await bot.sendMessage(chatId, "✅ Đã nhận dữ liệu từ Mini App!");
      } catch (e) { /* ignore */ }
    });

    bot.on("polling_error", (err) => {
      console.error(`Bot ${token.slice(0, 10)} polling error:`, err.message);
      if (err.message.includes("401") || err.message.includes("404")) {
        stopBot(token);
        db.prepare("UPDATE bots SET is_active = 0 WHERE token = ?").run(token);
      }
    });

    activeBots.set(token, bot);
    console.log(`✅ Bot ${token.slice(0, 10)}... đã khởi động`);
    return { success: true };

  } catch (err) {
    console.error(`❌ Lỗi khởi động bot:`, err.message);
    return { success: false, error: err.message };
  }
}

function stopBot(token) {
  const bot = activeBots.get(token);
  if (bot) {
    try { bot.stopPolling(); } catch (e) { }
    activeBots.delete(token);
    console.log(`🛑 Bot ${token.slice(0, 10)}... đã dừng`);
  }
}

// Khởi động tất cả bot active trong DB khi server start
function loadAllBots() {
  const bots = db.prepare("SELECT * FROM bots WHERE is_active = 1").all();
  console.log(`📦 Đang tải ${bots.length} bot từ database...`);
  bots.forEach(b => startBot(b));
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use("/api/", limiter);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: "Quá nhiều lần thử. Thử lại sau 15 phút." } });

// So sánh chuỗi chống timing attack
function safeEqual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ============================================================
// MIDDLEWARE: Xác thực JWT Admin
// ============================================================
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Chưa đăng nhập" });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), CONFIG.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token không hợp lệ" });
  }
}

// ============================================================
// API: ADMIN LOGIN
// ============================================================
app.post("/api/admin/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Thiếu thông tin đăng nhập" });
  }
  if (safeEqual(username, CONFIG.ADMIN_USERNAME) && safeEqual(password, CONFIG.ADMIN_PASSWORD)) {
    const token = jwt.sign({ username, role: "admin" }, CONFIG.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ success: true, token, message: "Đăng nhập thành công" });
  }
  return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
});

// ============================================================
// API: TẠO / THÊM BOT (CHÍNH - để gắn vào web riêng của bạn)
// POST /api/create-bot
// Body: { token: "...", web_url: "https://...", welcome_message: "...", button_text: "..." }
// Trả về: { success, bot_username, message }
// ============================================================
app.post("/api/create-bot", async (req, res) => {
  const { token, web_url, welcome_message, button_text, api_key } = req.body;

  // Kiểm tra api_key (để bảo vệ endpoint khi gắn vào web riêng)
  // api_key giống admin password hoặc bạn có thể đổi riêng
  if (!safeEqual(api_key, CONFIG.API_KEY)) {
    return res.status(401).json({ error: "api_key không hợp lệ" });
  }

  if (!token || !web_url) {
    return res.status(400).json({ error: "Cần có token và web_url" });
  }

  // Validate URL
  try { new URL(web_url); } catch {
    return res.status(400).json({ error: "web_url không hợp lệ" });
  }

  // Kiểm tra token Telegram có hợp lệ không
  let botInfo;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ error: "Token bot Telegram không hợp lệ" });
    botInfo = data.result;
  } catch {
    return res.status(400).json({ error: "Không thể kết nối Telegram API" });
  }

  // Lưu vào DB (upsert)
  try {
    db.prepare(`
      INSERT INTO bots (token, bot_username, web_url, welcome_message, button_text, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(token) DO UPDATE SET
        web_url = excluded.web_url,
        welcome_message = excluded.welcome_message,
        button_text = excluded.button_text,
        bot_username = excluded.bot_username,
        is_active = 1
    `).run(
      token,
      botInfo.username,
      web_url,
      welcome_message || "Chào mừng bạn! 👋 Nhấn nút bên dưới để mở ứng dụng.",
      button_text || "🚀 Mở Mini App"
    );
  } catch (e) {
    return res.status(500).json({ error: "Lỗi lưu database: " + e.message });
  }

  // Khởi động bot
  const startResult = startBot({
    token,
    web_url,
    welcome_message: welcome_message || "Chào mừng bạn! 👋 Nhấn nút bên dưới để mở ứng dụng.",
    button_text: button_text || "🚀 Mở Mini App",
  });

  return res.json({
    success: true,
    bot_username: botInfo.username,
    bot_name: botInfo.first_name,
    message: `Bot @${botInfo.username} đã được kích hoạt thành công!`,
    already_running: startResult.already_running || false,
  });
});

// ============================================================
// API: LẤY DANH SÁCH BOT (Admin)
// ============================================================
app.get("/api/admin/bots", authMiddleware, (req, res) => {
  const bots = db.prepare("SELECT id, bot_username, web_url, welcome_message, button_text, is_active, created_at, last_active FROM bots ORDER BY created_at DESC").all();
  const result = bots.map(b => ({
    ...b,
    is_running: activeBots.has(
      db.prepare("SELECT token FROM bots WHERE id = ?").get(b.id)?.token
    ),
  }));
  res.json({ success: true, bots: result, total: result.length });
});

// ============================================================
// API: XÓA BOT (Admin)
// ============================================================
app.delete("/api/admin/bots/:id", authMiddleware, (req, res) => {
  const bot = db.prepare("SELECT * FROM bots WHERE id = ?").get(req.params.id);
  if (!bot) return res.status(404).json({ error: "Không tìm thấy bot" });
  stopBot(bot.token);
  db.prepare("DELETE FROM bots WHERE id = ?").run(req.params.id);
  res.json({ success: true, message: "Đã xóa bot" });
});

// ============================================================
// API: BẬT/TẮT BOT (Admin)
// ============================================================
app.post("/api/admin/bots/:id/toggle", authMiddleware, (req, res) => {
  const bot = db.prepare("SELECT * FROM bots WHERE id = ?").get(req.params.id);
  if (!bot) return res.status(404).json({ error: "Không tìm thấy bot" });

  if (bot.is_active) {
    stopBot(bot.token);
    db.prepare("UPDATE bots SET is_active = 0 WHERE id = ?").run(req.params.id);
    return res.json({ success: true, message: "Đã tắt bot", is_active: false });
  } else {
    db.prepare("UPDATE bots SET is_active = 1 WHERE id = ?").run(req.params.id);
    startBot(bot);
    return res.json({ success: true, message: "Đã bật bot", is_active: true });
  }
});

// ============================================================
// API: ANALYTICS (Admin)
// ============================================================
app.get("/api/admin/analytics", authMiddleware, (req, res) => {
  const totalBots = db.prepare("SELECT COUNT(*) as c FROM bots WHERE is_active = 1").get().c;
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM tg_users").get().c;
  const totalStarts = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type = 'start'").get().c;
  const todayStarts = db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event_type = 'start' AND date(created_at) = date('now')").get().c;
  const recentActivity = db.prepare("SELECT a.*, b.bot_username FROM analytics a LEFT JOIN bots b ON a.bot_token = b.token ORDER BY a.created_at DESC LIMIT 20").all();

  res.json({
    success: true,
    stats: { totalBots, totalUsers, totalStarts, todayStarts, activeBots: activeBots.size },
    recentActivity,
  });
});

// ============================================================
// API: DANH SÁCH USERS TELEGRAM (Admin)
// ============================================================
app.get("/api/admin/users", authMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT u.*, b.bot_username 
    FROM tg_users u LEFT JOIN bots b ON u.bot_token = b.token 
    ORDER BY u.last_seen DESC LIMIT 100
  `).all();
  res.json({ success: true, users, total: users.length });
});

// ============================================================
// API: CẬP NHẬT THÔNG TIN BOT (Admin + Web riêng)
// ============================================================
app.put("/api/update-bot", async (req, res) => {
  const { token, web_url, welcome_message, button_text, api_key } = req.body;

  if (!safeEqual(api_key, CONFIG.API_KEY)) {
    return res.status(401).json({ error: "api_key không hợp lệ" });
  }

  const bot = db.prepare("SELECT * FROM bots WHERE token = ?").get(token);
  if (!bot) return res.status(404).json({ error: "Bot chưa được đăng ký" });

  db.prepare(`UPDATE bots SET web_url = COALESCE(?, web_url), welcome_message = COALESCE(?, welcome_message), button_text = COALESCE(?, button_text) WHERE token = ?`)
    .run(web_url || null, welcome_message || null, button_text || null, token);

  // Restart bot với config mới
  stopBot(token);
  const updatedBot = db.prepare("SELECT * FROM bots WHERE token = ?").get(token);
  startBot(updatedBot);

  res.json({ success: true, message: "Đã cập nhật và khởi động lại bot" });
});

// ============================================================
// API: XÓA BOT (Web riêng)
// ============================================================
app.delete("/api/delete-bot", (req, res) => {
  const { token, api_key } = req.body;
  if (!safeEqual(api_key, CONFIG.API_KEY)) return res.status(401).json({ error: "api_key không hợp lệ" });
  const bot = db.prepare("SELECT * FROM bots WHERE token = ?").get(token);
  if (!bot) return res.status(404).json({ error: "Không tìm thấy bot" });
  stopBot(token);
  db.prepare("DELETE FROM bots WHERE token = ?").run(token);
  res.json({ success: true, message: "Đã xóa bot" });
});

// ============================================================
// API: TRẠNG THÁI BOT (Web riêng kiểm tra)
// ============================================================
app.get("/api/bot-status", (req, res) => {
  const { token, api_key } = req.query;
  if (!safeEqual(api_key, CONFIG.API_KEY)) return res.status(401).json({ error: "api_key không hợp lệ" });
  const bot = db.prepare("SELECT id, bot_username, web_url, is_active, created_at, last_active FROM bots WHERE token = ?").get(token);
  if (!bot) return res.status(404).json({ error: "Bot chưa được đăng ký" });
  res.json({ success: true, bot: { ...bot, is_running: activeBots.has(token) } });
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    activeBots: activeBots.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// SERVE ADMIN DASHBOARD (trang quản trị built-in)
// ============================================================
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

// ============================================================
// START SERVER
// ============================================================
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 TGBot Platform đang chạy tại port ${CONFIG.PORT}`);
  console.log(`📊 Admin Dashboard: http://localhost:${CONFIG.PORT}/admin`);
  console.log(`🔑 Admin: ${CONFIG.ADMIN_USERNAME} / ${CONFIG.ADMIN_PASSWORD}`);
  console.log(`🔌 API Key cho web riêng: ${CONFIG.API_KEY}\n`);
  if (!process.env.JWT_SECRET) console.log("⚠️  Đang dùng JWT_SECRET ngẫu nhiên — set env JWT_SECRET để session ổn định khi restart.");
  if (!process.env.ADMIN_PASSWORD) console.log("⚠️  Đang dùng mật khẩu mặc định — hãy set env ADMIN_PASSWORD trên production.\n");
  loadAllBots();
});

module.exports = app;
