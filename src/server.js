// TGBot Platform — Multi-bot Telegram Mini App
// v2.1 — User tracking, message history, broadcast, menu button (PC fix)
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const TelegramBot = require("node-telegram-bot-api");

// ---------- CONFIG ----------
const CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(48).toString("hex"),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123456",
  LICENSE_VERIFY_URL: process.env.LICENSE_VERIFY_URL || "",
  LICENSE_REQUIRED: process.env.LICENSE_REQUIRED === "1",
  DEVICE_ID: process.env.DEVICE_ID || require("os").hostname(),
  DB_PATH: process.env.DB_PATH || path.join(__dirname, "..", "database", "tgbot.db"),
  UPLOAD_DIR: path.join(__dirname, "..", "public", "uploads"),
};

fs.mkdirSync(path.dirname(CONFIG.DB_PATH), { recursive: true });
fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });

// ---------- DB ----------
const db = new Database(CONFIG.DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  web_url TEXT NOT NULL,
  welcome TEXT,
  button_label TEXT DEFAULT 'Mở Shop (Mini App)',
  owner_seller_id INTEGER,
  active INTEGER DEFAULT 1,
  bot_username TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bot_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  chat_id INTEGER,
  username TEXT, first_name TEXT, last_name TEXT,
  msg_count INTEGER DEFAULT 0,
  first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, tg_user_id)
);
CREATE TABLE IF NOT EXISTS bot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  direction TEXT NOT NULL,   -- 'in' | 'out'
  text TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_msg_bot_user ON bot_messages(bot_id, tg_user_id, id);
CREATE INDEX IF NOT EXISTS idx_users_last ON bot_users(bot_id, last_seen);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_role TEXT NOT NULL, sender_id INTEGER,
  bot_id INTEGER,            -- NULL = all bots (admin)
  text TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  balance INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  transfer_code TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending',
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// add chat_id column if upgrading old DB
try { db.exec("ALTER TABLE bot_users ADD COLUMN chat_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE bot_users ADD COLUMN msg_count INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE bot_users ADD COLUMN first_seen TEXT"); } catch {}
try { db.exec("ALTER TABLE bots ADD COLUMN bot_username TEXT"); } catch {}

const getSetting = (k, d = "") => {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

for (const [k, v] of [["bank_name", ""], ["bank_account", ""], ["bank_owner", ""], ["bank_qr_url", ""], ["topup_prefix", "NAP"]]) {
  if (!getSetting(k)) setSetting(k, v);
}

// ---------- UTILS ----------
const DEFAULT_WELCOME = `🌟 <b>HỆ THỐNG DỊCH VỤ TỰ ĐỘNG</b>
━━━━━━━━━━━━━━━━━━━━━━

👋 Chào 🌸 <b>{full_name}</b>, hệ thống đã được đồng bộ.

🚀 Vui lòng nhấn nút bên dưới hoặc thanh Menu để mở App.`;

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function countMonthlyUsers(botId) {
  const r = db.prepare(
    "SELECT COUNT(DISTINCT tg_user_id) c FROM bot_users WHERE bot_id=? AND last_seen >= datetime('now','-30 days')"
  ).get(botId);
  return r?.c || 0;
}

function renderWelcome(tpl, user = {}, botId = 0) {
  const first = escapeHtml(user.first_name || "");
  const last = escapeHtml(user.last_name || "");
  const uname = escapeHtml(user.username || "");
  const full = (first + " " + last).trim() || uname || "bạn";
  const monthly = countMonthlyUsers(botId);
  return (tpl || DEFAULT_WELCOME)
    .replace(/\{first_name\}/g, first)
    .replace(/\{last_name\}/g, last)
    .replace(/\{username\}/g, uname)
    .replace(/\{full_name\}/g, full)
    .replace(/\{name\}/g, full)
    .replace(/\{monthly_users\}/g, String(monthly));
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function hashPassword(pwd, salt = crypto.randomBytes(16).toString("hex")) {
  const h = crypto.scryptSync(pwd, salt, 64).toString("hex");
  return `${salt}:${h}`;
}
function verifyPassword(pwd, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, h] = stored.split(":");
  const calc = crypto.scryptSync(pwd, salt, 64).toString("hex");
  return safeEqual(calc, h);
}
function randTransferCode() {
  const prefix = getSetting("topup_prefix", "NAP");
  const rnd = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}${rnd}`;
}

// ---------- LICENSE KEY CHECK (optional, anti-crack) ----------
async function verifyLicenseKey(key) {
  if (!CONFIG.LICENSE_REQUIRED) return { ok: true };
  if (!CONFIG.LICENSE_VERIFY_URL) return { ok: true };
  if (!key) return { ok: false, msg: "Thiếu license key" };
  try {
    const res = await fetch(CONFIG.LICENSE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, device_id: CONFIG.DEVICE_ID }),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) return { ok: false, msg: `Server license ${res.status}` };
    if (data && data.success === true) return { ok: true };
    return { ok: false, msg: data?.message || "Key không hợp lệ" };
  } catch (e) {
    return { ok: false, msg: "Không kết nối được server license" };
  }
}

// ---------- MESSAGE LOGGING ----------
function upsertUser(bot_id, msg) {
  const u = msg.from || {};
  const chat_id = msg.chat?.id;
  db.prepare(
    `INSERT INTO bot_users(bot_id,tg_user_id,chat_id,username,first_name,last_name,msg_count,first_seen,last_seen)
     VALUES(?,?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT(bot_id,tg_user_id) DO UPDATE SET
       chat_id=excluded.chat_id,
       username=excluded.username,
       first_name=excluded.first_name,
       last_name=excluded.last_name,
       msg_count=msg_count+1,
       last_seen=CURRENT_TIMESTAMP`
  ).run(bot_id, u.id, chat_id, u.username || null, u.first_name || null, u.last_name || null);
}
function logMsg(bot_id, tg_user_id, direction, text) {
  db.prepare("INSERT INTO bot_messages(bot_id,tg_user_id,direction,text) VALUES(?,?,?,?)")
    .run(bot_id, tg_user_id, direction, String(text || "").slice(0, 4000));
}

// ---------- BOT REGISTRY ----------
const liveBots = new Map(); // bot_id -> TelegramBot

async function startBot(row) {
  if (liveBots.has(row.id)) return;
  try {
    const tg = new TelegramBot(row.token, { polling: true });

    // store bot identity & set chat menu button (fix PC: shows button at bottom-left)
    try {
      const me = await tg.getMe();
      if (me?.username) db.prepare("UPDATE bots SET bot_username=? WHERE id=?").run(me.username, row.id);
    } catch (e) { console.error("[getMe]", e.message); }

    try {
      await tg.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: row.button_label || "Mở Shop",
          web_app: { url: row.web_url },
        },
      });
    } catch (e) { console.error("[setMenuButton]", e.message); }

    tg.on("polling_error", (e) => console.error(`[bot ${row.id}] polling`, e.code || e.message));

    // Log EVERY incoming message + upsert user
    tg.on("message", (msg) => {
      if (!msg.from || msg.from.is_bot) return;
      try {
        upsertUser(row.id, msg);
        logMsg(row.id, msg.from.id, "in", msg.text || `[${msg.photo ? "photo" : msg.document ? "doc" : msg.sticker ? "sticker" : "media"}]`);
      } catch (e) { console.error("[log in]", e.message); }
    });

    // /start handler — welcome + inline button
    tg.onText(/^\/start/, async (msg) => {
      const u = msg.from || {};
      const text = renderWelcome(row.welcome, u, row.id);
      try {
        await tg.sendMessage(msg.chat.id, text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "🛒 " + (row.button_label || "Mở Shop (Mini App)"), web_app: { url: row.web_url } }]],
          },
        });
        logMsg(row.id, u.id, "out", text);
      } catch (e) { console.error("[send start]", e.message); }
    });

    liveBots.set(row.id, tg);
    console.log(`✅ Bot #${row.id} started`);
  } catch (e) {
    console.error(`❌ Bot #${row.id} start fail:`, e.message);
  }
}

async function stopBot(id) {
  const tg = liveBots.get(id);
  if (!tg) return;
  try { await tg.stopPolling(); } catch {}
  liveBots.delete(id);
  console.log(`⏹  Bot #${id} stopped`);
}

db.prepare("SELECT * FROM bots WHERE active=1").all().forEach(startBot);

// ---------- APP ----------
const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const broadcastLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// ---------- AUTH ----------
function authRequired(roles = ["admin", "seller"]) {
  return (req, res, next) => {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Chưa đăng nhập" });
    try {
      const payload = jwt.verify(h.slice(7), CONFIG.JWT_SECRET);
      if (!roles.includes(payload.role)) return res.status(403).json({ error: "Không có quyền" });
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ error: "Token không hợp lệ" });
    }
  };
}
const adminOnly = authRequired(["admin"]);
const sellerOnly = authRequired(["seller"]);
const anyAuth = authRequired(["admin", "seller"]);

// helper: bot IDs visible to current user
function visibleBotIds(req) {
  if (req.user.role === "admin") return null; // all
  return db.prepare("SELECT id FROM bots WHERE owner_seller_id=?").all(req.user.id).map(r => r.id);
}

// ---------- STATIC ----------
app.get("/", (_req, res) => res.redirect("/login"));
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));
app.get("/seller", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "seller.html")));
app.get("/app.css", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "app.css")));
app.use("/uploads", express.static(CONFIG.UPLOAD_DIR));

// ---------- AUTH ROUTES ----------
app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin" });

  if ((role || "admin") === "admin") {
    if (safeEqual(username, CONFIG.ADMIN_USERNAME) && safeEqual(password, CONFIG.ADMIN_PASSWORD)) {
      const token = jwt.sign({ id: 0, username, role: "admin" }, CONFIG.JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, role: "admin", username });
    }
  }
  const s = db.prepare("SELECT * FROM sellers WHERE username=? AND active=1").get(username);
  if (s && verifyPassword(password, s.password_hash)) {
    const token = jwt.sign({ id: s.id, username: s.username, role: "seller" }, CONFIG.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, role: "seller", username: s.username, display_name: s.display_name });
  }
  return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
});

app.get("/api/me", anyAuth, (req, res) => {
  if (req.user.role === "admin") return res.json({ role: "admin", username: req.user.username });
  const s = db.prepare("SELECT id,username,display_name,balance FROM sellers WHERE id=?").get(req.user.id);
  res.json({ role: "seller", ...s });
});

// ---------- SELLERS (admin) ----------
app.get("/api/admin/sellers", adminOnly, (_req, res) => {
  res.json(db.prepare("SELECT id,username,display_name,balance,active,created_at FROM sellers ORDER BY id DESC").all());
});
app.post("/api/admin/sellers", adminOnly, (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu username/password" });
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: "Username không hợp lệ" });
  if (password.length < 6) return res.status(400).json({ error: "Password tối thiểu 6 ký tự" });
  try {
    const info = db.prepare("INSERT INTO sellers(username,password_hash,display_name) VALUES(?,?,?)")
      .run(username, hashPassword(password), display_name || username);
    res.json({ id: info.lastInsertRowid, username });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch("/api/admin/sellers/:id", adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const { password, display_name, active, balance_delta } = req.body || {};
  const s = db.prepare("SELECT * FROM sellers WHERE id=?").get(id);
  if (!s) return res.status(404).json({ error: "Không tìm thấy" });
  if (password) db.prepare("UPDATE sellers SET password_hash=? WHERE id=?").run(hashPassword(password), id);
  if (display_name !== undefined) db.prepare("UPDATE sellers SET display_name=? WHERE id=?").run(display_name, id);
  if (active !== undefined) db.prepare("UPDATE sellers SET active=? WHERE id=?").run(active ? 1 : 0, id);
  if (balance_delta) db.prepare("UPDATE sellers SET balance=balance+? WHERE id=?").run(Number(balance_delta) | 0, id);
  res.json({ ok: true });
});
app.delete("/api/admin/sellers/:id", adminOnly, (req, res) => {
  db.prepare("DELETE FROM sellers WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- BANK ----------
app.get("/api/bank", anyAuth, (_req, res) => {
  res.json({
    bank_name: getSetting("bank_name"), bank_account: getSetting("bank_account"),
    bank_owner: getSetting("bank_owner"), bank_qr_url: getSetting("bank_qr_url"),
    topup_prefix: getSetting("topup_prefix", "NAP"),
  });
});
app.post("/api/admin/bank", adminOnly, (req, res) => {
  const { bank_name, bank_account, bank_owner, bank_qr_url, topup_prefix } = req.body || {};
  if (bank_name !== undefined) setSetting("bank_name", bank_name);
  if (bank_account !== undefined) setSetting("bank_account", bank_account);
  if (bank_owner !== undefined) setSetting("bank_owner", bank_owner);
  if (bank_qr_url !== undefined) setSetting("bank_qr_url", bank_qr_url);
  if (topup_prefix !== undefined) setSetting("topup_prefix", topup_prefix);
  res.json({ ok: true });
});
app.post("/api/admin/bank/qr-upload", adminOnly, (req, res) => {
  const { data_url } = req.body || {};
  if (!data_url || !data_url.startsWith("data:image/")) return res.status(400).json({ error: "data_url không hợp lệ" });
  const m = data_url.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Định dạng không hỗ trợ" });
  const ext = m[1].replace("jpeg", "jpg");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: "Ảnh > 2MB" });
  const fname = `qr-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(CONFIG.UPLOAD_DIR, fname), buf);
  const url = `/uploads/${fname}`;
  setSetting("bank_qr_url", url);
  res.json({ url });
});

// ---------- TOPUPS ----------
app.post("/api/seller/topups", sellerOnly, (req, res) => {
  const amount = Math.max(0, Math.floor(Number(req.body?.amount) || 0));
  if (amount < 10000) return res.status(400).json({ error: "Tối thiểu 10,000đ" });
  const code = randTransferCode();
  const info = db.prepare("INSERT INTO topups(seller_id,amount,transfer_code) VALUES(?,?,?)").run(req.user.id, amount, code);
  res.json({
    id: info.lastInsertRowid, amount, transfer_code: code,
    bank: {
      bank_name: getSetting("bank_name"), bank_account: getSetting("bank_account"),
      bank_owner: getSetting("bank_owner"), bank_qr_url: getSetting("bank_qr_url"),
    },
  });
});
app.get("/api/seller/topups", sellerOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM topups WHERE seller_id=? ORDER BY id DESC LIMIT 100").all(req.user.id));
});
app.get("/api/admin/topups", adminOnly, (_req, res) => {
  res.json(db.prepare(`
    SELECT t.*, s.username AS seller_username, s.display_name AS seller_display_name
    FROM topups t LEFT JOIN sellers s ON s.id=t.seller_id
    ORDER BY t.id DESC LIMIT 500`).all());
});
app.post("/api/admin/topups/:id/approve", adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare("SELECT * FROM topups WHERE id=?").get(id);
  if (!t) return res.status(404).json({ error: "Không tìm thấy" });
  if (t.status !== "pending") return res.status(400).json({ error: "Đã xử lý" });
  const tx = db.transaction(() => {
    db.prepare("UPDATE topups SET status='approved', reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    db.prepare("UPDATE sellers SET balance=balance+? WHERE id=?").run(t.amount, t.seller_id);
  });
  tx();
  res.json({ ok: true });
});
app.post("/api/admin/topups/:id/reject", adminOnly, (req, res) => {
  db.prepare("UPDATE topups SET status='rejected', reviewed_at=CURRENT_TIMESTAMP, note=? WHERE id=?")
    .run(String(req.body?.note || ""), Number(req.params.id));
  res.json({ ok: true });
});

// ---------- BOTS ----------
app.post("/api/bots", anyAuth, async (req, res) => {
  const { token, web_url, welcome, button_label, license_key } = req.body || {};
  if (!token || !web_url) return res.status(400).json({ error: "Thiếu token / web_url" });
  if (!/^https:\/\//i.test(web_url)) return res.status(400).json({ error: "web_url phải là HTTPS" });
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return res.status(400).json({ error: "Bot token sai định dạng" });

  const lic = await verifyLicenseKey(license_key);
  if (!lic.ok) return res.status(403).json({ error: "License: " + lic.msg });

  try {
    const owner = req.user.role === "seller" ? req.user.id : null;
    const info = db.prepare("INSERT INTO bots(token,web_url,welcome,button_label,owner_seller_id) VALUES(?,?,?,?,?)")
      .run(token, web_url, welcome || null, button_label || "Mở Shop (Mini App)", owner);
    const row = db.prepare("SELECT * FROM bots WHERE id=?").get(info.lastInsertRowid);
    await startBot(row);
    res.json({ id: row.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/bots", anyAuth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT id,web_url,button_label,active,owner_seller_id,bot_username,created_at FROM bots ORDER BY id DESC").all()
    : db.prepare("SELECT id,web_url,button_label,active,bot_username,created_at FROM bots WHERE owner_seller_id=? ORDER BY id DESC").all(req.user.id);
  res.json(rows);
});

app.patch("/api/bots/:id", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Không tìm thấy" });
  if (req.user.role === "seller" && row.owner_seller_id !== req.user.id)
    return res.status(403).json({ error: "Không có quyền" });
  const { web_url, welcome, button_label, active } = req.body || {};
  if (web_url) db.prepare("UPDATE bots SET web_url=? WHERE id=?").run(web_url, id);
  if (welcome !== undefined) db.prepare("UPDATE bots SET welcome=? WHERE id=?").run(welcome, id);
  if (button_label !== undefined) db.prepare("UPDATE bots SET button_label=? WHERE id=?").run(button_label, id);
  if (active !== undefined) {
    db.prepare("UPDATE bots SET active=? WHERE id=?").run(active ? 1 : 0, id);
    if (active) await startBot(db.prepare("SELECT * FROM bots WHERE id=?").get(id));
    else await stopBot(id);
  }
  // Re-apply menu button if web_url or label changed and bot is live
  const tg = liveBots.get(id);
  if (tg && (web_url || button_label !== undefined)) {
    const fresh = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
    try {
      await tg.setChatMenuButton({
        menu_button: { type: "web_app", text: fresh.button_label || "Mở Shop", web_app: { url: fresh.web_url } },
      });
    } catch (e) { console.error("[reapply menu]", e.message); }
  }
  res.json({ ok: true });
});

app.delete("/api/bots/:id", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  if (!row) return res.json({ ok: true });
  if (req.user.role === "seller" && row.owner_seller_id !== req.user.id)
    return res.status(403).json({ error: "Không có quyền" });
  await stopBot(id);
  db.prepare("DELETE FROM bots WHERE id=?").run(id);
  db.prepare("DELETE FROM bot_users WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM bot_messages WHERE bot_id=?").run(id);
  res.json({ ok: true });
});

// ---------- USERS & MESSAGES ----------
// List users (admin sees all bots, seller only own)
app.get("/api/users", anyAuth, (req, res) => {
  const botIds = visibleBotIds(req);
  const botFilter = req.query.bot_id ? Number(req.query.bot_id) : null;
  const q = (req.query.q || "").toString().trim().toLowerCase();
  let where = "1=1";
  const params = [];
  if (botIds !== null) {
    if (botIds.length === 0) return res.json([]);
    where += ` AND u.bot_id IN (${botIds.map(() => "?").join(",")})`;
    params.push(...botIds);
  }
  if (botFilter) { where += " AND u.bot_id=?"; params.push(botFilter); }
  if (q) {
    where += " AND (LOWER(IFNULL(u.username,'')) LIKE ? OR LOWER(IFNULL(u.first_name,'')) LIKE ? OR LOWER(IFNULL(u.last_name,'')) LIKE ? OR CAST(u.tg_user_id AS TEXT) LIKE ?)";
    const like = `%${q}%`; params.push(like, like, like, like);
  }
  const rows = db.prepare(
    `SELECT u.id, u.bot_id, u.tg_user_id, u.username, u.first_name, u.last_name,
            u.msg_count, u.first_seen, u.last_seen, b.bot_username
     FROM bot_users u LEFT JOIN bots b ON b.id=u.bot_id
     WHERE ${where}
     ORDER BY u.last_seen DESC LIMIT 500`
  ).all(...params);
  res.json(rows);
});

// Chat history with one user
app.get("/api/users/:botId/:tgUserId/messages", anyAuth, (req, res) => {
  const bot_id = Number(req.params.botId);
  const tg_user_id = Number(req.params.tgUserId);
  if (req.user.role === "seller") {
    const own = db.prepare("SELECT 1 FROM bots WHERE id=? AND owner_seller_id=?").get(bot_id, req.user.id);
    if (!own) return res.status(403).json({ error: "Không có quyền" });
  }
  const rows = db.prepare(
    "SELECT id,direction,text,created_at FROM bot_messages WHERE bot_id=? AND tg_user_id=? ORDER BY id ASC LIMIT 1000"
  ).all(bot_id, tg_user_id);
  const user = db.prepare("SELECT * FROM bot_users WHERE bot_id=? AND tg_user_id=?").get(bot_id, tg_user_id);
  res.json({ user, messages: rows });
});

// Admin can also send a direct message to a specific user
app.post("/api/users/:botId/:tgUserId/send", anyAuth, async (req, res) => {
  const bot_id = Number(req.params.botId);
  const tg_user_id = Number(req.params.tgUserId);
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Thiếu nội dung" });
  if (req.user.role === "seller") {
    const own = db.prepare("SELECT 1 FROM bots WHERE id=? AND owner_seller_id=?").get(bot_id, req.user.id);
    if (!own) return res.status(403).json({ error: "Không có quyền" });
  }
  const tg = liveBots.get(bot_id);
  if (!tg) return res.status(400).json({ error: "Bot không hoạt động" });
  const u = db.prepare("SELECT chat_id FROM bot_users WHERE bot_id=? AND tg_user_id=?").get(bot_id, tg_user_id);
  const chatId = u?.chat_id || tg_user_id;
  try {
    await tg.sendMessage(chatId, text, { parse_mode: "HTML" });
    logMsg(bot_id, tg_user_id, "out", text);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- BROADCAST ----------
app.post("/api/broadcast", anyAuth, broadcastLimiter, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const targetBotId = req.body?.bot_id ? Number(req.body.bot_id) : null;
  if (!text) return res.status(400).json({ error: "Thiếu nội dung" });
  if (text.length > 3500) return res.status(400).json({ error: "Quá dài (max 3500)" });

  // Determine target bots
  let botRows;
  if (req.user.role === "admin") {
    botRows = targetBotId
      ? db.prepare("SELECT id FROM bots WHERE id=? AND active=1").all(targetBotId)
      : db.prepare("SELECT id FROM bots WHERE active=1").all();
  } else {
    botRows = targetBotId
      ? db.prepare("SELECT id FROM bots WHERE id=? AND owner_seller_id=? AND active=1").all(targetBotId, req.user.id)
      : db.prepare("SELECT id FROM bots WHERE owner_seller_id=? AND active=1").all(req.user.id);
  }
  if (botRows.length === 0) return res.status(400).json({ error: "Không có bot nào để gửi" });

  const broadcastId = db.prepare(
    "INSERT INTO broadcasts(sender_role,sender_id,bot_id,text,total) VALUES(?,?,?,?,0)"
  ).run(req.user.role, req.user.id || 0, targetBotId, text).lastInsertRowid;

  // Collect (bot, chat_id) targets
  const targets = [];
  for (const b of botRows) {
    const users = db.prepare("SELECT tg_user_id, chat_id FROM bot_users WHERE bot_id=?").all(b.id);
    for (const u of users) targets.push({ bot_id: b.id, chat_id: u.chat_id || u.tg_user_id, tg_user_id: u.tg_user_id });
  }
  db.prepare("UPDATE broadcasts SET total=? WHERE id=?").run(targets.length, broadcastId);

  res.json({ ok: true, broadcast_id: broadcastId, total: targets.length });

  // Send asynchronously (don't block HTTP response). 30 msg/sec safe rate.
  (async () => {
    let sent = 0, failed = 0;
    for (const t of targets) {
      const tg = liveBots.get(t.bot_id);
      if (!tg) { failed++; continue; }
      try {
        await tg.sendMessage(t.chat_id, text, { parse_mode: "HTML" });
        logMsg(t.bot_id, t.tg_user_id, "out", "[broadcast] " + text);
        sent++;
      } catch (e) { failed++; }
      if ((sent + failed) % 25 === 0) {
        db.prepare("UPDATE broadcasts SET sent=?, failed=? WHERE id=?").run(sent, failed, broadcastId);
        await new Promise(r => setTimeout(r, 1100));
      }
    }
    db.prepare("UPDATE broadcasts SET sent=?, failed=? WHERE id=?").run(sent, failed, broadcastId);
    console.log(`📢 Broadcast #${broadcastId}: sent=${sent} failed=${failed}`);
  })();
});

app.get("/api/broadcasts", anyAuth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 100").all()
    : db.prepare("SELECT * FROM broadcasts WHERE sender_role='seller' AND sender_id=? ORDER BY id DESC LIMIT 100").all(req.user.id);
  res.json(rows);
});

// ---------- STATS ----------
app.get("/api/stats", anyAuth, (req, res) => {
  if (req.user.role === "admin") {
    return res.json({
      bots: db.prepare("SELECT COUNT(*) c FROM bots").get().c,
      bots_active: db.prepare("SELECT COUNT(*) c FROM bots WHERE active=1").get().c,
      users: db.prepare("SELECT COUNT(*) c FROM bot_users").get().c,
      users_monthly: db.prepare("SELECT COUNT(DISTINCT tg_user_id||'-'||bot_id) c FROM bot_users WHERE last_seen >= datetime('now','-30 days')").get().c,
      sellers: db.prepare("SELECT COUNT(*) c FROM sellers WHERE active=1").get().c,
      topups_pending: db.prepare("SELECT COUNT(*) c FROM topups WHERE status='pending'").get().c,
      messages: db.prepare("SELECT COUNT(*) c FROM bot_messages").get().c,
    });
  }
  const myBotIds = db.prepare("SELECT id FROM bots WHERE owner_seller_id=?").all(req.user.id).map(r => r.id);
  const ph = myBotIds.length ? `(${myBotIds.map(() => "?").join(",")})` : "(0)";
  return res.json({
    bots: myBotIds.length,
    balance: db.prepare("SELECT balance FROM sellers WHERE id=?").get(req.user.id)?.balance || 0,
    users: myBotIds.length ? db.prepare(`SELECT COUNT(*) c FROM bot_users WHERE bot_id IN ${ph}`).get(...myBotIds).c : 0,
    users_monthly: myBotIds.length ? db.prepare(`SELECT COUNT(*) c FROM bot_users WHERE bot_id IN ${ph} AND last_seen >= datetime('now','-30 days')`).get(...myBotIds).c : 0,
    topups_pending: db.prepare("SELECT COUNT(*) c FROM topups WHERE seller_id=? AND status='pending'").get(req.user.id).c,
  });
});

// ---------- 404 ----------
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 TGBot Platform v2.1 — http://localhost:${CONFIG.PORT}`);
  console.log(`🔑 Admin: ${CONFIG.ADMIN_USERNAME} / ${CONFIG.ADMIN_PASSWORD}`);
  console.log(`🔐 License required: ${CONFIG.LICENSE_REQUIRED ? "YES (" + (CONFIG.LICENSE_VERIFY_URL || "no url") + ")" : "NO"}`);
  if (!process.env.JWT_SECRET) console.log("⚠️  JWT_SECRET random — set env để session ổn định.");
  if (!process.env.ADMIN_PASSWORD) console.log("⚠️  Đang dùng password mặc định — đổi ADMIN_PASSWORD trên production.\n");
});
