const express = require('express');
const router = express.Router();
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { startBot, stopBot, restartBot, activeBots } = require('../botManager');

// GET /api/bots - list all bots
router.get('/', authMiddleware, (req, res) => {
  const bots = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM miniapps WHERE bot_id = b.id) as miniapp_count,
      (SELECT COUNT(*) FROM telegram_users WHERE bot_id = b.id) as user_count,
      (SELECT COUNT(*) FROM analytics WHERE bot_id = b.id) as event_count
    FROM bots b ORDER BY b.created_at DESC
  `).all();

  const result = bots.map(b => ({
    ...b,
    token: b.token.substring(0, 8) + '...',
    isRunning: activeBots.has(b.id)
  }));

  res.json({ success: true, bots: result });
});

// POST /api/bots - create new bot
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { token, welcomeMessage, welcomeButtonText } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Bot token required' });
    }

    // Validate token with Telegram
    const testBot = new TelegramBot(token, { polling: false });
    let botInfo;
    try {
      botInfo = await testBot.getMe();
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid bot token. Check your token from @BotFather.' });
    }

    // Check if already exists
    const existing = db.prepare('SELECT id FROM bots WHERE token = ?').get(token);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Bot already registered' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO bots (id, token, username, name, welcome_message, welcome_button_text)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id, token,
      botInfo.username,
      botInfo.first_name,
      welcomeMessage || 'Chào mừng! Nhấn nút bên dưới để mở Mini App.',
      welcomeButtonText || '🚀 Mở Mini App'
    );

    const botRecord = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
    await startBot(botRecord);

    res.json({
      success: true,
      bot: {
        id,
        username: botInfo.username,
        name: botInfo.first_name,
        isRunning: true
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bots/:id - get single bot
router.get('/:id', authMiddleware, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });

  res.json({
    success: true,
    bot: {
      ...bot,
      token: bot.token.substring(0, 8) + '...',
      isRunning: activeBots.has(bot.id)
    }
  });
});

// PUT /api/bots/:id - update bot settings
router.put('/:id', authMiddleware, (req, res) => {
  const { welcomeMessage, welcomeButtonText, status } = req.body;
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });

  db.prepare(`
    UPDATE bots SET
      welcome_message = COALESCE(?, welcome_message),
      welcome_button_text = COALESCE(?, welcome_button_text),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(welcomeMessage, welcomeButtonText, status, req.params.id);

  res.json({ success: true, message: 'Bot updated' });
});

// DELETE /api/bots/:id - delete bot
router.delete('/:id', authMiddleware, async (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });

  await stopBot(req.params.id);
  db.prepare('DELETE FROM bots WHERE id = ?').run(req.params.id);

  res.json({ success: true, message: 'Bot deleted' });
});

// POST /api/bots/:id/restart - restart bot
router.post('/:id/restart', authMiddleware, async (req, res) => {
  try {
    await restartBot(req.params.id);
    res.json({ success: true, message: 'Bot restarted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bots/:id/stop
router.post('/:id/stop', authMiddleware, async (req, res) => {
  await stopBot(req.params.id);
  db.prepare(`UPDATE bots SET status = 'stopped' WHERE id = ?`).run(req.params.id);
  res.json({ success: true, message: 'Bot stopped' });
});

// POST /api/bots/:id/start
router.post('/:id/start', authMiddleware, async (req, res) => {
  try {
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
    if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });

    db.prepare(`UPDATE bots SET status = 'active' WHERE id = ?`).run(req.params.id);
    const updated = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
    await startBot(updated);

    res.json({ success: true, message: 'Bot started' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bots/:id/broadcast
router.post('/:id/broadcast', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message required' });

    const bot = activeBots.get(req.params.id);
    if (!bot) return res.status(400).json({ success: false, error: 'Bot not running' });

    const users = db.prepare('SELECT DISTINCT telegram_id FROM telegram_users WHERE bot_id = ?').all(req.params.id);
    let sent = 0, failed = 0;

    for (const user of users) {
      try {
        await bot.sendMessage(user.telegram_id, message, { parse_mode: 'HTML' });
        sent++;
        await new Promise(r => setTimeout(r, 50)); // rate limit
      } catch (e) { failed++; }
    }

    res.json({ success: true, sent, failed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
