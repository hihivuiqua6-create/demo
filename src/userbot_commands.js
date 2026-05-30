// v5.9 — Userbot In-Chat Commands + Admin Auth
// - Owner (acc đăng nhập) luôn là admin tối cao.
// - Lệnh /key <KEY> để 1 user khác trở thành ADMIN của bot (đa admin).
// - Admin có thêm: /adduser, /listuseradmin, /deleteuseradmin
//   (add user vào danh sách AUTHORIZED — user đó không cần api_id riêng vẫn dùng bot này).
// - /list KHÔNG hiện /key, /adduser, /listuseradmin, /deleteuseradmin cho người không phải admin.
// - Listen cả OUTGOING (acc tự gõ) lẫn INCOMING (admin / authorized user nhắn vào DM).
// - Rải hỗ trợ "Saved Messages" qua từ khoá: me / saved / savedmessages.
"use strict";

const { Api } = require("telegram");
const { NewMessage } = require("telegram/events");
const crypto = require("crypto");

// ---- DB schema ----
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_cmd_state (
      account_id INTEGER PRIMARY KEY,
      users TEXT DEFAULT '[]',
      channels TEXT DEFAULT '[]',
      in_user TEXT,
      in_channel TEXT,
      contents TEXT DEFAULT '[]',
      delay1 REAL DEFAULT 1,
      delay2 REAL DEFAULT 1,
      running INTEGER DEFAULT 0,
      idx INTEGER DEFAULT 0,
      last_round_at INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS account_admin_keys (
      account_id INTEGER PRIMARY KEY,
      admin_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS account_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      tg_user_id INTEGER NOT NULL,
      username TEXT,
      first_name TEXT,
      added_by TEXT DEFAULT 'key',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, tg_user_id)
    );
    CREATE TABLE IF NOT EXISTS account_authorized_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      username TEXT,
      tg_user_id INTEGER,
      added_by_tg INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, username, tg_user_id)
    );
  `);
}

function genKey() {
  return crypto.randomBytes(8).toString("hex").toUpperCase(); // 16 hex chars
}
function getOrCreateAdminKey(db, accountId) {
  let row = db.prepare("SELECT admin_key FROM account_admin_keys WHERE account_id=?").get(accountId);
  if (!row) {
    const k = genKey();
    db.prepare("INSERT INTO account_admin_keys(account_id, admin_key) VALUES(?,?)").run(accountId, k);
    return k;
  }
  return row.admin_key;
}
function setAdminKey(db, accountId, key) {
  const k = String(key || "").trim().toUpperCase() || genKey();
  db.prepare(`INSERT INTO account_admin_keys(account_id, admin_key) VALUES(?,?)
              ON CONFLICT(account_id) DO UPDATE SET admin_key=excluded.admin_key`).run(accountId, k);
  return k;
}
function listAdmins(db, accountId) {
  return db.prepare("SELECT tg_user_id, username, first_name, added_by FROM account_admins WHERE account_id=? ORDER BY id ASC").all(accountId);
}
function addAdmin(db, accountId, tgUserId, username, firstName, addedBy = "key") {
  try {
    db.prepare("INSERT INTO account_admins(account_id, tg_user_id, username, first_name, added_by) VALUES(?,?,?,?,?)")
      .run(accountId, tgUserId, username || null, firstName || null, addedBy);
    return true;
  } catch { return false; }
}
function isAdmin(db, accountId, tgUserId, ownerTgId) {
  if (ownerTgId && Number(tgUserId) === Number(ownerTgId)) return true;
  return !!db.prepare("SELECT 1 FROM account_admins WHERE account_id=? AND tg_user_id=?").get(accountId, tgUserId);
}
function isAuthorized(db, accountId, tgUserId, username, ownerTgId) {
  if (isAdmin(db, accountId, tgUserId, ownerTgId)) return true;
  const u = (username || "").toLowerCase().replace(/^@/, "");
  const row = db.prepare(
    "SELECT 1 FROM account_authorized_users WHERE account_id=? AND (tg_user_id=? OR LOWER(IFNULL(username,''))=?)"
  ).get(accountId, tgUserId || 0, u);
  return !!row;
}

function getState(db, accountId) {
  let row = db.prepare("SELECT * FROM account_cmd_state WHERE account_id=?").get(accountId);
  if (!row) {
    db.prepare("INSERT INTO account_cmd_state(account_id) VALUES(?)").run(accountId);
    row = db.prepare("SELECT * FROM account_cmd_state WHERE account_id=?").get(accountId);
  }
  return {
    ...row,
    users: JSON.parse(row.users || "[]"),
    channels: JSON.parse(row.channels || "[]"),
    contents: JSON.parse(row.contents || "[]"),
  };
}
function saveState(db, accountId, patch) {
  const allowed = ["users","channels","in_user","in_channel","contents","delay1","delay2","running","idx","last_round_at"];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (["users","channels","contents"].includes(k)) { sets.push(`${k}=?`); vals.push(JSON.stringify(patch[k] || [])); }
    else { sets.push(`${k}=?`); vals.push(patch[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at=CURRENT_TIMESTAMP");
  vals.push(accountId);
  db.prepare(`UPDATE account_cmd_state SET ${sets.join(",")} WHERE account_id=?`).run(...vals);
}

// ---------- Helpers ----------
const SAVED_KEYWORDS = new Set(["me","self","saved","savedmessages","saved_messages","kho","kholuu","kholuutru"]);
function isSavedTarget(s) { return SAVED_KEYWORDS.has(String(s || "").toLowerCase().replace(/^@/, "")); }

function normUser(s) {
  s = String(s || "").trim();
  if (!s) return null;
  if (isSavedTarget(s)) return "me";
  if (/^https?:\/\/(t|telegram)\.me\/@?([A-Za-z0-9_]{3,32})/i.test(s)) {
    return "@" + s.match(/(?:t|telegram)\.me\/@?([A-Za-z0-9_]{3,32})/i)[1];
  }
  if (/^@?[A-Za-z0-9_]{3,32}$/.test(s)) return "@" + s.replace(/^@/, "");
  if (/^-?\d+$/.test(s)) return s;
  return s;
}
function normChannel(s) {
  const t = String(s || "").trim();
  if (isSavedTarget(t)) return "me";
  return t;
}

const HELP_BASE = [
  "🤖 <b>USERBOT COMMAND PANEL</b>",
  "━━━━━━━━━━━━━━━━━━",
  "/list — Hiện toàn bộ lệnh",
  "/addtarget &lt;@user|link&gt; — Add user/kênh vào danh sách rải (dùng <code>me</code> để rải vào Kho lưu trữ)",
  "/checkuser — Xem user đã add",
  "/checkchannel — Xem channel đã add",
  "/delete &lt;@user|link&gt; — Xoá khỏi danh sách",
  "/inuser &lt;@user&gt; — Chỉ rải user này",
  "/inchannel &lt;link&gt; — Chỉ rải nhóm/kênh này",
  "/run — Bắt đầu rải",
  "/stop — Dừng rải",
  "/addcmt &lt;nội dung&gt; — Thêm 1 nội dung",
  "/addlist &lt;nd1 | nd2 | nd3&gt; — Thêm nhiều nội dung",
  "/listcmt — Liệt kê nội dung",
  "/deletecmt &lt;số&gt; — Xoá nội dung theo STT",
  "/delete-allcmt — Xoá toàn bộ nội dung",
  "/delay1 &lt;giây&gt; — Delay giữa các vòng",
  "/delay2 &lt;giây&gt; — Delay giữa mỗi target",
  "/liston — Trạng thái hiện tại",
].join("\n");

const HELP_ADMIN_EXTRA = [
  "",
  "🛡️ <b>LỆNH ADMIN</b>",
  "━━━━━━━━━━━━━━━━━━",
  "/key &lt;KEY&gt; — Nhập key để trở thành admin",
  "/adduser &lt;@user&gt; — Cấp quyền dùng bot cho user (không cần api_id)",
  "/listuseradmin — Danh sách user admin đã cấp quyền",
  "/deleteuseradmin &lt;@user&gt; — Thu hồi quyền",
].join("\n");

function fmtUserTag(u) {
  if (!u) return "user";
  if (u.username) return "@" + u.username;
  if (u.first_name) return u.first_name;
  return String(u.tg_user_id || "user");
}

// Trả về text reply hoặc null nếu không xử lý
function buildReply(db, accountId, raw, ctx) {
  // ctx = { fromId, fromUsername, isOwner, ownerTgId }
  const text = String(raw || "").trim();
  if (!text.startsWith("/")) return null;
  const m = text.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();
  const st = getState(db, accountId);

  const callerIsAdmin = ctx.isOwner || isAdmin(db, accountId, ctx.fromId, ctx.ownerTgId);
  const callerAuthorized = callerIsAdmin || isAuthorized(db, accountId, ctx.fromId, ctx.fromUsername, ctx.ownerTgId);

  // /key luôn được nhận để leo quyền
  if (cmd === "key") {
    if (!arg) return "⚠️ Cú pháp: <code>/key &lt;KEY&gt;</code>";
    const expected = String(getOrCreateAdminKey(db, accountId)).toUpperCase();
    if (arg.trim().toUpperCase() !== expected) return "❌ Key không đúng.";
    if (ctx.isOwner) return "ℹ️ Bạn là owner — đã là admin tối cao.";
    if (isAdmin(db, accountId, ctx.fromId, ctx.ownerTgId)) return "ℹ️ Bạn đã là admin rồi.";
    addAdmin(db, accountId, ctx.fromId, ctx.fromUsername, ctx.fromFirstName, "key");
    return `✅ Đã cấp quyền <b>ADMIN</b> cho ${fmtUserTag({username: ctx.fromUsername, first_name: ctx.fromFirstName, tg_user_id: ctx.fromId})}.\nDùng /list để xem lệnh.`;
  }

  // Mọi lệnh khác yêu cầu authorized (owner / admin / user được admin add)
  if (!callerAuthorized) {
    // không trả lời để bot không spam người lạ
    return null;
  }

  switch (cmd) {
    case "list":
      // v5.9: KHÔNG hiển thị lệnh admin trong /list (admin vẫn dùng được nhưng user không mò ra)
      return HELP_BASE;

    case "adduser": {
      if (!callerIsAdmin) return null;
      if (!arg) return "⚠️ Cú pháp: <code>/adduser @username</code>";
      const raw = arg.trim().replace(/^@/, "").replace(/^https?:\/\/(t|telegram)\.me\//i, "");
      if (!/^[A-Za-z0-9_]{3,32}$/.test(raw) && !/^-?\d+$/.test(raw))
        return "⚠️ Username không hợp lệ.";
      try {
        if (/^-?\d+$/.test(raw)) {
          db.prepare("INSERT OR IGNORE INTO account_authorized_users(account_id, tg_user_id, added_by_tg) VALUES(?,?,?)").run(accountId, Number(raw), ctx.fromId);
        } else {
          db.prepare("INSERT OR IGNORE INTO account_authorized_users(account_id, username, added_by_tg) VALUES(?,?,?)").run(accountId, raw.toLowerCase(), ctx.fromId);
        }
      } catch (e) { return "❌ Lỗi: " + e.message; }
      const tag = /^-?\d+$/.test(raw) ? raw : ("@" + raw);
      return `✅ Đã cấp quyền dùng bot cho <b>${tag}</b>. User này không cần api_id riêng, chỉ cần nhắn lệnh cho bot này.`;
    }

    case "listuseradmin": {
      if (!callerIsAdmin) return null;
      const admins = listAdmins(db, accountId);
      const auth = db.prepare("SELECT username, tg_user_id FROM account_authorized_users WHERE account_id=? ORDER BY id ASC").all(accountId);
      const parts = ["🛡️ <b>ADMIN / AUTHORIZED USER</b>", "━━━━━━━━━━━━━━━━━━"];
      parts.push(`<b>Owner:</b> id ${ctx.ownerTgId || "?"}`);
      if (admins.length) {
        parts.push("\n<b>Admin (đã nhập key):</b>");
        admins.forEach((a, i) => parts.push(`${i+1}. ${a.username ? "@"+a.username : ""} <code>${a.tg_user_id}</code>`));
      }
      if (auth.length) {
        parts.push("\n<b>User được admin add (/adduser):</b>");
        auth.forEach((a, i) => parts.push(`${i+1}. ${a.username ? "@"+a.username : "id "+a.tg_user_id}`));
      }
      if (!admins.length && !auth.length) parts.push("\n<i>Chưa có ai khác.</i>");
      return parts.join("\n");
    }

    case "deleteuseradmin": {
      if (!callerIsAdmin) return null;
      if (!arg) return "⚠️ Cú pháp: <code>/deleteuseradmin @user</code>";
      const raw = arg.trim().replace(/^@/, "");
      let removed = 0;
      if (/^-?\d+$/.test(raw)) {
        removed += db.prepare("DELETE FROM account_admins WHERE account_id=? AND tg_user_id=?").run(accountId, Number(raw)).changes;
        removed += db.prepare("DELETE FROM account_authorized_users WHERE account_id=? AND tg_user_id=?").run(accountId, Number(raw)).changes;
      } else {
        removed += db.prepare("DELETE FROM account_admins WHERE account_id=? AND LOWER(IFNULL(username,''))=?").run(accountId, raw.toLowerCase()).changes;
        removed += db.prepare("DELETE FROM account_authorized_users WHERE account_id=? AND LOWER(IFNULL(username,''))=?").run(accountId, raw.toLowerCase()).changes;
      }
      return removed ? `🗑️ Đã thu hồi quyền của <b>${arg}</b> (${removed} mục).` : `❌ Không tìm thấy <b>${arg}</b>.`;
    }

    case "adduser_target": // alias bí mật, không dùng
    case "addtarget": {
      const u = normUser(arg);
      if (!u) return "⚠️ Cú pháp: <code>/addtarget @user</code> hoặc link, hoặc <code>me</code> cho Saved Messages.";
      if (st.users.includes(u)) return `ℹ️ <b>${u}</b> đã có trong danh sách.`;
      st.users.push(u);
      saveState(db, accountId, { users: st.users });
      return `✅ Đã add target <b>${u}</b>. Tổng: ${st.users.length}.`;
    }

    case "addchannel": {
      const c = normChannel(arg);
      if (!c) return "⚠️ Cú pháp: <code>/addchannel https://t.me/...</code> hoặc <code>me</code>.";
      if (st.channels.includes(c)) return `ℹ️ <b>${c}</b> đã có.`;
      st.channels.push(c);
      saveState(db, accountId, { channels: st.channels });
      return `✅ Đã add channel <b>${c}</b>. Tổng: ${st.channels.length}.`;
    }

    case "checkuser":
      if (!st.users.length) return "📭 Danh sách user rỗng.";
      return "👥 <b>USER ĐÃ ADD</b>\n" + st.users.map((u, i) => `${i + 1}. ${u}`).join("\n");

    case "checkchannel":
      if (!st.channels.length) return "📭 Danh sách channel rỗng.";
      return "📢 <b>CHANNEL/NHÓM</b>\n" + st.channels.map((c, i) => `${i + 1}. ${c}`).join("\n");

    case "delete": {
      if (!arg) return "⚠️ Cú pháp: <code>/delete @user</code> hoặc <code>/delete link</code>";
      const before = st.users.length + st.channels.length;
      const u = normUser(arg);
      st.users = st.users.filter(x => x !== u && x !== arg);
      st.channels = st.channels.filter(x => x !== arg && x !== u);
      const removed = before - (st.users.length + st.channels.length);
      saveState(db, accountId, { users: st.users, channels: st.channels });
      return removed ? `🗑️ Đã xoá ${removed} mục khớp <b>${arg}</b>.` : `❌ Không tìm thấy <b>${arg}</b>.`;
    }

    case "inuser": {
      if (!arg) { saveState(db, accountId, { in_user: null }); return "🔄 Bỏ in_user."; }
      const u = normUser(arg);
      saveState(db, accountId, { in_user: u });
      return `🎯 Bot chỉ rải tới user: <b>${u}</b>.`;
    }

    case "inchannel": {
      if (!arg) { saveState(db, accountId, { in_channel: null }); return "🔄 Bỏ in_channel."; }
      const c = normChannel(arg);
      saveState(db, accountId, { in_channel: c });
      return `🎯 Bot chỉ rải tới kênh/nhóm: <b>${c}</b>.`;
    }

    case "run": {
      const targets = pickTargets(st);
      if (!st.contents.length) return "⚠️ Chưa có nội dung. Dùng /addcmt hoặc /addlist.";
      if (!targets.length) return "⚠️ Chưa có target. Dùng /addtarget /addchannel hoặc /inuser /inchannel (<code>me</code> = Saved Messages).";
      saveState(db, accountId, { running: 1, idx: 0, last_round_at: 0 });
      return `🚀 <b>ĐANG CHẠY</b>\n• Nội dung: ${st.contents.length}\n• Target: ${targets.length}\n• Delay vòng: ${st.delay1}s\n• Delay target: ${st.delay2}s`;
    }
    case "stop":
      saveState(db, accountId, { running: 0 });
      return "🛑 Đã dừng rải.";

    case "addcmt": {
      if (!arg) return "⚠️ Cú pháp: <code>/addcmt nội dung</code>";
      st.contents.push(arg);
      saveState(db, accountId, { contents: st.contents });
      return `✅ Đã thêm nội dung #${st.contents.length}.`;
    }

    case "addlist": {
      if (!arg) return "⚠️ Cú pháp: <code>/addlist nd1 | nd2 | nd3</code>";
      const items = arg.split("|").map(s => s.trim()).filter(Boolean);
      if (!items.length) return "⚠️ Không có nội dung hợp lệ.";
      st.contents = st.contents.concat(items);
      saveState(db, accountId, { contents: st.contents });
      return `✅ Đã thêm ${items.length} nội dung. Tổng: ${st.contents.length}.`;
    }

    case "listcmt": {
      if (!st.contents.length) return "📭 Chưa có nội dung nào.";
      const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return "📝 <b>NỘI DUNG</b>\n" + st.contents.map((c, i) => `${i + 1}. ${esc(c)}`).join("\n");
    }

    case "deletecmt": {
      const n = parseInt(arg, 10);
      if (!arg || Number.isNaN(n) || n < 1) return "⚠️ Cú pháp: <code>/deletecmt 1</code>";
      if (n > st.contents.length) return `❌ Chỉ có ${st.contents.length} nội dung.`;
      const removed = st.contents.splice(n - 1, 1)[0];
      saveState(db, accountId, { contents: st.contents, idx: 0 });
      const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return `🗑️ Đã xoá #${n}: <i>${esc(removed)}</i>\nCòn lại: ${st.contents.length}.`;
    }

    case "delete-allcmt":
    case "deleteallcmt": {
      const count = st.contents.length;
      if (!count) return "📭 Vốn đã rỗng.";
      saveState(db, accountId, { contents: [], idx: 0 });
      return `🧹 Đã xoá ${count} nội dung.`;
    }

    case "delay1": {
      const n = Math.max(0, Number(arg));
      if (Number.isNaN(n)) return "⚠️ Cú pháp: <code>/delay1 5</code>";
      saveState(db, accountId, { delay1: n });
      return `⏱️ Delay vòng = <b>${n}s</b>.`;
    }
    case "delay2": {
      const n = Math.max(0, Number(arg));
      if (Number.isNaN(n)) return "⚠️ Cú pháp: <code>/delay2 1</code>";
      saveState(db, accountId, { delay2: n });
      return `⏱️ Delay target = <b>${n}s</b>.`;
    }

    case "liston": {
      const targets = pickTargets(st);
      return [
        "📊 <b>TRẠNG THÁI</b>",
        `• Running: ${st.running ? "🟢 ON" : "🔴 OFF"}`,
        `• Nội dung: ${st.contents.length}`,
        `• User đã add: ${st.users.length}`,
        `• Channel đã add: ${st.channels.length}`,
        `• in_user: ${st.in_user || "—"}`,
        `• in_channel: ${st.in_channel || "—"}`,
        `• Target hiệu lực: ${targets.length}`,
        `• Delay vòng: ${st.delay1}s · Delay target: ${st.delay2}s`,
      ].join("\n");
    }

    default:
      return null;
  }
}

function pickTargets(st) {
  if (st.in_user) return [st.in_user];
  if (st.in_channel) return [st.in_channel];
  return [].concat(st.users, st.channels);
}

// ---------- Attach handler ----------
function attachCommandHandler(db, accountId, client, opts = {}) {
  ensureSchema(db);
  getOrCreateAdminKey(db, accountId); // ensure key tồn tại

  let ownerTgId = opts.ownerTgId || null;
  // cố gắng resolve owner id nếu chưa biết
  (async () => {
    try {
      const me = await client.getMe();
      ownerTgId = Number(me?.id?.value ?? me?.id ?? 0) || null;
    } catch {}
  })();

  const handler = async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const text = msg.message || "";
      if (!text.startsWith("/")) return;

      const isOut = !!msg.out;
      // sender info
      let fromId = null, fromUsername = null, fromFirstName = null;
      try {
        const sender = await msg.getSender();
        fromId = Number(sender?.id?.value ?? sender?.id ?? 0) || null;
        fromUsername = sender?.username || null;
        fromFirstName = sender?.firstName || null;
      } catch {}
      if (isOut && ownerTgId) fromId = ownerTgId;

      const ctx = { fromId, fromUsername, fromFirstName, isOwner: isOut, ownerTgId };
      const reply = buildReply(db, accountId, text, ctx);
      if (!reply) return;

      // Outgoing → edit; Incoming → reply
      if (isOut) {
        try {
          await client.editMessage(msg.peerId, { message: msg.id, text: reply, parseMode: "html" });
        } catch {
          try { await client.sendMessage(msg.peerId, { message: reply, parseMode: "html", replyTo: msg.id }); } catch {}
        }
      } else {
        try { await client.sendMessage(msg.peerId, { message: reply, parseMode: "html", replyTo: msg.id }); } catch (e) {
          console.error(`[ub#${accountId}] reply incoming:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[ub#${accountId}] handler:`, e.message);
    }
  };

  // Lắng cả outgoing (owner) và incoming (admin / authorized user)
  client.addEventHandler(handler, new NewMessage({}));
  return handler;
}

// ---------- Runner tick ----------
const runnerLocks = new Map();

async function resolveTarget(client, raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (isSavedTarget(s) || s === "me") {
    try { return await client.getMe(); } catch { return null; }
  }
  if (/^-?\d+$/.test(s)) {
    try { return await client.getEntity(Number(s)); } catch {}
  }
  const invite = s.match(/(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
  if (invite) {
    try {
      const upd = await client.invoke(new Api.messages.ImportChatInvite({ hash: invite[1] }));
      const chats = upd?.chats || [];
      if (chats.length) return chats[0];
    } catch (e) {
      const m = String(e.errorMessage || e.message || "");
      if (!/USER_ALREADY_PARTICIPANT|already/i.test(m)) throw e;
    }
    try { return await client.getEntity(s); } catch {}
  }
  const pub = s.match(/(?:t\.me|telegram\.me)\/@?([A-Za-z0-9_]{3,})/i) || s.match(/^@?([A-Za-z0-9_]{3,})$/);
  if (pub) {
    const handle = "@" + pub[1];
    try { await client.invoke(new Api.channels.JoinChannel({ channel: handle })); } catch {}
    try { return await client.getEntity(handle); } catch {
      try { return await client.getEntity(pub[1]); } catch {}
    }
  }
  try { return await client.getEntity(s); } catch { return null; }
}

async function tickRunner(db, liveAccounts, startAccountClient) {
  ensureSchema(db);
  const rows = db.prepare("SELECT * FROM account_cmd_state WHERE running=1").all();
  for (const row of rows) {
    let live = liveAccounts.get(row.account_id);
    // v5.9: nếu chưa live mà state.running=1 → tự khởi động (bot rải kể cả khi user tắt/active=0)
    if (!live && typeof startAccountClient === "function") {
      const accRow = db.prepare("SELECT * FROM user_accounts WHERE id=?").get(row.account_id);
      if (accRow) { try { live = await startAccountClient(accRow); } catch {} }
    }
    if (!live) continue;
    if (runnerLocks.get(row.account_id)) continue;
    const st = getState(db, row.account_id);
    if (!st.contents.length) continue;
    const targets = pickTargets(st);
    if (!targets.length) continue;
    const wait = Math.max(0, Number(st.delay1) || 0) * 1000;
    if (Date.now() - (Number(st.last_round_at) || 0) < wait) continue;

    runnerLocks.set(row.account_id, true);
    (async () => {
      try {
        const content = st.contents[st.idx % st.contents.length];
        const tgap = Math.max(0, Number(st.delay2) || 0) * 1000;
        for (const t of targets) {
          try {
            const entity = await resolveTarget(live.client, t);
            if (!entity) continue;
            await live.client.sendMessage(entity, { message: content, parseMode: "html" });
          } catch (e) {
            console.error(`[ub#${row.account_id}] send ${t}:`, e.errorMessage || e.message);
          }
          if (tgap) await new Promise(r => setTimeout(r, tgap));
        }
        const newIdx = (Number(st.idx) + 1) % st.contents.length;
        saveState(db, row.account_id, { idx: newIdx, last_round_at: Date.now() });
      } catch (e) {
        console.error(`[ub#${row.account_id}] runner:`, e.message);
      } finally {
        runnerLocks.delete(row.account_id);
      }
    })();
  }
}

module.exports = {
  ensureSchema, attachCommandHandler, tickRunner,
  // Web API helpers:
  getOrCreateAdminKey, setAdminKey, listAdmins,
};
