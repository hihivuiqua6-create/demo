// src/routes/api.js
// ====================================================
// PUBLIC API - Web bên ngoài gọi vào để quản lý bot
// Xác thực bằng: Header X-Api-Key: <key>
// ====================================================
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { botQueries, userQueries, analyticsQueries, webhookQueries } = require('../models/database');
const { requireApiKey } = require('../middleware/auth');
const botManager = require('../services/botManager');

// ─────────────────────────────────────────
// POST /api/create-bot
// Tạo bot mới từ token + web_url
// Body: { token, web_url, welcome_message?, button_text? }
// ─────────────────────────────────────────
router.post('/create-bot', requireApiKey, async (req, res) => {
  const { token, web_url, welcome_message, button_text } = req.body;

  if (!token || !web_url) {
    return res.status(400).json({
      success: false,
      error: 'Thiếu tham số bắt buộc',
      required: { token: 'Bot token từ @BotFather', web_url: 'URL web Mini App cần hiển thị' }
    });
  }

  // Validate URL
  try { new URL(web_url); } catch {
    return res.status(400).json({ success: false, error: 'web_url không hợp lệ' });
  }

  // Kiểm tra token đã tồn tại chưa
  const existing = botQueries.findByToken.get(token);
  if (existing) {
    return res.status(409).json({
      success: false,
      error: 'Token này đã được đăng ký',
      bot_id: existing.id
    });
  }

  // Validate token với Telegram
  const validation = await botManager.validateToken(token);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      error: 'Token bot không hợp lệ hoặc đã bị thu hồi',
      detail: validation.error
    });
  }

  const botInfo = validation.info;
  const botId = uuidv4();

  // Lưu vào DB
  botQueries.create.run({
    id: botId,
    token,
    bot_username: botInfo.username,
    bot_name: botInfo.first_name,
    web_url,
    welcome_message: welcome_message || `Xin chào! Tôi là ${botInfo.first_name}.\nNhấn nút bên dưới để mở ứng dụng 👇`,
    button_text: button_text || '🚀 Mở Mini App',
    owner_api_key: req.apiKeyRecord?.key_value || 'master',
  });

  // Khởi động bot
  const botRecord = botQueries.findById.get(botId);
  await botManager.startBot(botRecord);

  res.status(201).json({
    success: true,
    message: 'Bot đã được tạo và khởi động thành công',
    bot: {
      id: botId,
      bot_username: botInfo.username,
      bot_name: botInfo.first_name,
      web_url,
      telegram_link: `https://t.me/${botInfo.username}`,
      status: 'active',
      created_at: new Date().toISOString()
    }
  });
});

// ─────────────────────────────────────────
// GET /api/bots
// Lấy danh sách bot của API key này
// ─────────────────────────────────────────
router.get('/bots', requireApiKey, (req, res) => {
  const bots = botQueries.findAll.all().map(bot => ({
    id: bot.id,
    bot_username: bot.bot_username,
    bot_name: bot.bot_name,
    web_url: bot.web_url,
    status: bot.status,
    is_running: botManager.isRunning(bot.id),
    telegram_link: bot.bot_username ? `https://t.me/${bot.bot_username}` : null,
    created_at: bot.created_at,
  }));

  res.json({ success: true, count: bots.length, bots });
});

// ─────────────────────────────────────────
// GET /api/bot/:id
// Lấy chi tiết 1 bot
// ─────────────────────────────────────────
router.get('/bot/:id', requireApiKey, (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  const userCount = userQueries.countByBot.get(bot.id);
  res.json({
    success: true,
    bot: {
      ...bot,
      token: undefined, // Ẩn token
      is_running: botManager.isRunning(bot.id),
      user_count: userCount.count,
      telegram_link: bot.bot_username ? `https://t.me/${bot.bot_username}` : null,
    }
  });
});

// ─────────────────────────────────────────
// PUT /api/bot/:id
// Cập nhật bot (web_url, welcome_message, button_text)
// ─────────────────────────────────────────
router.put('/bot/:id', requireApiKey, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  const { web_url, welcome_message, button_text, status } = req.body;

  if (web_url) {
    try { new URL(web_url); } catch {
      return res.status(400).json({ success: false, error: 'web_url không hợp lệ' });
    }
  }

  botQueries.update.run({
    id: bot.id,
    web_url: web_url || bot.web_url,
    welcome_message: welcome_message || bot.welcome_message,
    button_text: button_text || bot.button_text,
    bot_username: bot.bot_username,
    bot_name: bot.bot_name,
    status: status || bot.status,
  });

  // Restart bot nếu thay đổi status
  if (status === 'inactive') {
    await botManager.stopBot(bot.id);
  } else if (status === 'active' && !botManager.isRunning(bot.id)) {
    const fresh = botQueries.findById.get(bot.id);
    await botManager.startBot(fresh);
  }

  res.json({ success: true, message: 'Đã cập nhật bot', bot_id: bot.id });
});

// ─────────────────────────────────────────
// DELETE /api/bot/:id
// Xóa bot
// ─────────────────────────────────────────
router.delete('/bot/:id', requireApiKey, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  await botManager.stopBot(bot.id);
  botQueries.delete.run(bot.id);

  res.json({ success: true, message: 'Bot đã bị xóa' });
});

// ─────────────────────────────────────────
// GET /api/bot/:id/analytics
// Thống kê bot
// ─────────────────────────────────────────
router.get('/bot/:id/analytics', requireApiKey, (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  const analytics = analyticsQueries.getByBot.all(bot.id);
  const userCount = userQueries.countByBot.get(bot.id);
  const recentUsers = userQueries.findByBot.all(bot.id).slice(0, 20);

  res.json({
    success: true,
    bot_id: bot.id,
    stats: {
      total_users: userCount.count,
      events: analytics,
      recent_users: recentUsers.map(u => ({
        telegram_id: u.telegram_user_id,
        username: u.username,
        first_name: u.first_name,
        message_count: u.message_count,
        last_seen: u.last_seen,
      }))
    }
  });
});

// ─────────────────────────────────────────
// POST /api/bot/:id/broadcast
// Gửi tin nhắn đến tất cả user của bot
// ─────────────────────────────────────────
router.post('/bot/:id/broadcast', requireApiKey, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Thiếu message' });

  const result = await botManager.broadcastToBot(bot.id, message);
  res.json({ success: true, result });
});

// ─────────────────────────────────────────
// POST /api/bot/:id/webhook
// Thêm webhook cho bot
// ─────────────────────────────────────────
router.post('/bot/:id/webhook', requireApiKey, (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  const { url, events = 'all', secret } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'Thiếu url' });

  webhookQueries.create.run({ bot_id: bot.id, url, events, secret: secret || null });
  res.json({ success: true, message: 'Webhook đã được thêm' });
});

// ─────────────────────────────────────────
// POST /api/bot/:id/restart
// Restart bot
// ─────────────────────────────────────────
router.post('/bot/:id/restart', requireApiKey, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot không tồn tại' });

  await botManager.stopBot(bot.id);
  await new Promise(r => setTimeout(r, 1000));
  await botManager.startBot(bot);

  res.json({ success: true, message: 'Bot đã được restart' });
});

module.exports = router;
