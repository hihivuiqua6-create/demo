// TGBot Platform — Multi-bot Telegram Mini App
// v2.0 — Sellers, Topup, Bank Settings, License-key verify, Strict JWT auth
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
  LICENSE_VERIFY_URL: process.env.LICENSE_VERIFY_URL || "https://bucac.onrender.com/api/verify-key",
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
  button_label TEXT DEFAULT '🛒 Mở Shop (Mini App)',
  owner_seller_id INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bot_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  username TEXT, first_name TEXT, last_name TEXT,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, tg_user_id)
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
  status TEXT DEFAULT 'pending', -- pending | approved | rejected
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const getSetting = (k, d = "") => {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

// defaults
if (!getSetting("bank_name")) setSetting("bank_name", "");
if (!getSetting("bank_account", null)) setSetting("bank_account", "");
if (!getSetting("bank_owner", null)) setSetting("bank_owner", "");
if (!getSetting("bank_qr_url", null)) setSetting("bank_qr_url", "");
if (!getSetting("topup_prefix", null)) setSetting("topup_prefix", "NAP");

// ---------- UTILS ----------
const DEFAULT_WELCOME = `🎉 <b>Chào mừng {full_name}!</b>

🤖 <b>HỆ THỐNG DỊCH VỤ TỰ ĐỘNG</b>
✨ Bấm nút bên dưới để mở Shop Mini App.

— powered by Auzastore`;

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderWelcome(tpl, user = {}) {
  const first = escapeHtml(user.first_name || "");
  const last = escapeHtml(user.last_name || "");
  const uname = escapeHtml(user.username || "");
  const full = (first + " " + last).trim() || uname || "bạn";
  return (tpl || DEFAULT_WELCOME)
    .replace(/\{first_name\}/g, first)
    .replace(/\{last_name\}/g, last)
    .replace(/\{username\}/g, uname)
    .replace(/\{full_name\}/g, full)
    .replace(/\{name\}/g, full);
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

// ---------- LICENSE KEY CHECK ----------
async function verifyLicenseKey(key) {
  if (!key) return { ok: false, msg: "Thiếu license key" };
  try {
    const res = await fetch(CONFIG.LICENSE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, device_id: CONFIG.DEVICE_ID }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) return { ok: false, msg: `Server license trả ${res.status}: ${text.slice(0, 200)}` };
    if (data && data.success === true) return { ok: true };
    return { ok: false, msg: data?.message || "Key không hợp lệ" };
  } catch (e) {
    return { ok: false, msg: "Không kết nối được server license: " + e.message };
  }
}

// ---------- BOT REGISTRY ----------
const liveBots = new Map(); // bot_id -> TelegramBot

function startBot(row) {
  if (liveBots.has(row.id)) return;
  try {
    const tg = new TelegramBot(row.token, { polling: true });
    tg.on("polling_error", (e) => console.error(`[bot ${row.id}] polling`, e.code || e.message));
    tg.onText(/\/start/, async (msg) => {
      const u = msg.from || {};
      try {
        db.prepare(
          `INSERT INTO bot_users(bot_id,tg_user_id,username,first_name,last_name,last_seen)
           VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(bot_id,tg_user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,last_seen=CURRENT_TIMESTAMP`
        ).run(row.id, u.id, u.username || null, u.first_name || null, u.last_name || null);
      } catch (e) { console.error("save user", e.message); }
      const text = renderWelcome(row.welcome, u);
      await tg.sendMessage(msg.chat.id, text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: row.button_label || "🛒 Mở Shop (Mini App)", web_app: { url: row.web_url } }]],
        },
      });
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

// rate limits
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// ---------- AUTH MIDDLEWARES ----------
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

// ---------- STATIC (PROTECTED) ----------
// Block direct access to admin.html / seller.html — must go through gated routes
app.get("/", (_req, res) => res.redirect("/login"));
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "login.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));
app.get("/seller", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "seller.html")));

// uploads (public read)
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
  // try seller
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

// ---------- ADMIN: SELLERS ----------
app.get("/api/admin/sellers", adminOnly, (_req, res) => {
  res.json(db.prepare("SELECT id,username,display_name,balance,active,created_at FROM sellers ORDER BY id DESC").all());
});
app.post("/api/admin/sellers", adminOnly, (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu username/password" });
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: "Username không hợp lệ" });
  if (password.length < 6) return res.status(400).json({ error: "Password tối thiểu 6 ký tự" });
  try {
    const info = db
      .prepare("INSERT INTO sellers(username,password_hash,display_name) VALUES(?,?,?)")
      .run(username, hashPassword(password), display_name || username);
    res.json({ id: info.lastInsertRowid, username });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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

// ---------- ADMIN: BANK SETTINGS ----------
app.get("/api/bank", anyAuth, (_req, res) => {
  res.json({
    bank_name: getSetting("bank_name"),
    bank_account: getSetting("bank_account"),
    bank_owner: getSetting("bank_owner"),
    bank_qr_url: getSetting("bank_qr_url"),
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

// QR upload (base64 PNG/JPG data URL)
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
    id: info.lastInsertRowid,
    amount,
    transfer_code: code,
    bank: {
      bank_name: getSetting("bank_name"),
      bank_account: getSetting("bank_account"),
      bank_owner: getSetting("bank_owner"),
      bank_qr_url: getSetting("bank_qr_url"),
    },
  });
});
app.get("/api/seller/topups", sellerOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM topups WHERE seller_id=? ORDER BY id DESC LIMIT 100").all(req.user.id));
});
app.get("/api/admin/topups", adminOnly, (_req, res) => {
  res.json(
    db.prepare(`
      SELECT t.*, s.username AS seller_username, s.display_name AS seller_display_name
      FROM topups t LEFT JOIN sellers s ON s.id=t.seller_id
      ORDER BY t.id DESC LIMIT 500
    `).all()
  );
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
// Create bot (admin or seller) — REQUIRES license key verified by external server
app.post("/api/bots", anyAuth, async (req, res) => {
  const { token, web_url, welcome, button_label, license_key } = req.body || {};
  if (!token || !web_url) return res.status(400).json({ error: "Thiếu token / web_url" });
  if (!/^https:\/\//i.test(web_url)) return res.status(400).json({ error: "web_url phải là HTTPS" });
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return res.status(400).json({ error: "Bot token không đúng định dạng" });

  const lic = await verifyLicenseKey(license_key);
  if (!lic.ok) return res.status(403).json({ error: "License key không hợp lệ: " + lic.msg });

  try {
    const owner = req.user.role === "seller" ? req.user.id : null;
    const info = db
      .prepare("INSERT INTO bots(token,web_url,welcome,button_label,owner_seller_id) VALUES(?,?,?,?,?)")
      .run(token, web_url, welcome || null, button_label || "🛒 Mở Shop (Mini App)", owner);
    const row = db.prepare("SELECT * FROM bots WHERE id=?").get(info.lastInsertRowid);
    startBot(row);
    res.json({ id: row.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/bots", anyAuth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT id,web_url,button_label,active,owner_seller_id,created_at FROM bots ORDER BY id DESC").all()
    : db.prepare("SELECT id,web_url,button_label,active,created_at FROM bots WHERE owner_seller_id=? ORDER BY id DESC").all(req.user.id);
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
    if (active) startBot(db.prepare("SELECT * FROM bots WHERE id=?").get(id));
    else await stopBot(id);
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
  res.json({ ok: true });
});

// ---------- STATS ----------
app.get("/api/stats", anyAuth, (req, res) => {
  if (req.user.role === "admin") {
    return res.json({
      bots: db.prepare("SELECT COUNT(*) c FROM bots").get().c,
      bots_active: db.prepare("SELECT COUNT(*) c FROM bots WHERE active=1").get().c,
      users: db.prepare("SELECT COUNT(*) c FROM bot_users").get().c,
      sellers: db.prepare("SELECT COUNT(*) c FROM sellers WHERE active=1").get().c,
      topups_pending: db.prepare("SELECT COUNT(*) c FROM topups WHERE status='pending'").get().c,
    });
  }
  return res.json({
    bots: db.prepare("SELECT COUNT(*) c FROM bots WHERE owner_seller_id=?").get(req.user.id).c,
    balance: db.prepare("SELECT balance FROM sellers WHERE id=?").get(req.user.id)?.balance || 0,
    topups_pending: db.prepare("SELECT COUNT(*) c FROM topups WHERE seller_id=? AND status='pending'").get(req.user.id).c,
  });
});

// ---------- 404 ----------
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 TGBot Platform v2 — http://localhost:${CONFIG.PORT}`);
  console.log(`🔑 Admin: ${CONFIG.ADMIN_USERNAME} / ${CONFIG.ADMIN_PASSWORD}`);
  console.log(`🆔 Device ID: ${CONFIG.DEVICE_ID}`);
  console.log(`🔐 License check URL: ${CONFIG.LICENSE_VERIFY_URL}`);
  if (!process.env.JWT_SECRET) console.log("⚠️  JWT_SECRET random — set env để session ổn định.");
  if (!process.env.ADMIN_PASSWORD) console.log("⚠️  Đang dùng password mặc định — set ADMIN_PASSWORD trên production.\n");
});
