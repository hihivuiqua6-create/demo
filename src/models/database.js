// src/models/database.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/platform.db';

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===================== SCHEMA =====================
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    bot_username TEXT,
    bot_name TEXT,
    web_url TEXT NOT NULL,
    welcome_message TEXT DEFAULT 'Xin chào! Nhấn nút bên dưới để mở ứng dụng.',
    button_text TEXT DEFAULT '🚀 Mở Mini App',
    status TEXT DEFAULT 'active',
    owner_api_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bot_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    telegram_user_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    language_code TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    FOREIGN KEY (bot_id) REFERENCES bots(id),
    UNIQUE(bot_id, telegram_user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    telegram_user_id INTEGER,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT DEFAULT 'all',
    secret TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bot_id) REFERENCES bots(id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value TEXT UNIQUE NOT NULL,
    label TEXT,
    permissions TEXT DEFAULT 'create_bot,read_bot',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME
  );
`);

// ===================== BOT QUERIES =====================
const botQueries = {
  create: db.prepare(`
    INSERT INTO bots (id, token, bot_username, bot_name, web_url, welcome_message, button_text, owner_api_key)
    VALUES (@id, @token, @bot_username, @bot_name, @web_url, @welcome_message, @button_text, @owner_api_key)
  `),
  findById: db.prepare('SELECT * FROM bots WHERE id = ?'),
  findByToken: db.prepare('SELECT * FROM bots WHERE token = ?'),
  findAll: db.prepare('SELECT * FROM bots ORDER BY created_at DESC'),
  update: db.prepare(`
    UPDATE bots SET web_url=@web_url, welcome_message=@welcome_message, button_text=@button_text,
    bot_username=@bot_username, bot_name=@bot_name, status=@status, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `),
  delete: db.prepare('DELETE FROM bots WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) as count FROM bots'),
  countActive: db.prepare("SELECT COUNT(*) as count FROM bots WHERE status='active'"),
};

// ===================== USER QUERIES =====================
const userQueries = {
  upsert: db.prepare(`
    INSERT INTO bot_users (bot_id, telegram_user_id, username, first_name, last_name, language_code, message_count)
    VALUES (@bot_id, @telegram_user_id, @username, @first_name, @last_name, @language_code, 1)
    ON CONFLICT(bot_id, telegram_user_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      last_seen=CURRENT_TIMESTAMP,
      message_count=message_count+1
  `),
  findByBot: db.prepare('SELECT * FROM bot_users WHERE bot_id = ? ORDER BY last_seen DESC'),
  countByBot: db.prepare('SELECT COUNT(*) as count FROM bot_users WHERE bot_id = ?'),
  totalUsers: db.prepare('SELECT COUNT(*) as count FROM bot_users'),
};

// ===================== ANALYTICS QUERIES =====================
const analyticsQueries = {
  insert: db.prepare(`
    INSERT INTO analytics (bot_id, event_type, telegram_user_id, metadata)
    VALUES (@bot_id, @event_type, @telegram_user_id, @metadata)
  `),
  getByBot: db.prepare(`
    SELECT event_type, COUNT(*) as count, DATE(created_at) as date
    FROM analytics WHERE bot_id = ?
    GROUP BY event_type, DATE(created_at)
    ORDER BY date DESC LIMIT 30
  `),
  getRecentByBot: db.prepare(`
    SELECT * FROM analytics WHERE bot_id = ? ORDER BY created_at DESC LIMIT 100
  `),
  totalEvents: db.prepare('SELECT COUNT(*) as count FROM analytics'),
};

// ===================== ADMIN QUERIES =====================
const adminQueries = {
  create: db.prepare('INSERT INTO admins (username, password) VALUES (@username, @password)'),
  findByUsername: db.prepare('SELECT * FROM admins WHERE username = ?'),
};

// ===================== API KEY QUERIES =====================
const apiKeyQueries = {
  create: db.prepare('INSERT INTO api_keys (key_value, label, permissions) VALUES (@key_value, @label, @permissions)'),
  findByKey: db.prepare('SELECT * FROM api_keys WHERE key_value = ?'),
  updateLastUsed: db.prepare('UPDATE api_keys SET last_used=CURRENT_TIMESTAMP WHERE key_value=?'),
  findAll: db.prepare('SELECT id, label, permissions, created_at, last_used FROM api_keys ORDER BY created_at DESC'),
  delete: db.prepare('DELETE FROM api_keys WHERE id = ?'),
};

// ===================== WEBHOOK QUERIES =====================
const webhookQueries = {
  create: db.prepare('INSERT INTO webhooks (bot_id, url, events, secret) VALUES (@bot_id, @url, @events, @secret)'),
  findByBot: db.prepare('SELECT * FROM webhooks WHERE bot_id = ? AND active = 1'),
  delete: db.prepare('DELETE FROM webhooks WHERE id = ?'),
  findAll: db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC'),
};

module.exports = {
  db,
  botQueries,
  userQueries,
  analyticsQueries,
  adminQueries,
  apiKeyQueries,
  webhookQueries,
};
