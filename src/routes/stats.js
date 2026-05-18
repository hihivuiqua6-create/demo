const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// GET /api/bots/:botId/analytics
router.get('/analytics', authMiddleware, (req, res) => {
  const { days = 7 } = req.query;

  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT telegram_user_id) as unique_users,
      COUNT(*) as total_events,
      SUM(CASE WHEN event_type = 'start' THEN 1 ELSE 0 END) as starts,
      SUM(CASE WHEN event_type = 'message' THEN 1 ELSE 0 END) as messages,
      SUM(CASE WHEN event_type = 'webapp_data' THEN 1 ELSE 0 END) as webapp_interactions,
      SUM(CASE WHEN event_type = 'payment' THEN 1 ELSE 0 END) as payments
    FROM analytics
    WHERE bot_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
  `).get(req.params.botId, days);

  const daily = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as events,
      COUNT(DISTINCT telegram_user_id) as users
    FROM analytics
    WHERE bot_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(created_at) ORDER BY date ASC
  `).all(req.params.botId, days);

  const topApps = db.prepare(`
    SELECT m.name, m.id, m.access_count
    FROM miniapps m WHERE m.bot_id = ?
    ORDER BY m.access_count DESC LIMIT 5
  `).all(req.params.botId);

  res.json({ success: true, overview, daily, topApps });
});

// GET /api/bots/:botId/users
router.get('/users', authMiddleware, (req, res) => {
  const { page = 1, limit = 50, search = '' } = req.query;
  const offset = (page - 1) * limit;

  const users = db.prepare(`
    SELECT * FROM telegram_users
    WHERE bot_id = ? AND (username LIKE ? OR first_name LIKE ? OR telegram_id LIKE ?)
    ORDER BY last_seen DESC LIMIT ? OFFSET ?
  `).all(req.params.botId, `%${search}%`, `%${search}%`, `%${search}%`, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as c FROM telegram_users WHERE bot_id = ?
  `).get(req.params.botId).c;

  res.json({ success: true, users, total, page: parseInt(page), limit: parseInt(limit) });
});

module.exports = router;
