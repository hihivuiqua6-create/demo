const express = require('express');
const router = express.Router({ mergeParams: true });
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
require('dotenv').config();

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const botDir = path.join(uploadDir, req.params.botId);
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
    cb(null, botDir);
  },
  filename: (req, file, cb) => {
    const unique = uuidv4().split('-')[0];
    const ext = path.extname(file.originalname) || '.html';
    cb(null, `${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.html', '.htm', '.css', '.js', '.png', '.jpg', '.gif', '.svg', '.ico', '.json', '.woff', '.woff2', '.ttf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

// GET /api/bots/:botId/miniapps
router.get('/', authMiddleware, (req, res) => {
  const apps = db.prepare('SELECT * FROM miniapps WHERE bot_id = ? ORDER BY is_default DESC, created_at DESC').all(req.params.botId);
  res.json({ success: true, miniapps: apps });
});

// POST /api/bots/:botId/miniapps - upload new miniapp
router.post('/', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file && !req.body.htmlContent) {
      return res.status(400).json({ success: false, error: 'File or HTML content required' });
    }

    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.botId);
    if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });

    let filename, filepath;

    if (req.body.htmlContent) {
      // Inline HTML editor mode
      const id = uuidv4().split('-')[0];
      filename = `${id}.html`;
      const botDir = path.join(uploadDir, req.params.botId);
      if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
      filepath = path.join(botDir, filename);
      fs.writeFileSync(filepath, req.body.htmlContent, 'utf8');
    } else {
      filename = req.file.filename;
      filepath = req.file.path;
    }

    const id = uuidv4();
    const name = req.body.name || path.basename(filename, path.extname(filename));
    const description = req.body.description || '';
    const isDefault = req.body.isDefault === 'true' || req.body.isDefault === true ? 1 : 0;

    // If setting as default, unset others
    if (isDefault) {
      db.prepare('UPDATE miniapps SET is_default = 0 WHERE bot_id = ?').run(req.params.botId);
    }

    // Auto-set as default if first app
    const existingCount = db.prepare('SELECT COUNT(*) as c FROM miniapps WHERE bot_id = ?').get(req.params.botId).c;
    const setDefault = existingCount === 0 ? 1 : isDefault;

    db.prepare(`
      INSERT INTO miniapps (id, bot_id, name, description, filename, filepath, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.botId, name, description, filename, filepath, setDefault);

    res.json({
      success: true,
      miniapp: { id, name, filename, is_default: setDefault }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/bots/:botId/miniapps/:id - update miniapp (re-upload or rename)
router.put('/:id', authMiddleware, upload.single('file'), (req, res) => {
  try {
    const app = db.prepare('SELECT * FROM miniapps WHERE id = ? AND bot_id = ?').get(req.params.id, req.params.botId);
    if (!app) return res.status(404).json({ success: false, error: 'Mini App not found' });

    const isDefault = req.body.isDefault === 'true' ? 1 : (req.body.isDefault === 'false' ? 0 : app.is_default);

    if (isDefault) {
      db.prepare('UPDATE miniapps SET is_default = 0 WHERE bot_id = ?').run(req.params.botId);
    }

    let filename = app.filename;
    let filepath = app.filepath;

    if (req.body.htmlContent) {
      fs.writeFileSync(app.filepath, req.body.htmlContent, 'utf8');
    } else if (req.file) {
      // Delete old file
      if (fs.existsSync(app.filepath)) fs.unlinkSync(app.filepath);
      filename = req.file.filename;
      filepath = req.file.path;
    }

    db.prepare(`
      UPDATE miniapps SET name = COALESCE(?, name), description = COALESCE(?, description),
        filename = ?, filepath = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.body.name, req.body.description, filename, filepath, isDefault, req.params.id);

    res.json({ success: true, message: 'Mini App updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bots/:botId/miniapps/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const app = db.prepare('SELECT * FROM miniapps WHERE id = ? AND bot_id = ?').get(req.params.id, req.params.botId);
  if (!app) return res.status(404).json({ success: false, error: 'Mini App not found' });

  if (fs.existsSync(app.filepath)) fs.unlinkSync(app.filepath);
  db.prepare('DELETE FROM miniapps WHERE id = ?').run(req.params.id);

  res.json({ success: true, message: 'Mini App deleted' });
});

// GET /api/bots/:botId/miniapps/:id/content - get HTML content for editor
router.get('/:id/content', authMiddleware, (req, res) => {
  const app = db.prepare('SELECT * FROM miniapps WHERE id = ? AND bot_id = ?').get(req.params.id, req.params.botId);
  if (!app) return res.status(404).json({ success: false, error: 'Mini App not found' });

  const ext = path.extname(app.filepath).toLowerCase();
  if (!['.html', '.htm'].includes(ext)) {
    return res.status(400).json({ success: false, error: 'Only HTML files can be edited' });
  }

  const content = fs.readFileSync(app.filepath, 'utf8');
  res.json({ success: true, content });
});

// POST /api/bots/:botId/miniapps/:id/set-default
router.post('/:id/set-default', authMiddleware, (req, res) => {
  const app = db.prepare('SELECT * FROM miniapps WHERE id = ? AND bot_id = ?').get(req.params.id, req.params.botId);
  if (!app) return res.status(404).json({ success: false, error: 'Mini App not found' });

  db.prepare('UPDATE miniapps SET is_default = 0 WHERE bot_id = ?').run(req.params.botId);
  db.prepare('UPDATE miniapps SET is_default = 1 WHERE id = ?').run(req.params.id);

  res.json({ success: true, message: 'Default app set' });
});

module.exports = router;
