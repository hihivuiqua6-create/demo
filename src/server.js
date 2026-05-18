require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const db = require('./database');
const { startAllBots } = require('./botManager');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bots');
const miniappRoutes = require('./routes/miniapps');
const statsRoutes = require('./routes/stats');
const webhookRoutes = require('./routes/webhooks');
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts in dashboard
  crossOriginEmbedderPolicy: false
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// ─── Static Files ─────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '../public/dashboard')));
app.use('/static', express.static(path.join(__dirname, '../public')));

// ─── Mini App Viewer ──────────────────────────────────────────
// GET /app/:botId/:miniappId - serve the mini app HTML
app.get('/app/:botId/:miniappId', (req, res) => {
  try {
    const app_record = db.prepare('SELECT * FROM miniapps WHERE id = ? AND bot_id = ?')
      .get(req.params.miniappId, req.params.botId);

    if (!app_record) {
      return res.status(404).send(`
        <!DOCTYPE html><html><head><title>Not Found</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#fff;}
        .box{text-align:center;padding:2rem;}</style></head>
        <body><div class="box"><h1>404</h1><p>Mini App không tìm thấy</p></div></body></html>
      `);
    }

    // Update access count
    db.prepare('UPDATE miniapps SET access_count = access_count + 1 WHERE id = ?').run(req.params.miniappId);
    db.prepare(`INSERT INTO analytics (bot_id, miniapp_id, event_type) VALUES (?, ?, 'miniapp_open')`)
      .run(req.params.botId, req.params.miniappId);

    const ext = path.extname(app_record.filepath).toLowerCase();

    if (['.html', '.htm'].includes(ext)) {
      // Inject Telegram WebApp script into HTML
      let html = fs.readFileSync(app_record.filepath, 'utf8');

      // Inject Telegram WebApp SDK if not present
      if (!html.includes('telegram-web-app.js')) {
        html = html.replace('<head>', `<head>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>`);
      }
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } else {
      res.sendFile(path.resolve(app_record.filepath));
    }
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// ─── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/bots/:botId/miniapps', miniappRoutes);
app.use('/api/bots/:botId', statsRoutes);
app.use('/api/bots/:botId/webhooks', webhookRoutes);

// ─── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  const bots = db.prepare('SELECT COUNT(*) as c FROM bots').get().c;
  const apps = db.prepare('SELECT COUNT(*) as c FROM miniapps').get().c;
  res.json({ status: 'ok', bots, apps, uptime: process.uptime() });
});

// ─── Root - redirect to dashboard ─────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ─── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ─── Error Handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: err.message });
});

// ─── Start Server ─────────────────────────────────────────────
async function main() {
  // Run setup if no admin exists
  const adminCount = db.prepare('SELECT COUNT(*) as c FROM admins').get().c;
  if (adminCount === 0) {
    console.log('🔧 No admin found. Running setup...');
    await require('./setup');
    // Wait a moment for setup to complete
    await new Promise(r => setTimeout(r, 500));
  }

  // Start all existing bots
  await startAllBots();

  app.listen(PORT, HOST, () => {
    console.log(`\n🚀 Telegram Mini App Platform running!`);
    console.log(`   Local:   http://localhost:${PORT}/dashboard`);
    console.log(`   Network: http://${HOST}:${PORT}/dashboard`);
    console.log(`   BASE_URL: ${process.env.BASE_URL || `http://localhost:${PORT}`}\n`);
  });
}

main().catch(console.error);
