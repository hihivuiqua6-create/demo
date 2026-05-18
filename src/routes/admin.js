// src/routes/admin.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const {
  adminQueries, botQueries, userQueries,
  analyticsQueries, apiKeyQueries, webhookQueries
} = require('../models/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const botManager = require('../services/botManager');

// ─── Login ───────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Nhập username và password' });
  }

  const admin = adminQueries.findByUsername.get(username);
  if (!admin) {
    return res.status(401).json({ success: false, error: 'Sai thông tin đăng nhập' });
  }

  const valid = await bcrypt.compare(password, admin.password);
  if (!valid) {
    return res.status(401).json({ success: false, error: 'Sai thông tin đăng nhập' });
  }

  const token = generateToken({ id: admin.id, username: admin.username });
  res.json({ success: true, token, username: admin.username });
});

// ─── Dashboard Stats ─────────────────────
router.get('/stats', requireAuth, (req, res) => {
  const totalBots = botQueries.count.get().count;
  const activeBots = botQueries.countActive.get().count;
  const totalUsers = userQueries.totalUsers.get().count;
  const totalEvents = analyticsQueries.totalEvents.get().count;
  const runningBots = botManager.getRunningCount();

  res.json({
    success: true,
    stats: { totalBots, activeBots, totalUsers, totalEvents, runningBots }
  });
});

// ─── List All Bots ───────────────────────
router.get('/bots', requireAuth, (req, res) => {
  const bots = botQueries.findAll.all().map(bot => ({
    ...bot,
    token: bot.token.slice(0, 10) + '...' + bot.token.slice(-5),
    is_running: botManager.isRunning(bot.id),
    user_count: userQueries.countByBot.get(bot.id)?.count || 0,
  }));
  res.json({ success: true, bots });
});

// ─── Bot Detail ──────────────────────────
router.get('/bots/:id', requireAuth, (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Not found' });

  const users = userQueries.findByBot.all(bot.id);
  const analytics = analyticsQueries.getByBot.all(bot.id);
  const recent = analyticsQueries.getRecentByBot.all(bot.id);

  res.json({
    success: true,
    bot: {
      ...bot,
      is_running: botManager.isRunning(bot.id),
    },
    users,
    analytics,
    recent_events: recent,
  });
});

// ─── Create Bot (Admin) ──────────────────
router.post('/bots', requireAuth, async (req, res) => {
  const { token, web_url, welcome_message, button_text } = req.body;
  if (!token || !web_url) {
    return res.status(400).json({ success: false, error: 'Cần token và web_url' });
  }

  const existing = botQueries.findByToken.get(token);
  if (existing) return res.status(409).json({ success: false, error: 'Token đã tồn tại', bot_id: existing.id });

  const validation = await botManager.validateToken(token);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: 'Token không hợp lệ: ' + validation.error });
  }

  const botInfo = validation.info;
  const botId = uuidv4();

  botQueries.create.run({
    id: botId,
    token,
    bot_username: botInfo.username,
    bot_name: botInfo.first_name,
    web_url,
    welcome_message: welcome_message || `Xin chào! Tôi là ${botInfo.first_name}.\nNhấn nút bên dưới 👇`,
    button_text: button_text || '🚀 Mở Mini App',
    owner_api_key: 'admin',
  });

  const botRecord = botQueries.findById.get(botId);
  await botManager.startBot(botRecord);

  res.status(201).json({
    success: true,
    bot: { id: botId, bot_username: botInfo.username, bot_name: botInfo.first_name, web_url }
  });
});

// ─── Update Bot ───────────────────────────
router.put('/bots/:id', requireAuth, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Not found' });

  const { web_url, welcome_message, button_text, status } = req.body;

  botQueries.update.run({
    id: bot.id,
    web_url: web_url || bot.web_url,
    welcome_message: welcome_message || bot.welcome_message,
    button_text: button_text || bot.button_text,
    bot_username: bot.bot_username,
    bot_name: bot.bot_name,
    status: status || bot.status,
  });

  if (status === 'inactive') await botManager.stopBot(bot.id);
  if (status === 'active' && !botManager.isRunning(bot.id)) {
    await botManager.startBot(botQueries.findById.get(bot.id));
  }

  res.json({ success: true, message: 'Updated' });
});

// ─── Delete Bot ───────────────────────────
router.delete('/bots/:id', requireAuth, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Not found' });

  await botManager.stopBot(bot.id);
  botQueries.delete.run(bot.id);
  res.json({ success: true });
});

// ─── Restart Bot ──────────────────────────
router.post('/bots/:id/restart', requireAuth, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Not found' });

  await botManager.stopBot(bot.id);
  await new Promise(r => setTimeout(r, 1000));
  await botManager.startBot(bot);
  res.json({ success: true, message: 'Restarted' });
});

// ─── Broadcast ────────────────────────────
router.post('/bots/:id/broadcast', requireAuth, async (req, res) => {
  const bot = botQueries.findById.get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Not found' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Cần message' });

  const result = await botManager.broadcastToBot(bot.id, message);
  res.json({ success: true, result });
});

// ─── API Keys Management ─────────────────
router.get('/api-keys', requireAuth, (req, res) => {
  const keys = apiKeyQueries.findAll.all();
  res.json({ success: true, keys });
});

router.post('/api-keys', requireAuth, (req, res) => {
  const { label, permissions } = req.body;
  const key = 'ak_' + uuidv4().replace(/-/g, '');
  apiKeyQueries.create.run({
    key_value: key,
    label: label || 'API Key',
    permissions: permissions || 'create_bot,read_bot',
  });
  res.json({ success: true, key });
});

router.delete('/api-keys/:id', requireAuth, (req, res) => {
  apiKeyQueries.delete.run(req.params.id);
  res.json({ success: true });
});

// ─── Webhooks ────────────────────────────
router.get('/webhooks', requireAuth, (req, res) => {
  const webhooks = webhookQueries.findAll.all();
  res.json({ success: true, webhooks });
});

// ─── Change Password ─────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const admin = adminQueries.findByUsername.get(req.admin.username);

  const valid = await bcrypt.compare(current_password, admin.password);
  if (!valid) return res.status(401).json({ success: false, error: 'Sai mật khẩu hiện tại' });

  const hashed = await bcrypt.hash(new_password, 10);
  const { db } = require('../models/database');
  db.prepare('UPDATE admins SET password=? WHERE username=?').run(hashed, req.admin.username);

  res.json({ success: true, message: 'Đã đổi mật khẩu' });
});

module.exports = router;
