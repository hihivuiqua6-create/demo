const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');

// GET /api/bots/:botId/webhooks
router.get('/', authMiddleware, (req, res) => {
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE bot_id = ?').all(req.params.botId);
  res.json({ success: true, webhooks });
});

// POST /api/bots/:botId/webhooks
router.post('/', authMiddleware, (req, res) => {
  const { url, events, secret } = req.body;
  if (!url || !events) {
    return res.status(400).json({ success: false, error: 'URL and events required' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO webhooks (id, bot_id, url, events, secret)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.botId, url, JSON.stringify(events), secret || null);

  res.json({ success: true, id });
});

// DELETE /api/bots/:botId/webhooks/:id
router.delete('/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ? AND bot_id = ?').run(req.params.id, req.params.botId);
  res.json({ success: true });
});

// Toggle active
router.post('/:id/toggle', authMiddleware, (req, res) => {
  const wh = db.prepare('SELECT * FROM webhooks WHERE id = ? AND bot_id = ?').get(req.params.id, req.params.botId);
  if (!wh) return res.status(404).json({ success: false, error: 'Webhook not found' });

  db.prepare('UPDATE webhooks SET active = ? WHERE id = ?').run(wh.active ? 0 : 1, req.params.id);
  res.json({ success: true, active: !wh.active });
});

module.exports = router;
