// TGBot Platform v4.1
// ✨ Mới so với v3.1:
//   • Tách bot auto-reply riêng (autoreply_token) khỏi bot mini-app
//   • License key bắt buộc: bot chỉ chạy khi key được server xác thực (license_valid=1)
//   • Lệnh /autorep <nội dung> | <số lượng>  (chỉ controller_tg_id được dùng)
//   • Tạo seller có thể gán ngay bot quản lý (assign_bot_id)
//   • Upload ZIP web: chấp nhận index.html HOẶC index.php, file PHP serve dạng tĩnh (cảnh báo)
//   • Upload nhiều file/folder (giữ cấu trúc) qua endpoint /api/bots/:id/site-folder
//   • Override URL công khai cho từng bot (public_url_override) → fix nút Mini App khi dùng ZIP
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const AdmZip = require("adm-zip");
const Database = require("better-sqlite3");
const TelegramBot = require("node-telegram-bot-api");

// ---------- CONFIG ----------
const ROOT = path.join(__dirname, "..");
const CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(48).toString("hex"),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123456",
  DB_PATH: process.env.DB_PATH || path.join(ROOT, "database", "tgbot.db"),
  UPLOAD_DIR: path.join(ROOT, "public", "uploads"),
  SITES_DIR: path.join(ROOT, "sites"),
  ZIP_MAX_MB: Number(process.env.ZIP_MAX_MB) || 50,
  // License server: nếu set, gọi HTTP để xác thực key. Nếu trống, validate cục bộ
  // bằng HMAC(LICENSE_SECRET, bot_token) === license_key.
  LICENSE_SERVER_URL: process.env.LICENSE_SERVER_URL || "",
  LICENSE_SECRET: process.env.LICENSE_SECRET || "tgbot-platform-license",
};

fs.mkdirSync(path.dirname(CONFIG.DB_PATH), { recursive: true });
fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CONFIG.SITES_DIR, { recursive: true });

// ---------- DB ----------
const db = new Database(CONFIG.DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  web_url TEXT NOT NULL,
  web_mode TEXT DEFAULT 'url',
  web_zip_dir TEXT,
  welcome TEXT,
  button_label TEXT DEFAULT 'Mở Shop (Mini App)',
  auto_reply_enabled INTEGER DEFAULT 0,
  auto_reply_text TEXT,
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
  direction TEXT NOT NULL,
  text TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_msg_bot_user ON bot_messages(bot_id, tg_user_id, id);
CREATE INDEX IF NOT EXISTS idx_users_last ON bot_users(bot_id, last_seen);
CREATE TABLE IF NOT EXISTS bot_autoreply_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  tg_user_id INTEGER NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bot_id, tg_user_id)
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_role TEXT NOT NULL, sender_id INTEGER,
  bot_id INTEGER,
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
  expires_at TEXT,
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

// migrations (an toàn, có thể chạy lại nhiều lần)
const safeAlter = (sql) => { try { db.exec(sql); } catch {} };
safeAlter("ALTER TABLE bots ADD COLUMN web_mode TEXT DEFAULT 'url'");
safeAlter("ALTER TABLE bots ADD COLUMN web_zip_dir TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN auto_reply_enabled INTEGER DEFAULT 0");
safeAlter("ALTER TABLE bots ADD COLUMN auto_reply_text TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN bot_username TEXT");
safeAlter("ALTER TABLE sellers ADD COLUMN expires_at TEXT");
// v4
safeAlter("ALTER TABLE bots ADD COLUMN autoreply_token TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN autoreply_bot_username TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN autoreply_count INTEGER DEFAULT 1");
safeAlter("ALTER TABLE bots ADD COLUMN controller_tg_id INTEGER");
safeAlter("ALTER TABLE bots ADD COLUMN license_key TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN license_valid INTEGER DEFAULT 0");
safeAlter("ALTER TABLE bots ADD COLUMN license_checked_at TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN public_url_override TEXT");
safeAlter("ALTER TABLE bots ADD COLUMN web_kind TEXT DEFAULT 'html'"); // html | php
safeAlter("ALTER TABLE bots ADD COLUMN site_slug TEXT"); // custom path: /bot1, /shop-a...
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_site_slug ON bots(site_slug) WHERE site_slug IS NOT NULL AND site_slug != ''"); } catch {}

// ----- v4.1: AUTO-RẢI bots (lệnh /autoraitinnhan, /channel, /list ...) + seller managed bot list -----
db.exec(`
CREATE TABLE IF NOT EXISTS autorai_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  bot_username TEXT,
  license_key TEXT,
  license_valid INTEGER DEFAULT 0,
  controller_tg_id INTEGER,
  contents TEXT DEFAULT '[]',
  channels TEXT DEFAULT '[]',
  delay_seconds INTEGER DEFAULT 300,
  list_delay_seconds INTEGER DEFAULT 30,
  running INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  owner_seller_id INTEGER,
  last_round_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS seller_managed_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  bot_username TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(seller_id, bot_username)
);
`);

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

const DEFAULT_AUTOREPLY = `🤖 Cảm ơn bạn đã nhắn tin!`;

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function countMonthlyUsers(botId) {
  const r = db.prepare(
    "SELECT COUNT(DISTINCT tg_user_id) c FROM bot_users WHERE bot_id=? AND last_seen >= datetime('now','-30 days')"
  ).get(botId);
  return r?.c || 0;
}

function renderTpl(tpl, user = {}, botId = 0, fallback = "") {
  const first = escapeHtml(user.first_name || "");
  const last = escapeHtml(user.last_name || "");
  const uname = escapeHtml(user.username || "");
  const full = (first + " " + last).trim() || uname || "bạn";
  const monthly = countMonthlyUsers(botId);
  return (tpl || fallback)
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
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

function findPhpBin(){
  const candidates=[process.env.PHP_BIN,'php','php8','php-cli'].filter(Boolean);
  for(const c of candidates){
    try{
      const r=spawnSync(c,['-v'],{stdio:'ignore'});
      if(r.status===0) return c;
    }catch{}
  }
  return null;
}
const PHP_BIN = findPhpBin();
function parsePhpOutput(buf){
  const text=buf.toString('utf8');
  const sep=text.indexOf("\r\n\r\n")>=0?"\r\n\r\n":(text.indexOf("\n\n")>=0?"\n\n":null);
  if(!sep) return {headers:{}, body:buf};
  const head=text.slice(0,text.indexOf(sep));
  if(!/^Status:|^Content-Type:|^Set-Cookie:/im.test(head)) return {headers:{}, body:buf};
  const bodyText=text.slice(text.indexOf(sep)+sep.length);
  const headers={}; let status=null;
  for(const line of head.split(/\r?\n/)){
    const m=line.match(/^([^:]+):\s*(.*)$/); if(!m) continue;
    const k=m[1].toLowerCase(), v=m[2];
    if(k==='status'){ const sm=v.match(/(\d{3})/); if(sm) status=Number(sm[1]); }
    else headers[k]=v;
  }
  return {headers, body:Buffer.from(bodyText,'utf8'), status};
}


function tryReadJsonFile(file, fallback){
  try { const x = JSON.parse(fs.readFileSync(file, 'utf8')); return x; } catch { return fallback; }
}
function renderPhpFallbackMiniApp(root, req, res){
  const dataDir = path.join(root, 'data');
  const settings = tryReadJsonFile(path.join(dataDir, 'settings.json'), {});
  const categories = tryReadJsonFile(path.join(dataDir, 'categories.json'), []);
  const products = tryReadJsonFile(path.join(dataDir, 'products.json'), []);
  const deposits = tryReadJsonFile(path.join(dataDir, 'deposits.json'), []);
  const users = tryReadJsonFile(path.join(dataDir, 'users.json'), []);
  const title = escapeHtml(settings.site || settings.title || settings.shop_name || 'Mini App Shop');
  const logo = escapeHtml(settings.shop_logo || settings.logo || '');
  const avatar = escapeHtml(settings.user_avatar_image || 'uploads/user_avatar_gamer.png');
  const bankMin = Number(settings.deposit_min_amount || 2000).toLocaleString('vi-VN');
  const catHtml = (Array.isArray(categories)?categories:[]).slice(0,30).map((c,i)=>{
    const name = escapeHtml(c.name || c.title || c.category || ('Danh mục '+(i+1)));
    return `<button class="pick" data-cat="${escapeHtml(c.id||c.slug||name)}"><span class="ico">🎮</span><b>${name}</b><span>›</span></button>`;
  }).join('') || `<div class="empty">Chưa có danh mục.</div>`;
  const keyProducts = (Array.isArray(products)?products:[]).slice(0,24).map((p,i)=>{
    const name = escapeHtml(p.name || p.title || 'Gói dịch vụ');
    const price = Number(p.price || p.amount || 0).toLocaleString('vi-VN') + 'đ';
    return `<button class="plan"><span>📦</span><b>${name}</b><em>${price}</em></button>`;
  }).join('') || `<div class="empty">Danh sách trống</div>`;
  const topUsers = (Array.isArray(users)?users:[]).sort((a,b)=>(Number(b.total_deposit||b.total_topup||b.balance||0)-Number(a.total_deposit||a.total_topup||a.balance||0))).slice(0,5).map((u,i)=>{
    const name = escapeHtml(u.name || u.username || ('User '+(i+1)));
    const money = Number(u.total_deposit || u.total_topup || u.balance || 0).toLocaleString('vi-VN') + 'đ';
    return `<div class="rank r${i+1}"><span class="medal">${i+1}</span><b>${name}</b><em>${money}</em></div>`;
  }).join('') || `<div class="empty">Chưa có xếp hạng.</div>`;
  res.type('html').send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<style>
:root{--bg:#080b17;--card:rgba(24,28,49,.82);--line:rgba(255,255,255,.12);--txt:#f7f7ff;--mut:#9aa1bd;--pri:#6d63ff;--pri2:#19d3a2;--gold:#ffd338}*{box-sizing:border-box}html,body{margin:0;background:#050713;color:var(--txt);font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;overflow-x:hidden}body:before{content:"";position:fixed;inset:0;background:radial-gradient(circle at 10% 15%,rgba(25,211,162,.22),transparent 30%),radial-gradient(circle at 85% 5%,rgba(109,99,255,.30),transparent 34%),radial-gradient(circle at 75% 85%,rgba(156,85,255,.22),transparent 35%),#070916;z-index:-2}.app{max-width:980px;margin:auto;min-height:100vh;padding:env(safe-area-inset-top) 14px calc(96px + env(safe-area-inset-bottom))}.hero{position:sticky;top:0;z-index:5;margin:0 -14px 18px;padding:18px 18px 16px;background:rgba(14,17,35,.76);backdrop-filter:blur(18px);border-bottom:1px solid var(--line)}.top{display:flex;align-items:center;gap:12px}.avatar{width:62px;height:62px;border-radius:24px;object-fit:cover;background:linear-gradient(135deg,#22d3ee,#7c5cff)}.name{font-size:24px;font-weight:900;line-height:1}.uid{font-size:15px;color:var(--mut);margin-top:5px}.bal{margin-left:auto;font-size:23px;font-weight:900;color:#756dff}.lang{display:flex;gap:10px;margin-top:14px}.pill{padding:9px 18px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.06);font-weight:800}.pill.on{border-color:#7468ff;box-shadow:0 0 22px rgba(116,104,255,.38)}.page{display:none;animation:pageIn .34s cubic-bezier(.2,.8,.2,1)}.page.active{display:block}@keyframes pageIn{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}.head{display:flex;align-items:center;gap:16px;margin:26px 4px 14px}.head .hi{width:64px;height:64px;border-radius:22px;display:grid;place-items:center;background:rgba(255,255,255,.08);border:1px solid var(--line);font-size:28px}.head h1{font-size:30px;margin:0}.head p{margin:4px 0 0;color:var(--mut);font-size:17px}.card{border:1px solid var(--line);background:linear-gradient(145deg,rgba(30,35,62,.86),rgba(17,21,39,.74));border-radius:28px;padding:22px;margin:16px 0;box-shadow:0 20px 55px rgba(0,0,0,.23)}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.stat{padding:22px 12px;border-radius:20px;text-align:center;background:rgba(255,255,255,.055);border:1px solid var(--line)}.stat b{display:block;font-size:24px;margin:8px 0}.stat span,.empty{color:var(--mut)}.sectionTitle{font-size:21px;letter-spacing:.12em;color:#dce0f4;font-weight:900;margin:4px 0 18px}.pick,.plan,.input,.btn{width:100%;border:1px solid var(--line);border-radius:24px;background:rgba(255,255,255,.055);color:var(--txt);padding:18px;display:flex;align-items:center;gap:18px;font:inherit;text-align:left;transition:.22s ease}.pick:active,.plan:active,.btn:active{transform:scale(.985)}.pick b,.plan b{font-size:21px}.pick span:last-child{margin-left:auto;font-size:34px;color:#8b93ad}.ico{width:56px;height:56px;border-radius:18px;display:grid;place-items:center;background:rgba(25,211,162,.13);box-shadow:inset 0 0 0 1px rgba(25,211,162,.18)}.plans{display:grid;gap:12px}.plan em{margin-left:auto;color:#20d79f;font-style:normal;font-weight:900}.qty{display:flex;align-items:center;justify-content:space-between}.step{display:flex;gap:12px;align-items:center}.step button{width:56px;height:56px;border:0;border-radius:18px;background:rgba(255,255,255,.12);color:white;font-size:28px}.buy{justify-content:center;background:linear-gradient(135deg,#121426,#0b0c18);font-weight:900;font-size:21px;opacity:.88}.deposit{border-color:rgba(255,205,40,.38);box-shadow:0 0 30px rgba(255,193,7,.07)}.deposit h2{color:var(--gold)}.input{font-size:19px}.orange{justify-content:center;background:linear-gradient(135deg,#ffd000,#ec7600);color:white;border:0;font-weight:900}.rank{display:grid;grid-template-columns:48px 1fr auto;gap:14px;align-items:center;padding:16px;border:1px solid var(--line);border-radius:22px;margin:10px 0;background:rgba(255,255,255,.05)}.medal{height:48px;width:48px;border-radius:999px;display:grid;place-items:center;background:#6d63ff;font-weight:900}.r1{border-color:rgba(255,211,56,.55)}.r1 .medal{background:#ffd338;color:#7a4200}.rank em{color:#20d79f;font-style:normal;font-weight:900}.tabs{position:fixed;left:50%;bottom:0;transform:translateX(-50%);width:min(980px,100%);padding:10px 10px calc(10px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(5,1fr);gap:6px;background:rgba(13,17,35,.86);backdrop-filter:blur(18px);border:1px solid var(--line);border-bottom:0;border-radius:24px 24px 0 0;z-index:20}.tab{border:0;background:transparent;color:#8d96b4;font-weight:800;font-size:13px;padding:10px 2px;border-radius:18px;transition:.2s}.tab i{display:block;font-style:normal;font-size:25px;margin-bottom:4px}.tab.active{color:#6f66ff;text-shadow:0 0 22px rgba(111,102,255,.8);background:rgba(109,99,255,.10)}@media(min-width:800px){.app{padding-left:28px;padding-right:28px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:18px}.head h1{font-size:36px}.tab{font-size:15px}.tabs{bottom:18px;border-radius:26px;border-bottom:1px solid var(--line)}}
</style></head><body><main class="app"><section class="hero"><div class="top"><img class="avatar" src="${avatar}" onerror="this.style.display='none'"><div><div class="name">🌸 ${title}</div><div class="uid">ID: 8030294480</div></div><div class="bal">0đ</div></div><div class="lang"><span class="pill on">🇻🇳 VI</span><span class="pill">🇬🇧 EN</span><span class="pill">CUSTOMER</span></div></section>
<section class="page active" id="key"><div class="head"><div class="hi">🔑</div><div><h1>Mua Key Game/Tool</h1><p>Hệ thống tự động cấp Key</p></div></div><div class="card"><div class="sectionTitle">CHỌN ỨNG DỤNG</div>${catHtml}<div class="sectionTitle" style="margin-top:24px">CHỌN GÓI</div><div class="plans">${keyProducts}</div><div class="card qty"><b>📚 SỐ LƯỢNG</b><div class="step"><button>-</button><b>1</b><button>+</button></div></div><button class="btn buy">Mua ngay<br><small>CHỌN GÓI</small></button></div></section>
<section class="page" id="acc"><div class="head"><div class="hi">👥</div><div><h1>Mua Tài Khoản</h1><p>Mua Account uy tín, chất lượng</p></div></div><div class="card"><div class="sectionTitle">CHỌN DỊCH VỤ / GAME</div>${catHtml}<div class="sectionTitle" style="margin-top:24px">CHỌN LOẠI ACCOUNT</div><div class="empty card">Danh sách trống</div></div></section>
<section class="page" id="nap"><div class="card deposit"><h2>👑 Nạp Tiền Tự Động 24/7</h2><p>Giao dịch được xử lý tự động trong vài giây.</p><input class="input" placeholder="💵 Nhập số tiền (Tối thiểu ${bankMin}đ)"><button class="btn orange">▦ TẠO MÃ QR NẠP TIỀN</button></div><div class="card"><h2>↻ Lịch Sử Nạp Của Bạn</h2><div class="empty">Chưa có giao dịch nạp.</div></div></section>
<section class="page" id="top"><div class="head"><div class="hi">🏆</div><div><h1>Bảng Xếp Hạng</h1><p>Top người dùng nạp nhiều nhất</p></div></div><div class="card">${topUsers}</div></section>
<section class="page" id="me"><div class="card"><h2>▣ Tổng Quan Tài Khoản</h2><div class="grid3"><div class="stat">🔑<b>0</b><span>SP ĐÃ MUA</span></div><div class="stat">🛒<b>0đ</b><span>TỔNG CHI</span></div><div class="stat">💳<b>0đ</b><span>TỔNG NẠP</span></div></div></div><div class="card"><h2>👥 Hệ Thống Giới Thiệu (Ref)</h2><p class="empty">Nhận ngay 0% hoa hồng khi người được bạn mời nạp tiền thành công.</p><input class="input" value="https://t.me/yourbot?start=80302" readonly><button class="btn" style="justify-content:center;background:linear-gradient(135deg,#7066ff,#a855f7);font-weight:900">Copy Link Giới Thiệu</button></div></section>
</main><nav class="tabs"><button class="tab active" data-page="key"><i>🔑</i>Mua Key</button><button class="tab" data-page="acc"><i>👥</i>Mua Acc</button><button class="tab" data-page="nap"><i>💳</i>Nạp Tiền</button><button class="tab" data-page="top"><i>🏆</i>Top Nạp</button><button class="tab" data-page="me"><i>👤</i>Cá Nhân</button></nav><script>window.Telegram&&Telegram.WebApp&&Telegram.WebApp.ready();document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById(b.dataset.page).classList.add('active');scrollTo({top:0,behavior:'smooth'});});</script></body></html>`);
}

// ---------- LICENSE ----------
function expectedLicenseFor(token) {
  return crypto.createHmac("sha256", CONFIG.LICENSE_SECRET).update(String(token)).digest("hex").slice(0, 32).toUpperCase();
}
async function verifyLicense(bot) {
  if (!bot.license_key) return false;
  // Mode 1: remote license server
  if (CONFIG.LICENSE_SERVER_URL) {
    try {
      const r = await fetch(CONFIG.LICENSE_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_id: bot.id, token: bot.token, key: bot.license_key }),
      });
      if (!r.ok) return false;
      const j = await r.json().catch(() => ({}));
      return !!j.valid;
    } catch (e) {
      console.error("[license remote]", e.message);
      return false;
    }
  }
  // Mode 2: local HMAC
  return safeEqual(String(bot.license_key).toUpperCase(), expectedLicenseFor(bot.token));
}
async function refreshLicense(botId) {
  const row = db.prepare("SELECT * FROM bots WHERE id=?").get(botId);
  if (!row) return false;
  const ok = await verifyLicense(row);
  db.prepare("UPDATE bots SET license_valid=?, license_checked_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(ok ? 1 : 0, botId);
  return ok;
}


// ---------- PUBLIC SITE URL / SLUG ----------
const RESERVED_SITE_SLUGS = new Set([
  "", "admin", "seller", "login", "api", "uploads", "app.css", "site", "healthz", "favicon.ico"
]);
function normalizeSiteSlug(v, fallbackId = null) {
  let s = String(v || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/+|\/+$/g, "");
  s = s.split(/[?#]/)[0].split("/")[0];
  s = s.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s && fallbackId) s = `bot${fallbackId}`;
  if (RESERVED_SITE_SLUGS.has(s)) s = fallbackId ? `bot${fallbackId}` : "";
  return s;
}
function requestPublicBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}`.replace(/\/$/, "") : "";
}
function publicBaseFor(row) {
  return (row.public_url_override || CONFIG.PUBLIC_BASE_URL || `http://localhost:${CONFIG.PORT}`).replace(/\/$/, "");
}
function ensureSiteSlug(id, preferred = "") {
  let slug = normalizeSiteSlug(preferred, id);
  let i = 2;
  while (true) {
    const old = db.prepare("SELECT id FROM bots WHERE site_slug=? AND id<>?").get(slug, id);
    if (!old) break;
    slug = normalizeSiteSlug(`${preferred || 'bot'+id}-${i}`, id);
    i++;
  }
  db.prepare("UPDATE bots SET site_slug=? WHERE id=?").run(slug, id);
  return slug;
}
function botSitePath(row) {
  return normalizeSiteSlug(row.site_slug, row.id) || `site/${row.id}`;
}

// ---------- LOGGING ----------
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
// liveBots maps bot_id → { main: TelegramBot, autoreply: TelegramBot | null }
const liveBots = new Map();

function botEffectiveWebUrl(row) {
  if (row.web_mode === "zip" && row.web_zip_dir) {
    const base = publicBaseFor(row);
    const slug = botSitePath(row);
    return `${base}/${slug}/`;
  }
  return row.web_url;
}


function writeDefaultMiniApp(botId) {
  const dirName = `bot-${botId}`;
  const dest = path.join(CONFIG.SITES_DIR, dirName);
  fs.mkdirSync(dest, { recursive: true });
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TGBot Mini App</title><style>body{margin:0;min-height:100vh;font-family:Inter,system-ui,Arial;background:#070815;color:#eef0ff;display:grid;place-items:center}.card{width:min(92vw,520px);padding:28px;border:1px solid rgba(255,255,255,.12);border-radius:22px;background:linear-gradient(135deg,rgba(124,92,255,.18),rgba(34,211,238,.10));box-shadow:0 20px 70px rgba(0,0,0,.45)}h1{margin:0 0 10px;font-size:28px}p{color:#b9bdde;line-height:1.6}.btn{display:inline-block;margin-top:14px;padding:12px 16px;border-radius:12px;background:linear-gradient(135deg,#7c5cff,#22d3ee);color:white;text-decoration:none;font-weight:700}</style></head><body><main class="card"><h1>Mini App đang chạy</h1><p>Web này được server tự host bằng <b>index.html</b>. Upload ZIP/Folder trong Admin để thay giao diện riêng.</p><a class="btn" href="/admin">Về Admin</a></main><script>window.Telegram&&Telegram.WebApp&&Telegram.WebApp.ready();</script></body></html>`;
  fs.writeFileSync(path.join(dest, "index.html"), html);
  const slug = ensureSiteSlug(botId);
  db.prepare("UPDATE bots SET web_mode='zip', web_zip_dir=?, web_kind='html', site_slug=? WHERE id=?").run(dirName, slug, botId);
}

function buildMiniAppMarkup(label, url) {
  if (!/^https:\/\//i.test(url)) return null;
  return { inline_keyboard: [[{ text: "🛒 " + label, web_app: { url } }]] };
}

async function startBot(row) {
  if (liveBots.has(row.id)) return;

  // License gate
  const ok = await refreshLicense(row.id);
  if (!ok) {
    console.log(`🔒 Bot #${row.id} KHÔNG khởi động: license không hợp lệ.`);
    return;
  }

  const fresh = db.prepare("SELECT * FROM bots WHERE id=?").get(row.id);
  const entry = { main: null, autoreply: null };

  // ----- Main bot (mini-app, /start) -----
  try {
    const main = new TelegramBot(fresh.token, { polling: true });
    const webUrl = botEffectiveWebUrl(fresh);

    try {
      const me = await main.getMe();
      if (me?.username) db.prepare("UPDATE bots SET bot_username=? WHERE id=?").run(me.username, fresh.id);
    } catch (e) { console.error("[getMe main]", e.message); }

    try {
      if (/^https:\/\//i.test(webUrl)) {
        await main.setChatMenuButton({
          menu_button: { type: "web_app", text: fresh.button_label || "Mở Shop", web_app: { url: webUrl } },
        });
      } else {
        console.warn(`[bot #${fresh.id}] web URL không HTTPS (${webUrl}) → bỏ qua menu Mini App. Hãy set PUBLIC_BASE_URL hoặc public_url_override (https://...)`);
      }
    } catch (e) { console.error("[setMenuButton]", e.message); }

    main.on("polling_error", async (e) => {
      const msg = e.code || e.message || "";
      console.error(`[bot ${fresh.id} main] polling`, msg);
      // Tự khôi phục khi 409 conflict / ETELEGRAM hoặc lỗi mạng — tránh "lúc dc lúc ko"
      if (/409|ETELEGRAM|ECONNRESET|ETIMEDOUT|EFATAL|socket hang up/i.test(String(msg))) {
        try { await main.stopPolling({ cancel: true }); } catch {}
        setTimeout(() => { try { main.startPolling({ restart: true }); } catch (er) { console.error("[restart polling]", er.message); } }, 4000);
      }
    });

    main.on("message", async (msg) => {
      if (!msg.from || msg.from.is_bot) return;
      try {
        upsertUser(fresh.id, msg);
        logMsg(fresh.id, msg.from.id, "in",
          msg.text || `[${msg.photo ? "photo" : msg.document ? "doc" : msg.sticker ? "sticker" : "media"}]`);
      } catch (e) { console.error("[log in main]", e.message); }
    });

    main.onText(/^\/start/, async (msg) => {
      const u = msg.from || {};
      const b = db.prepare("SELECT * FROM bots WHERE id=?").get(fresh.id);
      const text = renderTpl(b?.welcome, u, fresh.id, DEFAULT_WELCOME);
      const effUrl = botEffectiveWebUrl(b);
      const opts = { parse_mode: "HTML" };
      const mk = buildMiniAppMarkup(b.button_label || "Mở Shop (Mini App)", effUrl);
      if (mk) opts.reply_markup = mk;
      try {
        await main.sendMessage(msg.chat.id, text, opts);
        logMsg(fresh.id, u.id, "out", text);
      } catch (e) { console.error("[send start]", e.message); }
    });

    entry.main = main;
    console.log(`✅ Bot #${fresh.id} MAIN started`);
  } catch (e) {
    console.error(`❌ Bot #${fresh.id} MAIN fail:`, e.message);
  }

  // ----- Autoreply bot (riêng biệt nếu có autoreply_token; nếu không, dùng main) -----
  const arToken = fresh.autoreply_token && fresh.autoreply_token !== fresh.token ? fresh.autoreply_token : null;
  const arBot = arToken ? new TelegramBot(arToken, { polling: true }) : entry.main;

  if (arBot) {
    if (arToken) {
      try {
        const me = await arBot.getMe();
        if (me?.username) db.prepare("UPDATE bots SET autoreply_bot_username=? WHERE id=?").run(me.username, fresh.id);
      } catch (e) { console.error("[getMe ar]", e.message); }
      arBot.on("polling_error", async (e) => {
        const msg = e.code || e.message || "";
        console.error(`[bot ${fresh.id} ar] polling`, msg);
        if (/409|ETELEGRAM|ECONNRESET|ETIMEDOUT|EFATAL|socket hang up/i.test(String(msg))) {
          try { await arBot.stopPolling({ cancel: true }); } catch {}
          setTimeout(() => { try { arBot.startPolling({ restart: true }); } catch (er) { console.error("[restart ar polling]", er.message); } }, 4000);
        }
      });
    }

    arBot.on("message", async (msg) => {
      if (!msg.from || msg.from.is_bot) return;

      // Nếu autoreply bot là bot riêng, log dưới cùng bot_id để gom user
      if (arToken) {
        try {
          upsertUser(fresh.id, msg);
          logMsg(fresh.id, msg.from.id, "in", msg.text || "[media]");
        } catch {}
      }

      // /autorep <text> | <count>  (chỉ controller mới được dùng)
      const b = db.prepare("SELECT * FROM bots WHERE id=?").get(fresh.id);
      if (msg.text && /^\/autorep(\s|$)/i.test(msg.text)) {
        if (b.controller_tg_id && msg.from.id !== b.controller_tg_id) {
          try { await arBot.sendMessage(msg.chat.id, "⛔ Bạn không có quyền dùng /autorep."); } catch {}
          return;
        }
        const raw = msg.text.replace(/^\/autorep\s*/i, "");
        const [content, cntRaw] = raw.split("|").map(s => (s || "").trim());
        if (!content) {
          try { await arBot.sendMessage(msg.chat.id, "Cú pháp: <code>/autorep nội dung | số_lần</code>", { parse_mode: "HTML" }); } catch {}
          return;
        }
        const cnt = Math.max(1, Math.min(20, Number(cntRaw) || 1));
        db.prepare("UPDATE bots SET auto_reply_enabled=1, auto_reply_text=?, autoreply_count=? WHERE id=?")
          .run(content, cnt, fresh.id);
        try {
          await arBot.sendMessage(msg.chat.id,
            `✅ Đã bật auto-reply.\n📝 Nội dung: <code>${escapeHtml(content)}</code>\n🔁 Số lần / 1 tin nhắn user: <b>${cnt}</b>`,
            { parse_mode: "HTML" });
        } catch {}
        return;
      }
      if (msg.text && /^\/autorep_off\b/i.test(msg.text)) {
        if (b.controller_tg_id && msg.from.id !== b.controller_tg_id) return;
        db.prepare("UPDATE bots SET auto_reply_enabled=0 WHERE id=?").run(fresh.id);
        try { await arBot.sendMessage(msg.chat.id, "⏹ Đã TẮT auto-reply."); } catch {}
        return;
      }

      // Bỏ /start cho main bot xử lý
      if (msg.text && /^\/start\b/.test(msg.text) && !arToken) return;

      if (!b.auto_reply_enabled) return;
      // Bỏ qua chính controller
      if (b.controller_tg_id && msg.from.id === b.controller_tg_id) return;
      const isException = db.prepare("SELECT 1 FROM bot_autoreply_exceptions WHERE bot_id=? AND tg_user_id=?").get(fresh.id, msg.from.id);
      if (isException) return;

      const text = renderTpl(b.auto_reply_text, msg.from, fresh.id, DEFAULT_AUTOREPLY);
      const effUrl = botEffectiveWebUrl(b);
      const opts = { parse_mode: "HTML" };
      // Nếu autoreply là cùng bot main, gắn kèm nút Mini App; nếu là bot riêng thì không
      if (!arToken) {
        const mk = buildMiniAppMarkup(b.button_label || "Mở Shop", effUrl);
        if (mk) opts.reply_markup = mk;
      }
      const times = Math.max(1, Math.min(20, b.autoreply_count || 1));
      for (let i = 0; i < times; i++) {
        try {
          await arBot.sendMessage(msg.chat.id, text, opts);
          logMsg(fresh.id, msg.from.id, "out", `[auto ${i + 1}/${times}] ${text}`);
        } catch (e) { console.error("[autoreply send]", e.message); break; }
        if (times > 1) await new Promise(r => setTimeout(r, 400));
      }
    });

    if (arToken) {
      entry.autoreply = arBot;
      console.log(`✅ Bot #${fresh.id} AUTOREPLY (separate) started`);
    }
  }

  liveBots.set(fresh.id, entry);
}

async function stopBot(id) {
  const entry = liveBots.get(id);
  if (!entry) return;
  try { if (entry.main) await entry.main.stopPolling(); } catch {}
  try { if (entry.autoreply) await entry.autoreply.stopPolling(); } catch {}
  liveBots.delete(id);
  console.log(`⏹  Bot #${id} stopped`);
}
async function restartBot(id) {
  await stopBot(id);
  const fresh = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  if (fresh?.active) await startBot(fresh);
}

async function fullDeleteBot(id) {
  await stopBot(id);
  const row = db.prepare("SELECT web_zip_dir FROM bots WHERE id=?").get(id);
  if (row?.web_zip_dir) rmrf(path.join(CONFIG.SITES_DIR, row.web_zip_dir));
  db.prepare("DELETE FROM bot_messages WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM bot_users WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM bot_autoreply_exceptions WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM bots WHERE id=?").run(id);
}

// Khởi động lại các bot ở lượt boot
(async () => {
  for (const row of db.prepare("SELECT * FROM bots WHERE active=1").all()) {
    await startBot(row);
  }
})();

// ================================================================
// ====================== AUTO-RẢI BOT (v4.1) =====================
// Bot tách biệt, dùng LỆNH để rải nội dung tới list kênh/nhóm.
// Lệnh user dùng trong bot:
//   /start                       — hướng dẫn
//   /key <KEY>                   — xác thực key được cấp (1 lần / đổi controller)
//   /channel l1 | l2 | ...       — đặt list kênh (https://t.me/xxx hoặc @xxx hoặc id)
//   /autoraitinnhan <nội dung>   — đặt 1 nội dung rải
//   /list nd1 | nd2 | nd3        — đặt nhiều nội dung (xoay vòng)
//   /run                         — bắt đầu rải
//   /stop                        — dừng rải
//   /status                      — xem trạng thái
// Admin trên web có thể chỉnh delay (vòng) & list_delay (giữa các kênh / mục).
// ================================================================
const liveAutorai = new Map(); // id -> { bot, state }

function autoraiExpectedKey(token) {
  return crypto.createHmac("sha256", CONFIG.LICENSE_SECRET)
    .update("autorai:" + String(token)).digest("hex").slice(0, 24).toUpperCase();
}
function parseListPipe(raw) {
  return String(raw || "").split("|").map(s => s.trim()).filter(Boolean);
}
function extractChatTarget(link) {
  const s = String(link || "").trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = s.match(/(?:t\.me\/|telegram\.me\/|@)([A-Za-z0-9_]{3,})/i);
  if (m) return "@" + m[1];
  return null;
}

async function startAutoraiBot(row) {
  if (liveAutorai.has(row.id)) return;
  if (!row.active) return;
  try {
    const bot = new TelegramBot(row.token, { polling: true });
    try {
      const me = await bot.getMe();
      if (me?.username) db.prepare("UPDATE autorai_bots SET bot_username=? WHERE id=?").run(me.username, row.id);
    } catch (e) { console.error("[autorai getMe]", e.message); }

    bot.on("polling_error", (e) => console.error(`[autorai #${row.id}] polling`, e.code || e.message));

    bot.onText(/^\/start\b/, async (msg) => {
      const text =
        "🤖 <b>AUTO-RẢI BOT</b>\n━━━━━━━━━━━━━━━━━━━\n" +
        "Bước 1 · <code>/key &lt;KEY&gt;</code> — xác thực key được cấp\n" +
        "Bước 2 · <code>/channel link1 | link2 | ...</code> — list kênh/nhóm\n" +
        "Bước 3a · <code>/autoraitinnhan nội_dung</code> — đặt 1 nội dung\n" +
        "Bước 3b · <code>/list nd1 | nd2 | nd3</code> — nhiều nội dung (xoay vòng)\n" +
        "Bước 4 · <code>/run</code> bắt đầu  ·  <code>/stop</code> dừng  ·  <code>/status</code> xem trạng thái";
      try { await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" }); } catch {}
    });

    bot.on("message", async (msg) => {
      if (!msg.text || !msg.from || msg.from.is_bot) return;
      const text = msg.text.trim();
      const cur = db.prepare("SELECT * FROM autorai_bots WHERE id=?").get(row.id);
      if (!cur) return;

      // /key
      const mKey = text.match(/^\/key(?:@\w+)?\s+(\S+)/i);
      if (mKey) {
        const k = mKey[1].trim().toUpperCase();
        const expected = String(cur.license_key || "").toUpperCase() || autoraiExpectedKey(cur.token);
        if (safeEqual(k, expected)) {
          db.prepare("UPDATE autorai_bots SET license_key=?, license_valid=1, controller_tg_id=? WHERE id=?")
            .run(expected, msg.from.id, row.id);
          try { await bot.sendMessage(msg.chat.id, "✅ Xác thực key thành công! Bạn là <b>controller</b> của bot này.", { parse_mode: "HTML" }); } catch {}
        } else {
          try { await bot.sendMessage(msg.chat.id, "❌ Key không đúng."); } catch {}
        }
        return;
      }

      if (!/^\//.test(text)) return; // chỉ xử lý lệnh
      if (/^\/start\b/i.test(text)) return; // đã có handler riêng

      if (!cur.license_valid || !cur.controller_tg_id) {
        try { await bot.sendMessage(msg.chat.id, "🔒 Vui lòng dùng <code>/key &lt;KEY&gt;</code> trước.", { parse_mode: "HTML" }); } catch {}
        return;
      }
      if (msg.from.id !== cur.controller_tg_id) {
        try { await bot.sendMessage(msg.chat.id, "⛔ Bạn không phải controller của bot này."); } catch {}
        return;
      }

      if (/^\/autoraitinnhan(?:@\w+)?\s+/i.test(text)) {
        const body = text.replace(/^\/autoraitinnhan(?:@\w+)?\s+/i, "");
        db.prepare("UPDATE autorai_bots SET contents=? WHERE id=?").run(JSON.stringify([body]), row.id);
        try { await bot.sendMessage(msg.chat.id, "✅ Đã đặt 1 nội dung. Dùng /run để bắt đầu rải."); } catch {}
        return;
      }
      if (/^\/list(?:@\w+)?\s+/i.test(text)) {
        const body = text.replace(/^\/list(?:@\w+)?\s+/i, "");
        const arr = parseListPipe(body);
        if (!arr.length) { try { await bot.sendMessage(msg.chat.id, "⚠️ Danh sách rỗng."); } catch {} return; }
        db.prepare("UPDATE autorai_bots SET contents=? WHERE id=?").run(JSON.stringify(arr), row.id);
        try { await bot.sendMessage(msg.chat.id, `✅ Đã lưu <b>${arr.length}</b> nội dung (xoay vòng).`, { parse_mode: "HTML" }); } catch {}
        return;
      }
      if (/^\/channel(?:@\w+)?\s+/i.test(text)) {
        const body = text.replace(/^\/channel(?:@\w+)?\s+/i, "");
        const arr = parseListPipe(body);
        if (!arr.length) { try { await bot.sendMessage(msg.chat.id, "⚠️ Danh sách rỗng."); } catch {} return; }
        db.prepare("UPDATE autorai_bots SET channels=? WHERE id=?").run(JSON.stringify(arr), row.id);
        try { await bot.sendMessage(msg.chat.id, `✅ Đã lưu <b>${arr.length}</b> kênh:\n${arr.map(escapeHtml).join("\n")}`, { parse_mode: "HTML" }); } catch {}
        return;
      }
      if (/^\/run\b/i.test(text)) {
        db.prepare("UPDATE autorai_bots SET running=1 WHERE id=?").run(row.id);
        try { await bot.sendMessage(msg.chat.id, "▶️ ĐÃ BẬT rải. Bot sẽ chạy nền theo cấu hình admin."); } catch {}
        return;
      }
      if (/^\/stop\b/i.test(text)) {
        db.prepare("UPDATE autorai_bots SET running=0 WHERE id=?").run(row.id);
        try { await bot.sendMessage(msg.chat.id, "⏹ Đã DỪNG rải."); } catch {}
        return;
      }
      if (/^\/status\b/i.test(text)) {
        const c = JSON.parse(cur.contents || "[]");
        const ch = JSON.parse(cur.channels || "[]");
        const status =
          `📊 <b>Trạng thái</b>\n` +
          `Chạy: <b>${cur.running ? "▶️ ON" : "⏹ OFF"}</b>\n` +
          `Số nội dung: <b>${c.length}</b>\n` +
          `Số kênh: <b>${ch.length}</b>\n` +
          `Delay vòng: <b>${cur.delay_seconds}s</b>\n` +
          `Delay giữa các kênh/mục: <b>${cur.list_delay_seconds}s</b>`;
        try { await bot.sendMessage(msg.chat.id, status, { parse_mode: "HTML" }); } catch {}
        return;
      }
      if (/^\/help\b/i.test(text)) {
        try { await bot.sendMessage(msg.chat.id, "Lệnh: /key /channel /autoraitinnhan /list /run /stop /status"); } catch {}
      }
    });

    liveAutorai.set(row.id, { bot, state: { idx: 0, lastRound: 0, sending: false } });
    console.log(`✅ Autorai #${row.id} started`);
  } catch (e) {
    console.error(`❌ Autorai #${row.id} fail:`, e.message);
  }
}
async function stopAutoraiBot(id) {
  const e = liveAutorai.get(id);
  if (!e) return;
  try { await e.bot.stopPolling(); } catch {}
  liveAutorai.delete(id);
  console.log(`⏹  Autorai #${id} stopped`);
}
async function restartAutoraiBot(id) {
  await stopAutoraiBot(id);
  const r = db.prepare("SELECT * FROM autorai_bots WHERE id=?").get(id);
  if (r?.active) await startAutoraiBot(r);
}
async function fullDeleteAutorai(id) {
  await stopAutoraiBot(id);
  db.prepare("DELETE FROM autorai_bots WHERE id=?").run(id);
}

// Worker tick: với mỗi autorai bot đang chạy, đến lượt thì gửi 1 vòng
setInterval(async () => {
  const rows = db.prepare("SELECT * FROM autorai_bots WHERE active=1 AND running=1 AND license_valid=1").all();
  for (const r of rows) {
    const live = liveAutorai.get(r.id);
    if (!live || live.state.sending) continue;
    const contents = JSON.parse(r.contents || "[]");
    const channels = JSON.parse(r.channels || "[]");
    if (!contents.length || !channels.length) continue;
    const now = Date.now();
    const wait = Math.max(0, Number(r.delay_seconds) || 0) * 1000;
    if (now - (live.state.lastRound || 0) < wait) continue;

    live.state.sending = true;
    (async () => {
      try {
        const content = contents[live.state.idx % contents.length];
        const listDelay = Math.max(0, Number(r.list_delay_seconds) || 0) * 1000;
        for (const ch of channels) {
          const target = extractChatTarget(ch);
          if (!target) continue;
          try {
            await live.bot.sendMessage(target, content, { parse_mode: "HTML", disable_web_page_preview: true });
          } catch (e) {
            console.error(`[autorai #${r.id}] send ${target}:`, e.message);
          }
          await new Promise(res => setTimeout(res, listDelay));
        }
        live.state.idx = (live.state.idx + 1) % contents.length;
        live.state.lastRound = Date.now();
        db.prepare("UPDATE autorai_bots SET last_round_at=CURRENT_TIMESTAMP WHERE id=?").run(r.id);
      } finally {
        live.state.sending = false;
      }
    })();
  }
}, 250);

// Boot autorai bots
(async () => {
  for (const r of db.prepare("SELECT * FROM autorai_bots WHERE active=1").all()) {
    await startAutoraiBot(r);
  }
})();

// ---------- SELLER EXPIRY ----------
async function enforceExpiry() {
  const rows = db.prepare(
    "SELECT id, username FROM sellers WHERE active=1 AND expires_at IS NOT NULL AND expires_at <= datetime('now')"
  ).all();
  for (const s of rows) {
    console.log(`⏳ Seller #${s.id} (${s.username}) expired → cleanup`);
    const bots = db.prepare("SELECT id FROM bots WHERE owner_seller_id=?").all(s.id);
    for (const b of bots) await fullDeleteBot(b.id);
    const arBots = db.prepare("SELECT id FROM autorai_bots WHERE owner_seller_id=?").all(s.id);
    for (const b of arBots) await fullDeleteAutorai(b.id);
    db.prepare("DELETE FROM seller_managed_bots WHERE seller_id=?").run(s.id);
    db.prepare("DELETE FROM topups WHERE seller_id=?").run(s.id);
    db.prepare("DELETE FROM sellers WHERE id=?").run(s.id);
  }
}
setInterval(() => enforceExpiry().catch(e => console.error("[expiry]", e.message)), 60 * 1000);
enforceExpiry().catch(() => {});


// ---------- APP ----------
const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "80mb" }));
app.use(express.urlencoded({ extended: true, limit: "80mb" }));
app.get('/healthz',(req,res)=>res.json({ok:true, uptime:process.uptime(), live_bots:liveBots.size, time:new Date().toISOString()}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const broadcastLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// ---------- AUTH ----------
function authRequired(roles = ["admin", "seller"]) {
  return (req, res, next) => {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Chưa đăng nhập" });
    try {
      const payload = jwt.verify(h.slice(7), CONFIG.JWT_SECRET);
      if (!roles.includes(payload.role)) return res.status(403).json({ error: "Không có quyền" });
      if (payload.role === "seller") {
        const s = db.prepare("SELECT active, expires_at FROM sellers WHERE id=?").get(payload.id);
        if (!s || !s.active) return res.status(401).json({ error: "Tài khoản đã bị khoá" });
        if (s.expires_at && new Date(s.expires_at) <= new Date())
          return res.status(401).json({ error: "Tài khoản đã hết hạn" });
      }
      req.user = payload; next();
    } catch { return res.status(401).json({ error: "Token không hợp lệ" }); }
  };
}
const adminOnly = authRequired(["admin"]);
const sellerOnly = authRequired(["seller"]);
const anyAuth = authRequired(["admin", "seller"]);
app.get("/api/server/status", adminOnly, (req,res)=>res.json({ok:true, uptime:process.uptime(), live_bots:liveBots.size, autorai_live:liveAutorai.size, db:CONFIG.DB_PATH, public_base_url:CONFIG.PUBLIC_BASE_URL||null, sites_dir:CONFIG.SITES_DIR}));

function visibleBotIds(req) {
  if (req.user.role === "admin") return null;
  const owned = db.prepare("SELECT id FROM bots WHERE owner_seller_id=?").all(req.user.id).map(r => r.id);
  // v5.9: thêm bot trong seller_managed_bots (match theo @username)
  const managedNames = db.prepare("SELECT LOWER(bot_username) AS u FROM seller_managed_bots WHERE seller_id=?").all(req.user.id).map(r => r.u);
  if (managedNames.length) {
    const ph = managedNames.map(() => "?").join(",");
    const extra = db.prepare(`SELECT id FROM bots WHERE LOWER(bot_username) IN (${ph})`).all(...managedNames).map(r => r.id);
    return [...new Set([...owned, ...extra])];
  }
  return owned;
}
function canTouchBot(req, bot_id) {
  if (req.user.role === "admin") return true;
  const ids = visibleBotIds(req) || [];
  return ids.includes(Number(bot_id));
}

// ---------- STATIC ----------
app.get("/", (_req, res) => res.redirect("/login"));
app.get("/login", (_req, res) => res.sendFile(path.join(ROOT, "public", "login.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));
app.get("/seller", (_req, res) => res.sendFile(path.join(ROOT, "public", "seller.html")));
app.get("/app.css", (_req, res) => res.sendFile(path.join(ROOT, "public", "app.css")));
app.use("/uploads", express.static(CONFIG.UPLOAD_DIR));

// Hosted bot sites: hỗ trợ /site/:id/ cũ và /bot1/ /bot2/ theo slug tự đặt.
function serveHostedSite(row, req, res, next) {
  if (!row || !row.active || !row.web_zip_dir) return res.status(404).send("Site not found");
  const root = path.resolve(CONFIG.SITES_DIR, row.web_zip_dir);
  const rawRel = decodeURIComponent((req.path || "/").replace(/^\/+/, ""));
  const cleanRel = rawRel.replace(/\\/g,"/").replace(/\.\.+/g,"").replace(/^\/+/,"");
  const indexFile = ["index.html", "index.htm", "index.php"].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  let target = cleanRel ? path.resolve(root, cleanRel) : indexFile;
  if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = ["index.html", "index.htm", "index.php"].map(f => path.join(target, f)).find(f => fs.existsSync(f));
  }
  // SPA / PHP front-controller fallback: /bot1/abc => index.php or index.html
  if ((!target || !target.startsWith(root) || !fs.existsSync(target)) && indexFile) target = indexFile;
  if (!target || !target.startsWith(root) || !fs.existsSync(target)) return next();

  if (target.endsWith(".php")) {
    if (!PHP_BIN) {
      // Native Render Node service không có PHP. Thay vì hiện lỗi trắng,
      // dựng chế độ tương thích Mini App từ thư mục data/*.json để source PHP vẫn mở được trong Telegram.
      return renderPhpFallbackMiniApp(root, req, res);
    }
    const env = {
      ...process.env,
      GATEWAY_INTERFACE: "CGI/1.1",
      SERVER_PROTOCOL: "HTTP/1.1",
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.url.split("?")[1] || "",
      REQUEST_URI: req.originalUrl || req.url,
      SCRIPT_FILENAME: target,
      SCRIPT_NAME: "/" + path.relative(root, target).replace(/\\/g,"/"),
      DOCUMENT_ROOT: root,
      REMOTE_ADDR: req.ip || "127.0.0.1",
      CONTENT_TYPE: req.headers["content-type"] || "",
      CONTENT_LENGTH: req.headers["content-length"] || "0",
      HTTP_USER_AGENT: req.headers["user-agent"] || "",
      HTTP_COOKIE: req.headers.cookie || "",
      HTTP_HOST: req.headers.host || "",
      HTTP_X_FORWARDED_FOR: req.headers["x-forwarded-for"] || "",
      HTTP_X_FORWARDED_PROTO: req.headers["x-forwarded-proto"] || "",
    };
    const php = spawn(PHP_BIN, [target], { cwd: root, env });
    let out = Buffer.alloc(0), err = Buffer.alloc(0);
    if (req.readable) req.pipe(php.stdin); else php.stdin.end();
    php.stdout.on("data", d => out = Buffer.concat([out, d]));
    php.stderr.on("data", d => err = Buffer.concat([err, d]));
    php.on("close", code => {
      if (code !== 0) return res.status(500).type("text/plain").send("PHP error:\n" + err.toString());
      const parsed = parsePhpOutput(out);
      if(parsed.status) res.status(parsed.status);
      for(const [k,v] of Object.entries(parsed.headers)) { try{ res.setHeader(k, v); }catch{} }
      if(!res.getHeader("content-type")) res.type("html");
      res.send(parsed.body);
    });
    return;
  }
  return res.sendFile(target);
}
app.use("/site/:botId", (req, res, next) => {
  const id = Number(req.params.botId);
  const row = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  serveHostedSite(row, req, res, next);
});
app.use("/:siteSlug", (req, res, next) => {
  const slug = normalizeSiteSlug(req.params.siteSlug);
  if (RESERVED_SITE_SLUGS.has(slug)) return next();
  const row = db.prepare("SELECT * FROM bots WHERE site_slug=?").get(slug);
  if (!row) return next();
  serveHostedSite(row, req, res, next);
});

// ---------- AUTH ROUTES (v5.7 anti-crack: brute-force lockout per IP) ----------
const _loginFails = new Map(); // ip -> { count, lockUntil }
function _lockKey(req) {
  return (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || "unknown";
}
function _checkLock(req) {
  const k = _lockKey(req);
  const e = _loginFails.get(k);
  if (e && e.lockUntil > Date.now()) {
    return Math.ceil((e.lockUntil - Date.now()) / 1000);
  }
  return 0;
}
function _failLogin(req) {
  const k = _lockKey(req);
  const e = _loginFails.get(k) || { count: 0, lockUntil: 0 };
  e.count++;
  if (e.count >= 5) {
    e.lockUntil = Date.now() + 15 * 60 * 1000; // 15 phút
    e.count = 0;
  }
  _loginFails.set(k, e);
}
function _okLogin(req) { _loginFails.delete(_lockKey(req)); }

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const remain = _checkLock(req);
  if (remain) return res.status(429).json({ error: `Đã khoá ${remain}s do nhập sai quá nhiều lần.` });
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu thông tin" });
  if ((role || "admin") === "admin") {
    if (safeEqual(username, CONFIG.ADMIN_USERNAME) && safeEqual(password, CONFIG.ADMIN_PASSWORD)) {
      _okLogin(req);
      const token = jwt.sign({ id: 0, username, role: "admin" }, CONFIG.JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, role: "admin", username });
    }
  }
  const s = db.prepare("SELECT * FROM sellers WHERE username=? AND active=1").get(username);
  if (s && verifyPassword(password, s.password_hash)) {
    if (s.expires_at && new Date(s.expires_at) <= new Date())
      return res.status(401).json({ error: "Tài khoản đã hết hạn" });
    _okLogin(req);
    const token = jwt.sign({ id: s.id, username: s.username, role: "seller" }, CONFIG.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, role: "seller", username: s.username, display_name: s.display_name, expires_at: s.expires_at });
  }
  _failLogin(req);
  return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
});


app.get("/api/me", anyAuth, (req, res) => {
  if (req.user.role === "admin") return res.json({ role: "admin", username: req.user.username });
  const s = db.prepare("SELECT id,username,display_name,balance,expires_at FROM sellers WHERE id=?").get(req.user.id);
  res.json({ role: "seller", ...s });
});

// ---------- SELLERS (admin) ----------
app.get("/api/admin/sellers", adminOnly, (_req, res) => {
  res.json(db.prepare("SELECT id,username,display_name,balance,active,expires_at,created_at FROM sellers ORDER BY id DESC").all());
});
app.post("/api/admin/sellers", adminOnly, (req, res) => {
  const { username, password, display_name, days, assign_bot_id, assign_bot_ids, managed_bot_usernames } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Thiếu username/password" });
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: "Username không hợp lệ" });
  if (password.length < 6) return res.status(400).json({ error: "Password tối thiểu 6 ký tự" });
  let expires_at = null;
  const d = Number(days);
  if (d && d > 0) expires_at = new Date(Date.now() + d * 86400000).toISOString();
  try {
    const info = db.prepare("INSERT INTO sellers(username,password_hash,display_name,expires_at) VALUES(?,?,?,?)")
      .run(username, hashPassword(password), display_name || username, expires_at);
    const sellerId = info.lastInsertRowid;
    // Gán nhiều bot cho seller này
    const ids = [];
    if (assign_bot_id) ids.push(Number(assign_bot_id));
    if (Array.isArray(assign_bot_ids)) for (const x of assign_bot_ids) { const n = Number(x); if (n) ids.push(n); }
    for (const bid of ids) {
      const exists = db.prepare("SELECT 1 FROM bots WHERE id=?").get(bid);
      if (exists) db.prepare("UPDATE bots SET owner_seller_id=? WHERE id=?").run(sellerId, bid);
    }
    // List @bot mà seller cần quản lí (chỉ là metadata, hiển thị trên UI)
    const unames = parseManagedUsernames(managed_bot_usernames);
    for (const u of unames) {
      try { db.prepare("INSERT INTO seller_managed_bots(seller_id,bot_username) VALUES(?,?)").run(sellerId, u); } catch {}
    }
    res.json({ id: sellerId, username, expires_at, assigned_bot_ids: ids, managed_bots: unames });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
function parseManagedUsernames(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,\n]/);
  const out = new Set();
  for (const s of arr) {
    const t = String(s || "").trim().replace(/^@/, "").replace(/^https?:\/\/(t|telegram)\.me\//i, "");
    if (/^[A-Za-z0-9_]{3,32}$/.test(t)) out.add(t);
  }
  return [...out];
}
app.patch("/api/admin/sellers/:id", adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const { password, display_name, active, balance_delta, add_days, set_expires_at, clear_expiry, managed_bot_usernames, replace_managed } = req.body || {};
  const s = db.prepare("SELECT * FROM sellers WHERE id=?").get(id);
  if (!s) return res.status(404).json({ error: "Không tìm thấy" });
  if (password) db.prepare("UPDATE sellers SET password_hash=? WHERE id=?").run(hashPassword(password), id);
  if (display_name !== undefined) db.prepare("UPDATE sellers SET display_name=? WHERE id=?").run(display_name, id);
  if (active !== undefined) db.prepare("UPDATE sellers SET active=? WHERE id=?").run(active ? 1 : 0, id);
  if (balance_delta) db.prepare("UPDATE sellers SET balance=balance+? WHERE id=?").run(Number(balance_delta) | 0, id);
  if (clear_expiry) db.prepare("UPDATE sellers SET expires_at=NULL WHERE id=?").run(id);
  if (set_expires_at) db.prepare("UPDATE sellers SET expires_at=? WHERE id=?").run(set_expires_at, id);
  if (add_days) {
    const d = Number(add_days);
    const cur = db.prepare("SELECT expires_at FROM sellers WHERE id=?").get(id).expires_at;
    const base = cur && new Date(cur) > new Date() ? new Date(cur) : new Date();
    const next = new Date(base.getTime() + d * 86400000).toISOString();
    db.prepare("UPDATE sellers SET expires_at=? WHERE id=?").run(next, id);
  }
  if (managed_bot_usernames !== undefined) {
    const unames = parseManagedUsernames(managed_bot_usernames);
    if (replace_managed) db.prepare("DELETE FROM seller_managed_bots WHERE seller_id=?").run(id);
    for (const u of unames) {
      try { db.prepare("INSERT INTO seller_managed_bots(seller_id,bot_username) VALUES(?,?)").run(id, u); } catch {}
    }
  }
  res.json({ ok: true });
});
app.get("/api/admin/sellers/:id/managed", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM seller_managed_bots WHERE seller_id=? ORDER BY id DESC").all(Number(req.params.id)));
});
app.delete("/api/admin/sellers/:id/managed/:mid", adminOnly, (req, res) => {
  db.prepare("DELETE FROM seller_managed_bots WHERE id=? AND seller_id=?")
    .run(Number(req.params.mid), Number(req.params.id));
  res.json({ ok: true });
});
app.get("/api/seller/managed", sellerOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM seller_managed_bots WHERE seller_id=? ORDER BY id DESC").all(req.user.id));
});
app.delete("/api/admin/sellers/:id", adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const bots = db.prepare("SELECT id FROM bots WHERE owner_seller_id=?").all(id);
  for (const b of bots) await fullDeleteBot(b.id);
  const arBots = db.prepare("SELECT id FROM autorai_bots WHERE owner_seller_id=?").all(id);
  for (const b of arBots) await fullDeleteAutorai(b.id);
  db.prepare("DELETE FROM seller_managed_bots WHERE seller_id=?").run(id);
  db.prepare("DELETE FROM topups WHERE seller_id=?").run(id);
  db.prepare("DELETE FROM sellers WHERE id=?").run(id);
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
  db.transaction(() => {
    db.prepare("UPDATE topups SET status='approved', reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    db.prepare("UPDATE sellers SET balance=balance+? WHERE id=?").run(t.amount, t.seller_id);
  })();
  res.json({ ok: true });
});
app.post("/api/admin/topups/:id/reject", adminOnly, (req, res) => {
  db.prepare("UPDATE topups SET status='rejected', reviewed_at=CURRENT_TIMESTAMP, note=? WHERE id=?")
    .run(String(req.body?.note || ""), Number(req.params.id));
  res.json({ ok: true });
});

// ---------- BOTS ----------
app.post("/api/bots", anyAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Chỉ admin được thêm bot. Seller chỉ quản lý bot được admin cấp." });
  const {
    token, web_url, welcome, button_label,
    auto_reply_enabled, auto_reply_text, autoreply_token, autoreply_count,
    controller_tg_id, public_url_override, site_slug
  } = req.body || {};
  if (!token) return res.status(400).json({ error: "Thiếu token" });
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return res.status(400).json({ error: "Bot token sai định dạng" });
  if (autoreply_token && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(autoreply_token))
    return res.status(400).json({ error: "Auto-reply token sai định dạng" });
  const url = (web_url || "").trim();
  if (url && !/^https:\/\//i.test(url)) return res.status(400).json({ error: "web_url phải HTTPS (hoặc bỏ trống nếu dùng ZIP)" });
  if (public_url_override && !/^https:\/\//i.test(public_url_override))
    return res.status(400).json({ error: "public_url_override phải HTTPS" });
  try {
    const owner = req.user.role === "seller" ? req.user.id : (req.body.owner_seller_id ? Number(req.body.owner_seller_id) : null);
    const info = db.prepare(
      `INSERT INTO bots(token,web_url,web_mode,welcome,button_label,
                        auto_reply_enabled,auto_reply_text,owner_seller_id,
                        autoreply_token,autoreply_count,controller_tg_id,public_url_override)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      token, url || "", "url", welcome || null, button_label || "Mở Shop (Mini App)",
      auto_reply_enabled ? 1 : 0, auto_reply_text || null, owner,
      autoreply_token || null,
      Math.max(1, Math.min(20, Number(autoreply_count) || 1)),
      controller_tg_id ? Number(controller_tg_id) : null,
      public_url_override || null
    );
    const newSlug = ensureSiteSlug(info.lastInsertRowid, site_slug || `bot${info.lastInsertRowid}`);
    if (!url) writeDefaultMiniApp(info.lastInsertRowid);
    else db.prepare("UPDATE bots SET site_slug=? WHERE id=?").run(newSlug, info.lastInsertRowid);
    const row = db.prepare("SELECT * FROM bots WHERE id=?").get(info.lastInsertRowid);
    // chưa cấp license → KHÔNG khởi động ngay. Admin cần issue license trước.
    await refreshLicense(row.id);
    if (row.license_valid) await startBot(row);
    res.json({ id: row.id, license_valid: !!row.license_valid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/bots", anyAuth, (req, res) => {
  let rows;
  if (req.user.role === "admin") {
    rows = db.prepare(`SELECT b.*, s.username AS owner_username
                       FROM bots b LEFT JOIN sellers s ON s.id=b.owner_seller_id ORDER BY b.id DESC`).all();
  } else {
    // v5.9: seller thấy cả bot được gán owner_seller_id LẪN bot có @username trong seller_managed_bots
    const managed = db.prepare("SELECT LOWER(bot_username) AS u FROM seller_managed_bots WHERE seller_id=?").all(req.user.id).map(r => r.u);
    const owned = db.prepare("SELECT * FROM bots WHERE owner_seller_id=?").all(req.user.id);
    const ownedIds = new Set(owned.map(b => b.id));
    let extra = [];
    if (managed.length) {
      const placeholders = managed.map(() => "?").join(",");
      extra = db.prepare(`SELECT * FROM bots WHERE LOWER(bot_username) IN (${placeholders})`).all(...managed)
        .filter(b => !ownedIds.has(b.id));
    }
    rows = [...owned, ...extra].sort((a, b) => b.id - a.id);
  }
  const safe = rows.map(r => {
    const o = { ...r };
    if (req.user.role !== "admin") {
      delete o.token;
      delete o.autoreply_token;
      delete o.license_key;
    }
    o.effective_url = botEffectiveWebUrl(r);
    o.live = liveBots.has(r.id);
    return o;
  });
  res.json(safe);
});

app.patch("/api/bots/:id", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Không tìm thấy" });
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });

  const {
    web_url, welcome, button_label, active,
    auto_reply_enabled, auto_reply_text, owner_seller_id, web_mode,
    autoreply_token, autoreply_count, controller_tg_id, public_url_override, site_slug,
  } = req.body || {};

  if (web_url !== undefined) db.prepare("UPDATE bots SET web_url=? WHERE id=?").run(web_url, id);
  if (web_mode && (web_mode === "url" || web_mode === "zip"))
    db.prepare("UPDATE bots SET web_mode=? WHERE id=?").run(web_mode, id);
  if (welcome !== undefined) db.prepare("UPDATE bots SET welcome=? WHERE id=?").run(welcome, id);
  if (button_label !== undefined) db.prepare("UPDATE bots SET button_label=? WHERE id=?").run(button_label, id);
  if (auto_reply_enabled !== undefined) db.prepare("UPDATE bots SET auto_reply_enabled=? WHERE id=?").run(auto_reply_enabled ? 1 : 0, id);
  if (auto_reply_text !== undefined) db.prepare("UPDATE bots SET auto_reply_text=? WHERE id=?").run(auto_reply_text, id);
  if (autoreply_count !== undefined) db.prepare("UPDATE bots SET autoreply_count=? WHERE id=?").run(Math.max(1, Math.min(20, Number(autoreply_count) || 1)), id);
  if (controller_tg_id !== undefined) db.prepare("UPDATE bots SET controller_tg_id=? WHERE id=?").run(controller_tg_id ? Number(controller_tg_id) : null, id);
  if (public_url_override !== undefined) {
    if (public_url_override && !/^https:\/\//i.test(public_url_override))
      return res.status(400).json({ error: "public_url_override phải HTTPS" });
    db.prepare("UPDATE bots SET public_url_override=? WHERE id=?").run(public_url_override || null, id);
  }
  if (site_slug !== undefined) {
    ensureSiteSlug(id, site_slug || `bot${id}`);
  }
  let restartNeeded = false;
  if (autoreply_token !== undefined) {
    if (autoreply_token && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(autoreply_token))
      return res.status(400).json({ error: "Auto-reply token sai định dạng" });
    db.prepare("UPDATE bots SET autoreply_token=? WHERE id=?").run(autoreply_token || null, id);
    restartNeeded = true;
  }
  if (req.user.role === "admin" && owner_seller_id !== undefined)
    db.prepare("UPDATE bots SET owner_seller_id=? WHERE id=?").run(owner_seller_id ? Number(owner_seller_id) : null, id);

  if (active !== undefined) {
    db.prepare("UPDATE bots SET active=? WHERE id=?").run(active ? 1 : 0, id);
    if (active) await startBot(db.prepare("SELECT * FROM bots WHERE id=?").get(id));
    else await stopBot(id);
  } else if (restartNeeded) {
    await restartBot(id);
  } else {
    const entry = liveBots.get(id);
    if (entry?.main) {
      const fresh = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
      const eff = botEffectiveWebUrl(fresh);
      if (/^https:\/\//i.test(eff)) {
        try {
          await entry.main.setChatMenuButton({
            menu_button: { type: "web_app", text: fresh.button_label || "Mở Shop", web_app: { url: eff } },
          });
        } catch (e) { console.error("[reapply menu]", e.message); }
      }
    }
  }
  res.json({ ok: true });
});

app.delete("/api/bots/:id", anyAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Seller không được xoá bot, chỉ được cấu hình bot được cấp." });
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  if (!row) return res.json({ ok: true });
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  await fullDeleteBot(id);
  res.json({ ok: true });
});

// ---------- LICENSE (admin) ----------
app.get("/api/admin/bots/:id/license/expected", adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare("SELECT token FROM bots WHERE id=?").get(id);
  if (!b) return res.status(404).json({ error: "Không tìm thấy" });
  res.json({ expected: expectedLicenseFor(b.token), mode: CONFIG.LICENSE_SERVER_URL ? "remote" : "local" });
});
app.post("/api/admin/bots/:id/license", adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
  if (!b) return res.status(404).json({ error: "Không tìm thấy" });
  let key = String(req.body?.license_key || "").trim().toUpperCase();
  if (req.body?.auto_generate) key = expectedLicenseFor(b.token);
  if (!key) return res.status(400).json({ error: "Thiếu license_key" });
  db.prepare("UPDATE bots SET license_key=? WHERE id=?").run(key, id);
  const ok = await refreshLicense(id);
  if (ok && b.active) await restartBot(id);
  else if (!ok) await stopBot(id);
  res.json({ ok: true, valid: ok, license_key: key });
});
app.post("/api/admin/bots/:id/license/revoke", adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE bots SET license_key=NULL, license_valid=0, license_checked_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  await stopBot(id);
  res.json({ ok: true });
});

// ---------- BOT SITE ZIP / FOLDER UPLOAD ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.ZIP_MAX_MB * 1024 * 1024 },
});

function safeWrite(destRoot, relPath, data) {
  if (!relPath || relPath.includes("..")) return false;
  // chuẩn hoá phân tách
  relPath = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const outPath = path.join(destRoot, relPath);
  if (!outPath.startsWith(destRoot + path.sep) && outPath !== destRoot) return false;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, data);
  return true;
}
function finalizeSite(id, dest, fileList) {
  const hasHtml = fileList.some(f => /(^|\/)index\.html?$/i.test(f));
  const hasPhp = fileList.some(f => /(^|\/)index\.php$/i.test(f));
  if (!hasHtml && !hasPhp) {
    rmrf(dest);
    throw new Error("Cần có index.html (hoặc index.htm / index.php) ở thư mục gốc");
  }
  const kind = hasHtml ? "html" : "php";
  const slug = ensureSiteSlug(id);
  db.prepare("UPDATE bots SET web_mode='zip', web_zip_dir=?, web_kind=?, site_slug=? WHERE id=?")
    .run(`bot-${id}`, kind, slug, id);
  return kind;
}

app.post("/api/bots/:id/site-zip", anyAuth, upload.single("zip"), async (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  if (!req.file) return res.status(400).json({ error: "Thiếu file zip" });
  const dirName = `bot-${id}`;
  const dest = path.join(CONFIG.SITES_DIR, dirName);
  rmrf(dest); fs.mkdirSync(dest, { recursive: true });
  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const topLevel = new Set(entries.map(e => e.entryName.split("/")[0]));
    const stripRoot = topLevel.size === 1 && entries.every(e => e.entryName.startsWith([...topLevel][0] + "/") || e.entryName === [...topLevel][0] + "/");
    const rootPrefix = stripRoot ? [...topLevel][0] + "/" : "";
    const written = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      const rel = e.entryName.slice(rootPrefix.length);
      if (safeWrite(dest, rel, e.getData())) written.push(rel.toLowerCase());
    }
    const kind = finalizeSite(id, dest, written);
    const base = requestPublicBase(req);
    if (base && /^https:\/\//i.test(base)) db.prepare("UPDATE bots SET public_url_override=COALESCE(public_url_override, ?) WHERE id=?").run(base, id);
    await restartBot(id);
    const fresh = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
    res.json({
      ok: true, url: botEffectiveWebUrl(fresh), files: written.length, kind,
      php_warning: kind === "php" ? "Source PHP sẽ chạy nếu server cài PHP; nếu host không có PHP thì chỉ nên dùng HTML/JS." : null
    });
  } catch (e) {
    rmrf(dest);
    res.status(400).json({ error: "Lỗi giải nén: " + e.message });
  }
});

// Upload nhiều file (folder) — JSON: { files: [{path, content_b64}] }
app.post("/api/bots/:id/site-folder", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: "Thiếu files" });
  if (files.length > 2000) return res.status(400).json({ error: "Quá 2000 file" });
  const dirName = `bot-${id}`;
  const dest = path.join(CONFIG.SITES_DIR, dirName);
  rmrf(dest); fs.mkdirSync(dest, { recursive: true });
  try {
    // tự strip 1 thư mục bao ngoài nếu tất cả file đều có cùng prefix
    const tops = new Set(files.map(f => (f.path || "").replace(/\\/g, "/").split("/")[0]));
    const stripRoot = tops.size === 1 && [...tops][0] && files.every(f => (f.path || "").replace(/\\/g, "/").startsWith([...tops][0] + "/"));
    const prefix = stripRoot ? [...tops][0] + "/" : "";

    const written = [];
    let totalBytes = 0;
    for (const f of files) {
      const relRaw = String(f.path || "").replace(/\\/g, "/");
      const rel = relRaw.slice(prefix.length);
      const buf = Buffer.from(String(f.content_b64 || ""), "base64");
      totalBytes += buf.length;
      if (totalBytes > CONFIG.ZIP_MAX_MB * 1024 * 1024) throw new Error(`Vượt quá ${CONFIG.ZIP_MAX_MB}MB`);
      if (safeWrite(dest, rel, buf)) written.push(rel.toLowerCase());
    }
    const kind = finalizeSite(id, dest, written);
    const base = requestPublicBase(req);
    if (base && /^https:\/\//i.test(base)) db.prepare("UPDATE bots SET public_url_override=COALESCE(public_url_override, ?) WHERE id=?").run(base, id);
    await restartBot(id);
    const fresh = db.prepare("SELECT * FROM bots WHERE id=?").get(id);
    res.json({
      ok: true, url: botEffectiveWebUrl(fresh), files: written.length, kind,
      php_warning: kind === "php" ? "Source PHP sẽ chạy nếu server cài PHP; nếu host không có PHP thì chỉ nên dùng HTML/JS." : null,
    });
  } catch (e) {
    rmrf(dest);
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/bots/:id/site-zip", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  const row = db.prepare("SELECT web_zip_dir FROM bots WHERE id=?").get(id);
  if (row?.web_zip_dir) rmrf(path.join(CONFIG.SITES_DIR, row.web_zip_dir));
  db.prepare("UPDATE bots SET web_zip_dir=NULL, web_mode='url' WHERE id=?").run(id);
  res.json({ ok: true });
});

// ---------- AUTOREPLY EXCEPTIONS ----------
app.get("/api/bots/:id/autoreply/exceptions", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  res.json(db.prepare(
    `SELECT e.*, u.username, u.first_name, u.last_name
     FROM bot_autoreply_exceptions e
     LEFT JOIN bot_users u ON u.bot_id=e.bot_id AND u.tg_user_id=e.tg_user_id
     WHERE e.bot_id=? ORDER BY e.id DESC`).all(id));
});
app.post("/api/bots/:id/autoreply/exceptions", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  const tg_user_id = Number(req.body?.tg_user_id);
  if (!tg_user_id) return res.status(400).json({ error: "Thiếu tg_user_id" });
  try {
    db.prepare("INSERT INTO bot_autoreply_exceptions(bot_id,tg_user_id,note) VALUES(?,?,?)")
      .run(id, tg_user_id, String(req.body?.note || ""));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/bots/:id/autoreply/exceptions/:exId", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  db.prepare("DELETE FROM bot_autoreply_exceptions WHERE id=? AND bot_id=?").run(Number(req.params.exId), id);
  res.json({ ok: true });
});

// ---------- USERS & MESSAGES ----------
app.get("/api/users", anyAuth, (req, res) => {
  const botIds = visibleBotIds(req);
  const botFilter = req.query.bot_id ? Number(req.query.bot_id) : null;
  const q = (req.query.q || "").toString().trim().toLowerCase();
  let where = "1=1"; const params = [];
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
  res.json(db.prepare(
    `SELECT u.id, u.bot_id, u.tg_user_id, u.username, u.first_name, u.last_name,
            u.msg_count, u.first_seen, u.last_seen, b.bot_username
     FROM bot_users u LEFT JOIN bots b ON b.id=u.bot_id
     WHERE ${where}
     ORDER BY u.last_seen DESC LIMIT 500`
  ).all(...params));
});

app.get("/api/users/:botId/:tgUserId/messages", anyAuth, (req, res) => {
  const bot_id = Number(req.params.botId);
  const tg_user_id = Number(req.params.tgUserId);
  if (!canTouchBot(req, bot_id)) return res.status(403).json({ error: "Không có quyền" });
  const rows = db.prepare(
    "SELECT id,direction,text,created_at FROM bot_messages WHERE bot_id=? AND tg_user_id=? ORDER BY id ASC LIMIT 1000"
  ).all(bot_id, tg_user_id);
  const user = db.prepare("SELECT * FROM bot_users WHERE bot_id=? AND tg_user_id=?").get(bot_id, tg_user_id);
  res.json({ user, messages: rows });
});

app.post("/api/users/:botId/:tgUserId/send", anyAuth, async (req, res) => {
  const bot_id = Number(req.params.botId);
  const tg_user_id = Number(req.params.tgUserId);
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Thiếu nội dung" });
  if (!canTouchBot(req, bot_id)) return res.status(403).json({ error: "Không có quyền" });
  const entry = liveBots.get(bot_id);
  const tg = entry?.main;
  if (!tg) return res.status(400).json({ error: "Bot không hoạt động" });
  const u = db.prepare("SELECT chat_id FROM bot_users WHERE bot_id=? AND tg_user_id=?").get(bot_id, tg_user_id);
  const chatId = u?.chat_id || tg_user_id;
  try {
    await tg.sendMessage(chatId, text, { parse_mode: "HTML" });
    logMsg(bot_id, tg_user_id, "out", text);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- MESSAGE DELETION ----------
app.post("/api/messages/delete", anyAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: "Thiếu ids" });
  const placeholders = ids.map(() => "?").join(",");
  let extra = ""; const params = [...ids];
  if (req.user.role === "seller") {
    const botIds = visibleBotIds(req);
    if (botIds.length === 0) return res.json({ deleted: 0 });
    extra = ` AND bot_id IN (${botIds.map(() => "?").join(",")})`;
    params.push(...botIds);
  }
  const info = db.prepare(`DELETE FROM bot_messages WHERE id IN (${placeholders})${extra}`).run(...params);
  res.json({ deleted: info.changes });
});
app.delete("/api/users/:botId/:tgUserId/messages", anyAuth, (req, res) => {
  const bot_id = Number(req.params.botId);
  const tg_user_id = Number(req.params.tgUserId);
  if (!canTouchBot(req, bot_id)) return res.status(403).json({ error: "Không có quyền" });
  const info = db.prepare("DELETE FROM bot_messages WHERE bot_id=? AND tg_user_id=?").run(bot_id, tg_user_id);
  res.json({ deleted: info.changes });
});
app.delete("/api/bots/:id/messages", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchBot(req, id)) return res.status(403).json({ error: "Không có quyền" });
  const info = db.prepare("DELETE FROM bot_messages WHERE bot_id=?").run(id);
  res.json({ deleted: info.changes });
});
app.delete("/api/admin/messages/all", adminOnly, (_req, res) => {
  const info = db.prepare("DELETE FROM bot_messages").run();
  res.json({ deleted: info.changes });
});

// ---------- BROADCAST ----------
app.post("/api/broadcast", anyAuth, broadcastLimiter, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const targetBotId = req.body?.bot_id ? Number(req.body.bot_id) : null;
  if (!text) return res.status(400).json({ error: "Thiếu nội dung" });
  if (text.length > 3500) return res.status(400).json({ error: "Quá dài (max 3500)" });

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

  const targets = [];
  for (const b of botRows) {
    const users = db.prepare("SELECT tg_user_id, chat_id FROM bot_users WHERE bot_id=?").all(b.id);
    for (const u of users) targets.push({ bot_id: b.id, chat_id: u.chat_id || u.tg_user_id, tg_user_id: u.tg_user_id });
  }
  db.prepare("UPDATE broadcasts SET total=? WHERE id=?").run(targets.length, broadcastId);
  res.json({ ok: true, broadcast_id: broadcastId, total: targets.length });

  (async () => {
    let sent = 0, failed = 0;
    for (const t of targets) {
      const tg = liveBots.get(t.bot_id)?.main;
      if (!tg) { failed++; continue; }
      try {
        await tg.sendMessage(t.chat_id, text, { parse_mode: "HTML" });
        logMsg(t.bot_id, t.tg_user_id, "out", "[broadcast] " + text);
        sent++;
      } catch { failed++; }
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
      bots_live: liveBots.size,
      users: db.prepare("SELECT COUNT(*) c FROM bot_users").get().c,
      users_monthly: db.prepare("SELECT COUNT(DISTINCT tg_user_id||'-'||bot_id) c FROM bot_users WHERE last_seen >= datetime('now','-30 days')").get().c,
      sellers: db.prepare("SELECT COUNT(*) c FROM sellers WHERE active=1").get().c,
      sellers_expiring_7d: db.prepare("SELECT COUNT(*) c FROM sellers WHERE active=1 AND expires_at IS NOT NULL AND expires_at <= datetime('now','+7 days')").get().c,
      topups_pending: db.prepare("SELECT COUNT(*) c FROM topups WHERE status='pending'").get().c,
      messages: db.prepare("SELECT COUNT(*) c FROM bot_messages").get().c,
    });
  }
  const myBotIds = db.prepare("SELECT id FROM bots WHERE owner_seller_id=?").all(req.user.id).map(r => r.id);
  const ph = myBotIds.length ? `(${myBotIds.map(() => "?").join(",")})` : "(0)";
  return res.json({
    bots: myBotIds.length,
    balance: db.prepare("SELECT balance FROM sellers WHERE id=?").get(req.user.id)?.balance || 0,
    expires_at: db.prepare("SELECT expires_at FROM sellers WHERE id=?").get(req.user.id)?.expires_at || null,
    users: myBotIds.length ? db.prepare(`SELECT COUNT(*) c FROM bot_users WHERE bot_id IN ${ph}`).get(...myBotIds).c : 0,
    users_monthly: myBotIds.length ? db.prepare(`SELECT COUNT(*) c FROM bot_users WHERE bot_id IN ${ph} AND last_seen >= datetime('now','-30 days')`).get(...myBotIds).c : 0,
    topups_pending: db.prepare("SELECT COUNT(*) c FROM topups WHERE seller_id=? AND status='pending'").get(req.user.id).c,
  });
});

// ---------- AUTORAI API (v4.1) ----------
function canTouchAutorai(req, id) {
  if (req.user.role === "admin") return true;
  return !!db.prepare("SELECT 1 FROM autorai_bots WHERE id=? AND owner_seller_id=?").get(id, req.user.id);
}
app.get("/api/autorai", anyAuth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare(`SELECT a.*, s.username AS owner_username FROM autorai_bots a LEFT JOIN sellers s ON s.id=a.owner_seller_id ORDER BY a.id DESC`).all()
    : db.prepare("SELECT * FROM autorai_bots WHERE owner_seller_id=? ORDER BY id DESC").all(req.user.id);
  res.json(rows.map(r => {
    const o = { ...r, live: liveAutorai.has(r.id) };
    if (req.user.role !== "admin") { delete o.token; delete o.license_key; }
    try { o.contents = JSON.parse(o.contents || "[]"); } catch { o.contents = []; }
    try { o.channels = JSON.parse(o.channels || "[]"); } catch { o.channels = []; }
    return o;
  }));
});
app.post("/api/autorai", anyAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Chỉ admin được thêm Auto-Rải bot. Seller chỉ cấu hình bot được cấp." });
  const { token, delay_seconds, list_delay_seconds, owner_seller_id, license_key, auto_generate_key } = req.body || {};
  if (!token || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token))
    return res.status(400).json({ error: "Bot token sai định dạng" });
  let key = String(license_key || "").trim().toUpperCase();
  if (auto_generate_key || !key) key = autoraiExpectedKey(token);
  const owner = req.user.role === "seller" ? req.user.id : (owner_seller_id ? Number(owner_seller_id) : null);
  try {
    const info = db.prepare(
      `INSERT INTO autorai_bots(token,license_key,delay_seconds,list_delay_seconds,owner_seller_id) VALUES(?,?,?,?,?)`
    ).run(token, key,
      Math.max(0, Number(delay_seconds) || 0),
      Math.max(0, Number(list_delay_seconds) || 0),
      owner);
    const row = db.prepare("SELECT * FROM autorai_bots WHERE id=?").get(info.lastInsertRowid);
    await startAutoraiBot(row);
    res.json({ id: row.id, license_key: key });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch("/api/autorai/:id", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!canTouchAutorai(req, id)) return res.status(403).json({ error: "Không có quyền" });
  const { delay_seconds, list_delay_seconds, active, running, owner_seller_id, license_key, regenerate_key, contents, channels } = req.body || {};
  if (delay_seconds !== undefined)
    db.prepare("UPDATE autorai_bots SET delay_seconds=? WHERE id=?").run(Math.max(0, Number(delay_seconds) || 0), id);
  if (list_delay_seconds !== undefined)
    db.prepare("UPDATE autorai_bots SET list_delay_seconds=? WHERE id=?").run(Math.max(0, Number(list_delay_seconds) || 0), id);
  if (running !== undefined)
    db.prepare("UPDATE autorai_bots SET running=? WHERE id=?").run(running ? 1 : 0, id);
  if (req.user.role === "admin" && owner_seller_id !== undefined)
    db.prepare("UPDATE autorai_bots SET owner_seller_id=? WHERE id=?").run(owner_seller_id ? Number(owner_seller_id) : null, id);
  if (req.user.role === "admin" && (license_key || regenerate_key)) {
    const row = db.prepare("SELECT token FROM autorai_bots WHERE id=?").get(id);
    const k = regenerate_key ? autoraiExpectedKey(row.token) : String(license_key).trim().toUpperCase();
    db.prepare("UPDATE autorai_bots SET license_key=?, license_valid=0, controller_tg_id=NULL WHERE id=?").run(k, id);
  }
  if (Array.isArray(contents))
    db.prepare("UPDATE autorai_bots SET contents=? WHERE id=?").run(JSON.stringify(contents), id);
  if (Array.isArray(channels))
    db.prepare("UPDATE autorai_bots SET channels=? WHERE id=?").run(JSON.stringify(channels), id);
  if (active !== undefined) {
    db.prepare("UPDATE autorai_bots SET active=? WHERE id=?").run(active ? 1 : 0, id);
    if (active) await startAutoraiBot(db.prepare("SELECT * FROM autorai_bots WHERE id=?").get(id));
    else await stopAutoraiBot(id);
  }
  res.json({ ok: true });
});
app.delete("/api/autorai/:id", anyAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Seller không được xoá Auto-Rải bot, chỉ được cấu hình bot được cấp." });
  const id = Number(req.params.id);
  if (!canTouchAutorai(req, id)) return res.status(403).json({ error: "Không có quyền" });
  await fullDeleteAutorai(id);
  res.json({ ok: true });
});
app.get("/api/admin/autorai/:id/key", adminOnly, (req, res) => {
  const r = db.prepare("SELECT token, license_key FROM autorai_bots WHERE id=?").get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: "Không tìm thấy" });
  res.json({ license_key: r.license_key || autoraiExpectedKey(r.token), expected: autoraiExpectedKey(r.token) });
});

// =====================================================================
// v5.0 — USER ACCOUNT MODE (MTProto / gramjs)
// Đăng nhập tài khoản Telegram thật → gửi tin trực tiếp từ acc, KHÔNG cần bot,
// KHÔNG cần add bot vào nhóm. Acc phải đã là thành viên các nhóm/kênh đích.
// =====================================================================
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const userbotCmd = require("./userbot_commands");
userbotCmd.ensureSchema(db);


db.exec(`
CREATE TABLE IF NOT EXISTS user_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_seller_id INTEGER,
  label TEXT,
  api_id INTEGER NOT NULL,
  api_hash TEXT NOT NULL,
  phone TEXT NOT NULL,
  session TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS account_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  name TEXT,
  contents TEXT DEFAULT '[]',
  channels TEXT DEFAULT '[]',
  delay_seconds REAL DEFAULT 30,
  list_delay_seconds REAL DEFAULT 2,
  running INTEGER DEFAULT 0,
  last_round_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
// v5.1: tag user khi rải
try { db.prepare("ALTER TABLE account_jobs ADD COLUMN mentions TEXT DEFAULT '[]'").run(); } catch {}
try { db.prepare("ALTER TABLE account_jobs ADD COLUMN mention_mode TEXT DEFAULT 'append'").run(); } catch {} // append | placeholder
try { db.prepare("ALTER TABLE account_jobs ADD COLUMN mentions_per_send INTEGER DEFAULT 0").run(); } catch {} // 0 = tất cả
try { db.prepare("ALTER TABLE account_jobs ADD COLUMN auto_join INTEGER DEFAULT 1").run(); } catch {} // tự join link channel/group trước khi gửi

const liveAccounts = new Map();   // accId -> { client, state:{lastRound, sending, idx} }
const pendingLogins = new Map();  // loginId -> { client, phoneCodeHash, ... }

async function startAccountClient(row) {
  if (liveAccounts.has(row.id)) return liveAccounts.get(row.id);
  try {
    const client = new TelegramClient(
      new StringSession(String(row.session || "")),
      Number(row.api_id),
      String(row.api_hash),
      { connectionRetries: 999, retryDelay: 2000, requestRetries: 10, timeout: 30000, useWSS: false, floodSleepThreshold: 60, autoReconnect: true }
    );
    await client.connect();
    let ownerTgId = null;
    try { const me = await client.getMe(); ownerTgId = Number(me?.id?.value ?? me?.id ?? 0) || null; } catch {}
    const live = { client, state: { lastRound: 0, sending: false, idx: 0 }, ownerTgId };
    liveAccounts.set(row.id, live);
    try { userbotCmd.attachCommandHandler(db, row.id, client, { ownerTgId }); }
    catch (e) { console.error(`[acc #${row.id}] attach cmd:`, e.message); }
    console.log(`[acc #${row.id}] connected (${row.phone}) owner=${ownerTgId} + userbot cmds`);
    return live;
  } catch (e) {
    console.error(`[acc #${row.id}] connect fail:`, e.message);
    // retry sau 10s
    setTimeout(() => { startAccountClient(row).catch(() => {}); }, 10000);
    return null;
  }
}

// Health-check + auto-reconnect cho user accounts (fix "lúc dc lúc ko")
setInterval(async () => {
  for (const [accId, live] of liveAccounts.entries()) {
    try {
      if (!live.client.connected) {
        console.warn(`[acc #${accId}] disconnected → reconnect`);
        try { await live.client.connect(); } catch (e) {
          console.error(`[acc #${accId}] reconnect fail:`, e.message);
          try { await live.client.disconnect(); } catch {}
          liveAccounts.delete(accId);
          const row = db.prepare("SELECT * FROM user_accounts WHERE id=? AND active=1").get(accId);
          if (row) setTimeout(() => startAccountClient(row).catch(() => {}), 3000);
        }
      }
    } catch (e) { console.error(`[acc #${accId}] health:`, e.message); }
  }
}, 30000);



async function stopAccountClient(id) {
  const live = liveAccounts.get(id);
  if (!live) return;
  try { await live.client.disconnect(); } catch {}
  liveAccounts.delete(id);
}

// ---- LOGIN: bước 1, gửi mã ----
function cleanTelegramPhone(phone){
  let p = String(phone || "").trim().replace(/[\s().-]/g, "");
  if (p && !p.startsWith("+")) p = "+" + p;
  return p;
}
function withTimeout(promise, ms, message){
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]);
}

app.post("/api/accounts/login/start", anyAuth, async (req, res) => {
  const { api_id, api_hash, phone, label, owner_seller_id } = req.body || {};
  const phoneClean = cleanTelegramPhone(phone);
  if (!api_id || !api_hash || !phoneClean) return res.status(400).json({ error: "Thiếu api_id / api_hash / phone" });
  try {
    const client = new TelegramClient(new StringSession(""), Number(api_id), String(api_hash).trim(), {
      connectionRetries: 10,
      timeout: 30000,
      requestRetries: 5,
      useWSS: false,
      floodSleepThreshold: 60,
      deviceModel: "TGBot Admin",
      systemVersion: "Node"
    });
    await withTimeout(client.connect(), 20000, "Không kết nối được Telegram MTProto trong 20s. Kiểm tra api_id/api_hash hoặc mạng server Render.");
    let sent;
    try {
      sent = await withTimeout(client.sendCode(
        { apiId: Number(api_id), apiHash: String(api_hash).trim() },
        phoneClean
      ), 45000, "Gửi mã Telegram quá lâu / bị treo. Thử restart server hoặc tạo api_id/api_hash mới.");
    } catch (firstErr) {
      // Fallback trực tiếp bằng MTProto auth.SendCode, tránh lỗi wrapper sendCode trên vài môi trường Render.
      sent = await withTimeout(client.invoke(new Api.auth.SendCode({
        phoneNumber: phoneClean,
        apiId: Number(api_id),
        apiHash: String(api_hash).trim(),
        settings: new Api.CodeSettings({})
      })), 45000, "Telegram MTProto không phản hồi khi gửi mã. Render/VPS có thể đang chặn kết nối Telegram.");
    }
    const loginId = crypto.randomBytes(8).toString("hex");
    pendingLogins.set(loginId, {
      client,
      phoneCodeHash: sent.phoneCodeHash,
      api_id: Number(api_id),
      api_hash: String(api_hash).trim(),
      phone: phoneClean,
      label: String(label || phoneClean),
      owner_seller_id: req.user.role === "seller" ? req.user.id : (owner_seller_id ? Number(owner_seller_id) : null),
      expires: Date.now() + 10 * 60 * 1000,
    });
    res.json({ login_id: loginId, hint: "Telegram đã gửi mã. Nhập code (và 2FA password nếu có)." });
  } catch (e) {
    try { if (client) await client.disconnect(); } catch {}
    res.status(400).json({ error: e.errorMessage || e.message || "Không gửi được mã Telegram", code: e.code || e.errorCode || null });
  }
});

// ---- LOGIN: bước 2, nhập code (+ optional 2FA password) ----
app.post("/api/accounts/login/code", anyAuth, async (req, res) => {
  const { login_id, code, password } = req.body || {};
  const p = pendingLogins.get(login_id);
  if (!p) return res.status(400).json({ error: "Phiên login không hợp lệ / hết hạn" });
  try {
    try {
      await p.client.invoke(new Api.auth.SignIn({
        phoneNumber: p.phone,
        phoneCodeHash: p.phoneCodeHash,
        phoneCode: String(code || ""),
      }));
    } catch (err) {
      const msg = String(err.errorMessage || err.message || "");
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) return res.status(428).json({ error: "Cần 2FA password", need_password: true });
        await p.client.signInWithPassword(
          { apiId: p.api_id, apiHash: p.api_hash },
          { password: async () => String(password), onError: (e) => { throw e; } }
        );
      } else { throw err; }
    }
    const sessionStr = String(p.client.session.save());
    const info = db.prepare(
      "INSERT INTO user_accounts(owner_seller_id,label,api_id,api_hash,phone,session) VALUES(?,?,?,?,?,?)"
    ).run(p.owner_seller_id, p.label, p.api_id, p.api_hash, p.phone, sessionStr);
    pendingLogins.delete(login_id);
    const row = db.prepare("SELECT * FROM user_accounts WHERE id=?").get(info.lastInsertRowid);
    await startAccountClient(row);
    res.json({ ok: true, account: { id: row.id, label: row.label, phone: row.phone } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function ownAccount(req, id) {
  if (req.user.role === "admin") return true;
  return !!db.prepare("SELECT 1 FROM user_accounts WHERE id=? AND owner_seller_id=?").get(id, req.user.id);
}

app.get("/api/accounts", anyAuth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT a.id,a.label,a.phone,a.active,a.created_at,a.owner_seller_id,s.username AS owner FROM user_accounts a LEFT JOIN sellers s ON s.id=a.owner_seller_id ORDER BY a.id DESC").all()
    : db.prepare("SELECT id,label,phone,active,created_at FROM user_accounts WHERE owner_seller_id=? ORDER BY id DESC").all(req.user.id);
  for (const r of rows) r.connected = liveAccounts.has(r.id);
  res.json(rows);
});

app.patch("/api/accounts/:id", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!ownAccount(req, id)) return res.status(403).json({ error: "Forbidden" });
  const { active, label } = req.body || {};
  if (label !== undefined) db.prepare("UPDATE user_accounts SET label=? WHERE id=?").run(String(label), id);
  if (active !== undefined) {
    db.prepare("UPDATE user_accounts SET active=? WHERE id=?").run(active ? 1 : 0, id);
    if (active) { const r = db.prepare("SELECT * FROM user_accounts WHERE id=?").get(id); await startAccountClient(r); }
    else { await stopAccountClient(id); }
  }
  res.json({ ok: true });
});

app.delete("/api/accounts/:id", anyAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!ownAccount(req, id)) return res.status(403).json({ error: "Forbidden" });
  await stopAccountClient(id);
  db.prepare("DELETE FROM account_jobs WHERE account_id=?").run(id);
  db.prepare("DELETE FROM user_accounts WHERE id=?").run(id);
  res.json({ ok: true });
});

// ----- ACCOUNT JOBS (rải tin từ tài khoản) -----
function ownJob(req, id) {
  if (req.user.role === "admin") return true;
  return !!db.prepare("SELECT 1 FROM account_jobs j JOIN user_accounts a ON a.id=j.account_id WHERE j.id=? AND a.owner_seller_id=?").get(id, req.user.id);
}

app.get("/api/account-jobs", anyAuth, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT j.*, a.label AS account_label, a.phone AS account_phone FROM account_jobs j JOIN user_accounts a ON a.id=j.account_id ORDER BY j.id DESC").all()
    : db.prepare("SELECT j.*, a.label AS account_label, a.phone AS account_phone FROM account_jobs j JOIN user_accounts a ON a.id=j.account_id WHERE a.owner_seller_id=? ORDER BY j.id DESC").all(req.user.id);
  res.json(rows);
});

app.post("/api/account-jobs", anyAuth, (req, res) => {
  const { account_id, name, contents, channels, delay_seconds, list_delay_seconds, mentions, mention_mode, mentions_per_send, auto_join } = req.body || {};
  if (!account_id) return res.status(400).json({ error: "Thiếu account_id" });
  if (!ownAccount(req, Number(account_id))) return res.status(403).json({ error: "Forbidden" });
  const info = db.prepare(
    "INSERT INTO account_jobs(account_id,name,contents,channels,delay_seconds,list_delay_seconds,mentions,mention_mode,mentions_per_send,auto_join) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).run(
    Number(account_id),
    String(name || "Job"),
    JSON.stringify(Array.isArray(contents) ? contents : []),
    JSON.stringify(Array.isArray(channels) ? channels : []),
    Math.max(0, Number(delay_seconds) || 0),
    Math.max(0, Number(list_delay_seconds) || 0),
    JSON.stringify(Array.isArray(mentions) ? mentions : []),
    (mention_mode === "placeholder" ? "placeholder" : "append"),
    Math.max(0, Number(mentions_per_send) || 0),
    auto_join === false ? 0 : 1,
  );
  res.json(db.prepare("SELECT * FROM account_jobs WHERE id=?").get(info.lastInsertRowid));
});

app.patch("/api/account-jobs/:id", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!ownJob(req, id)) return res.status(403).json({ error: "Forbidden" });
  const { name, contents, channels, delay_seconds, list_delay_seconds, running, mentions, mention_mode, mentions_per_send, auto_join } = req.body || {};
  if (name !== undefined) db.prepare("UPDATE account_jobs SET name=? WHERE id=?").run(String(name), id);
  if (Array.isArray(contents)) db.prepare("UPDATE account_jobs SET contents=? WHERE id=?").run(JSON.stringify(contents), id);
  if (Array.isArray(channels)) db.prepare("UPDATE account_jobs SET channels=? WHERE id=?").run(JSON.stringify(channels), id);
  if (Array.isArray(mentions)) db.prepare("UPDATE account_jobs SET mentions=? WHERE id=?").run(JSON.stringify(mentions), id);
  if (mention_mode !== undefined) db.prepare("UPDATE account_jobs SET mention_mode=? WHERE id=?").run(mention_mode === "placeholder" ? "placeholder" : "append", id);
  if (mentions_per_send !== undefined) db.prepare("UPDATE account_jobs SET mentions_per_send=? WHERE id=?").run(Math.max(0, Number(mentions_per_send) || 0), id);
  if (auto_join !== undefined) db.prepare("UPDATE account_jobs SET auto_join=? WHERE id=?").run(auto_join ? 1 : 0, id);
  if (delay_seconds !== undefined) db.prepare("UPDATE account_jobs SET delay_seconds=? WHERE id=?").run(Math.max(0, Number(delay_seconds) || 0), id);
  if (list_delay_seconds !== undefined) db.prepare("UPDATE account_jobs SET list_delay_seconds=? WHERE id=?").run(Math.max(0, Number(list_delay_seconds) || 0), id);
  if (running !== undefined) {
    db.prepare("UPDATE account_jobs SET running=? WHERE id=?").run(running ? 1 : 0, id);
    if (running) {
      const j = db.prepare("SELECT * FROM account_jobs WHERE id=?").get(id);
      const a = db.prepare("SELECT * FROM user_accounts WHERE id=?").get(j.account_id);
      if (a && a.active) startAccountClient(a).catch(() => {});
    }
  }
  res.json(db.prepare("SELECT * FROM account_jobs WHERE id=?").get(id));
});

app.delete("/api/account-jobs/:id", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!ownJob(req, id)) return res.status(403).json({ error: "Forbidden" });
  db.prepare("DELETE FROM account_jobs WHERE id=?").run(id);
  res.json({ ok: true });
});

// Helper: chuẩn hoá list mention, hỗ trợ @user, t.me/user, tg://user?id=, hoặc số id
function normalizeMention(m) {
  const s = String(m || "").trim();
  if (!s) return null;
  if (/^@/.test(s)) return s;
  const mTme = s.match(/(?:t\.me\/|telegram\.me\/)@?([A-Za-z0-9_]{4,32})/i);
  if (mTme) return "@" + mTme[1];
  const mTg = s.match(/tg:\/\/user\?id=(\d+)/i);
  if (mTg) return `<a href="tg://user?id=${mTg[1]}">user</a>`;
  if (/^-?\d+$/.test(s)) return `<a href="tg://user?id=${s}">user</a>`;
  if (/^[A-Za-z0-9_]{4,32}$/.test(s)) return "@" + s;
  return s;
}
function buildMentionsBlock(arr, perSend, idx) {
  if (!arr || !arr.length) return "";
  const norm = arr.map(normalizeMention).filter(Boolean);
  if (!norm.length) return "";
  if (!perSend || perSend <= 0 || perSend >= norm.length) return norm.join(" ");
  const out = [];
  for (let i = 0; i < perSend; i++) out.push(norm[(idx * perSend + i) % norm.length]);
  return out.join(" ");
}

function parseTelegramTarget(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return { type: "id", value: Number(s), input: s };
  const invite = s.match(/(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
  if (invite) return { type: "invite", value: invite[1], input: s };
  const pub = s.match(/(?:t\.me|telegram\.me)\/@?([A-Za-z0-9_]{3,})/i) || s.match(/^@?([A-Za-z0-9_]{3,})$/);
  if (pub) return { type: "public", value: pub[1], input: "@" + pub[1] };
  return { type: "raw", value: s, input: s };
}

async function resolveAccountTarget(client, raw, autoJoin) {
  const t = parseTelegramTarget(raw);
  if (!t) return null;
  if (t.type === "invite") {
    if (!autoJoin) throw new Error("Private invite link cần bật tự join");
    try {
      const updates = await client.invoke(new Api.messages.ImportChatInvite({ hash: t.value }));
      const chats = updates?.chats || updates?.updates?.flatMap(u => u.chats || []) || [];
      if (chats && chats.length) return chats[0];
    } catch (e) {
      const msg = String(e.errorMessage || e.message || "");
      if (!/USER_ALREADY_PARTICIPANT|already/i.test(msg)) throw e;
    }
    return await client.getEntity(t.input);
  }
  if (t.type === "public" && autoJoin) {
    try { await client.invoke(new Api.channels.JoinChannel({ channel: t.input })); }
    catch (e) {
      const msg = String(e.errorMessage || e.message || "");
      if (!/USER_ALREADY_PARTICIPANT|already|INVITE_REQUEST_SENT/i.test(msg)) console.warn(`[auto-join] ${t.input}:`, msg);
    }
  }
  return await client.getEntity(t.type === "id" ? t.value : t.input);
}

// Worker tick (mỗi 100ms) — gửi tin từ tài khoản
async function tickAccountJobs() {
  const rows = db.prepare(
    "SELECT j.* FROM account_jobs j JOIN user_accounts a ON a.id=j.account_id WHERE j.running=1 AND a.active=1"
  ).all();
  for (const r of rows) {
    let live = liveAccounts.get(r.account_id);
    if (!live) {
      const a = db.prepare("SELECT * FROM user_accounts WHERE id=?").get(r.account_id);
      if (a) live = await startAccountClient(a);
      if (!live) continue;
    }
    if (live.state.sending) continue;
    const contents = JSON.parse(r.contents || "[]");
    const channels = JSON.parse(r.channels || "[]");
    if (!contents.length || !channels.length) continue;
    const wait = Math.max(0, Number(r.delay_seconds) || 0) * 1000;
    if (Date.now() - (live.state.lastRound || 0) < wait) continue;

    live.state.sending = true;
    (async () => {
      try {
        let content = contents[live.state.idx % contents.length];
        const mentions = JSON.parse(r.mentions || "[]");
        const block = buildMentionsBlock(mentions, Number(r.mentions_per_send) || 0, live.state.idx);
        if (block) {
          if (r.mention_mode === "placeholder" && content.includes("{mentions}")) {
            content = content.replace(/\{mentions\}/g, block);
          } else {
            content = content + "\n" + block;
          }
        }
        const listDelay = Math.max(0, Number(r.list_delay_seconds) || 0) * 1000;
        for (const ch of channels) {
          const target = String(ch || "").trim();
          if (!target) continue;
          try {
            const entity = await resolveAccountTarget(live.client, target, Number(r.auto_join ?? 1) === 1);
            if (!entity) continue;
            await live.client.sendMessage(entity, { message: content, parseMode: "html" });
          } catch (e) {
            console.error(`[acc job #${r.id}] ${target}:`, e.errorMessage || e.message);
          }
          if (listDelay > 0) await new Promise(rr => setTimeout(rr, listDelay));
        }
        live.state.idx = (live.state.idx + 1) % contents.length;
        live.state.lastRound = Date.now();
        db.prepare("UPDATE account_jobs SET last_round_at=CURRENT_TIMESTAMP WHERE id=?").run(r.id);
      } catch (e) {
        console.error(`[acc job #${r.id}] tick:`, e.message);
      } finally {
        live.state.sending = false;
      }
    })();
  }
}
setInterval(() => { tickAccountJobs().catch(() => {}); }, 100);
setInterval(() => { userbotCmd.tickRunner(db, liveAccounts, startAccountClient).catch(() => {}); }, 500);

// v5.9: tự bật lại các account có state.running=1 ngay khi boot (bot rải kể cả khi user "tắt" acc)
setInterval(async () => {
  try {
    const rows = db.prepare("SELECT DISTINCT account_id FROM account_cmd_state WHERE running=1").all();
    for (const r of rows) {
      if (!liveAccounts.has(r.account_id)) {
        const acc = db.prepare("SELECT * FROM user_accounts WHERE id=?").get(r.account_id);
        if (acc) await startAccountClient(acc);
      }
    }
  } catch {}
}, 15000);


// Dọn pending logins quá hạn
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingLogins) if (v.expires < now) {
    try { v.client.disconnect(); } catch {}
    pendingLogins.delete(k);
  }
}, 60000);

// Boot accounts
(async () => {
  for (const r of db.prepare("SELECT * FROM user_accounts WHERE active=1").all()) {
    await startAccountClient(r);
  }
})();

// ---------- USERBOT ADMIN KEYS (v5.9) ----------
// Mỗi user_account có 1 admin_key. Nhập /key <KEY> trong chat sẽ thành admin của bot acc đó.
app.get("/api/accounts/:id/admin-key", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!ownAccount(req, id)) return res.status(403).json({ error: "Forbidden" });
  const key = userbotCmd.getOrCreateAdminKey(db, id);
  res.json({ account_id: id, admin_key: key });
});
app.post("/api/accounts/:id/admin-key/regenerate", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!ownAccount(req, id)) return res.status(403).json({ error: "Forbidden" });
  const k = userbotCmd.setAdminKey(db, id);
  res.json({ account_id: id, admin_key: k });
});
app.get("/api/accounts/:id/admins", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!ownAccount(req, id)) return res.status(403).json({ error: "Forbidden" });
  const admins = userbotCmd.listAdmins(db, id);
  const authed = db.prepare("SELECT id, username, tg_user_id, created_at FROM account_authorized_users WHERE account_id=? ORDER BY id ASC").all(id);
  res.json({ admins, authorized_users: authed });
});
app.delete("/api/accounts/:id/admins/:tgId", anyAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!ownAccount(req, id)) return res.status(403).json({ error: "Forbidden" });
  const tg = Number(req.params.tgId);
  const a = db.prepare("DELETE FROM account_admins WHERE account_id=? AND tg_user_id=?").run(id, tg).changes;
  const b = db.prepare("DELETE FROM account_authorized_users WHERE account_id=? AND tg_user_id=?").run(id, tg).changes;
  res.json({ ok: true, removed: a + b });
});

// ---------- 404 ----------

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ---------- START ----------
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 TGBot Platform v5.9 — http://localhost:${CONFIG.PORT}`);

  console.log(`🔑 Admin: ${CONFIG.ADMIN_USERNAME} / ${CONFIG.ADMIN_PASSWORD}`);
  console.log(`🌐 PUBLIC_BASE_URL: ${CONFIG.PUBLIC_BASE_URL || "(chưa set — phải set HTTPS để bot mini-app hiện nút)"}`);
  console.log(`📜 License mode: ${CONFIG.LICENSE_SERVER_URL ? "REMOTE " + CONFIG.LICENSE_SERVER_URL : "LOCAL (HMAC)"}`);
  if (!process.env.JWT_SECRET) console.log("⚠️  JWT_SECRET random — set env để session ổn định.");
  if (!process.env.ADMIN_PASSWORD) console.log("⚠️  Đang dùng password mặc định — đổi ADMIN_PASSWORD trên production.\n");
});
