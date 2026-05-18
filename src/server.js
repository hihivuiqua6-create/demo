// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security Middleware ──────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
}));

// ── Rate Limiting ────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  message: { success: false, error: 'Too many requests' },
});
const createBotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { success: false, error: 'Too many bot creation requests' },
});

// ── Body Parsing ─────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// ── Static Files ─────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Health Check ─────────────────────────────────────
app.get('/health', (req, res) => {
  const botManager = require('./services/botManager');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    running_bots: botManager.getRunningCount(),
  });
});

// ── API Routes ────────────────────────────────────────
app.use('/api', apiLimiter);
app.use('/api/create-bot', createBotLimiter);
app.use('/api', require('./routes/api'));
app.use('/admin', require('./routes/admin'));

// ── Dashboard SPA fallback ────────────────────────────
app.get('/dashboard*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

// ── 404 ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// ── Error Handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Bootstrap ─────────────────────────────────────────
async function bootstrap() {
  const { adminQueries } = require('./models/database');
  const botManager = require('./services/botManager');

  // Tạo admin mặc định nếu chưa có
  const existingAdmin = adminQueries.findByUsername.get(process.env.ADMIN_USERNAME || 'admin');
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123456', 10);
    adminQueries.create.run({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: hashedPassword,
    });
    console.log(`✅ Admin account created: ${process.env.ADMIN_USERNAME || 'admin'}`);
  }

  // Khởi động tất cả bot từ DB
  await botManager.startAllBots();

  // Start server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Telegram Mini App Platform`);
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🎛️  Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🔑 Admin: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'Admin@123456'}`);
    console.log(`📋 API Docs: http://localhost:${PORT}/api-docs\n`);
  });
}

bootstrap().catch(console.error);

module.exports = app;
