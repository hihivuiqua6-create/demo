// v5.9 — Userbot in-chat commands + Anti-spam auto-delete + Call-spam
// Acc đã đăng nhập sẽ tự nhận lệnh outgoing và tự xoá tin spam incoming.
"use strict";

const { Api } = require("telegram");
const { NewMessage } = require("telegram/events");
const bigInt = require("big-integer");

// ---- DB schema (lazy, gọi 1 lần khi require) ----
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
      antispam_on INTEGER DEFAULT 0,
      antispam_all INTEGER DEFAULT 0,
      antispam_list TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // migrations cho user đang nâng cấp từ v5.7/5.8
  const cols = ["antispam_on INTEGER DEFAULT 0", "antispam_all INTEGER DEFAULT 0", "antispam_list TEXT DEFAULT '[]'"];
  for (const c of cols) {
    try { db.exec(`ALTER TABLE account_cmd_state ADD COLUMN ${c}`); } catch {}
  }
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
    antispam_list: JSON.parse(row.antispam_list || "[]"),
  };
}

function saveState(db, accountId, patch) {
  const allowed = ["users","channels","in_user","in_channel","contents","delay1","delay2","running","idx","last_round_at","antispam_on","antispam_all","antispam_list"];
  const jsonCols = new Set(["users","channels","contents","antispam_list"]);
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (jsonCols.has(k)) {
      sets.push(`${k}=?`); vals.push(JSON.stringify(patch[k] || []));
    } else {
      sets.push(`${k}=?`); vals.push(patch[k]);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at=CURRENT_TIMESTAMP");
  vals.push(accountId);
  db.prepare(`UPDATE account_cmd_state SET ${sets.join(",")} WHERE account_id=?`).run(...vals);
}

// ---------- Helpers ----------
function normUser(s) {
  s = String(s || "").trim();
  if (!s) return null;
  if (/^https?:\/\/(t|telegram)\.me\/@?([A-Za-z0-9_]{3,32})/i.test(s)) {
    return "@" + s.match(/(?:t|telegram)\.me\/@?([A-Za-z0-9_]{3,32})/i)[1];
  }
  if (/^@?[A-Za-z0-9_]{3,32}$/.test(s)) return "@" + s.replace(/^@/, "");
  if (/^-?\d+$/.test(s)) return s;
  return s;
}
function normChannel(s) { return String(s || "").trim(); }

const HELP = [
  "🤖 <b>USERBOT COMMAND PANEL v5.9</b>",
  "━━━━━━━━━━━━━━━━━━",
  "<b>📨 Rải tin</b>",
  "/adduser &lt;@user&gt;  ·  /addchannel &lt;link&gt;",
  "/checkuser  ·  /checkchannel  ·  /delete &lt;@user|link&gt;",
  "/inuser &lt;@user&gt;  ·  /inchannel &lt;link&gt;",
  "/addcmt &lt;nd&gt;  ·  /addlist &lt;nd1 | nd2&gt;",
  "/listcmt  ·  /deletecmt &lt;số&gt;  ·  /delete-allcmt",
  "/delay1 &lt;giây&gt;  ·  /delay2 &lt;giây&gt;",
  "/run  ·  /stop  ·  /liston",
  "",
  "<b>🛡️ Anti-spam (tự xoá tin người đối diện)</b>",
  "/antispam on|off — bật/tắt anti-spam",
  "/antispam-all on|off — xoá MỌI tin incoming (mạnh tay)",
  "/antispam-add &lt;@user|id&gt; — thêm vào blacklist",
  "/antispam-del &lt;@user|id&gt; — bỏ khỏi blacklist",
  "/antispam-list — xem blacklist",
  "/antispam-clear — xoá toàn bộ blacklist",
  "",
  "<b>📞 Call-spam (gọi & dập máy)</b>",
  "/call &lt;@user&gt; &lt;số_lần&gt; &lt;delay_giây&gt; — gọi & cúp ngay",
  "/callstop — dừng call-spam đang chạy",
  "",
  "/list — hiện full lệnh",
].join("\n");

// Trả về text reply hoặc null nếu không xử lý
function buildReply(db, accountId, raw, ctx) {
  const text = String(raw || "").trim();
  if (!text.startsWith("/")) return null;
  const m = text.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();
  const st = getState(db, accountId);

  switch (cmd) {
    case "list":
    case "help":
      return HELP;

    case "adduser": {
      const u = normUser(arg);
      if (!u) return "⚠️ Cú pháp: <code>/adduser @username</code>";
      if (st.users.includes(u)) return `ℹ️ <b>${u}</b> đã có trong danh sách.`;
      st.users.push(u);
      saveState(db, accountId, { users: st.users });
      return `✅ Đã add user <b>${u}</b>. Tổng: ${st.users.length}.`;
    }

    case "addchannel": {
      const c = normChannel(arg);
      if (!c) return "⚠️ Cú pháp: <code>/addchannel https://t.me/...</code>";
      if (st.channels.includes(c)) return `ℹ️ <b>${c}</b> đã có trong danh sách.`;
      st.channels.push(c);
      saveState(db, accountId, { channels: st.channels });
      return `✅ Đã add channel <b>${c}</b>. Tổng: ${st.channels.length}.`;
    }

    case "checkuser":
      if (!st.users.length) return "📭 Danh sách user rỗng.";
      return "👥 <b>USER ĐÃ ADD</b>\n" + st.users.map((u, i) => `${i + 1}. ${u}`).join("\n");

    case "checkchannel":
      if (!st.channels.length) return "📭 Danh sách channel rỗng.";
      return "📢 <b>CHANNEL/NHÓM ĐÃ ADD</b>\n" + st.channels.map((c, i) => `${i + 1}. ${c}`).join("\n");

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
      if (!arg) { saveState(db, accountId, { in_user: null }); return "🔄 Đã bỏ <b>in_user</b>."; }
      const u = normUser(arg); saveState(db, accountId, { in_user: u });
      return `🎯 Bot chỉ rải tới user: <b>${u}</b>.`;
    }
    case "inchannel": {
      if (!arg) { saveState(db, accountId, { in_channel: null }); return "🔄 Đã bỏ <b>in_channel</b>."; }
      const c = normChannel(arg); saveState(db, accountId, { in_channel: c });
      return `🎯 Bot chỉ rải tới kênh/nhóm: <b>${c}</b>.`;
    }

    case "run": {
      const targets = pickTargets(st);
      if (!st.contents.length) return "⚠️ Chưa có nội dung. Dùng <code>/addcmt</code> hoặc <code>/addlist</code>.";
      if (!targets.length) return "⚠️ Chưa có target. Dùng <code>/adduser</code>/<code>/addchannel</code>.";
      saveState(db, accountId, { running: 1, idx: 0, last_round_at: 0 });
      return `🚀 <b>ĐANG CHẠY</b>\n• Nội dung: ${st.contents.length}\n• Target: ${targets.length}\n• Delay vòng: ${st.delay1}s\n• Delay target: ${st.delay2}s`;
    }
    case "stop":
      saveState(db, accountId, { running: 0 });
      return "🛑 Đã dừng rải.";

    case "addcmt": {
      if (!arg) return "⚠️ Cú pháp: <code>/addcmt nội dung cần rải</code>";
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
      return "📝 <b>NỘI DUNG ĐÃ ADD</b>\n" + st.contents.map((c, i) => `${i + 1}. ${esc(c)}`).join("\n");
    }
    case "deletecmt": {
      const n = parseInt(arg, 10);
      if (!arg || Number.isNaN(n) || n < 1) return "⚠️ Cú pháp: <code>/deletecmt 1</code>";
      if (n > st.contents.length) return `❌ Chỉ có ${st.contents.length} nội dung.`;
      const removed = st.contents.splice(n - 1, 1)[0];
      saveState(db, accountId, { contents: st.contents, idx: 0 });
      const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return `🗑️ Đã xoá nội dung #${n}: <i>${esc(removed)}</i>\nCòn lại: ${st.contents.length}.`;
    }
    case "delete-allcmt":
    case "deleteallcmt": {
      const count = st.contents.length;
      if (!count) return "📭 Danh sách nội dung vốn đã rỗng.";
      saveState(db, accountId, { contents: [], idx: 0 });
      return `🧹 Đã xoá toàn bộ <b>${count}</b> nội dung rải.`;
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
        `• User add: ${st.users.length} · Channel add: ${st.channels.length}`,
        `• in_user: ${st.in_user || "—"} · in_channel: ${st.in_channel || "—"}`,
        `• Target hiệu lực: ${targets.length}`,
        `• Delay vòng: ${st.delay1}s · Delay target: ${st.delay2}s`,
        `• Anti-spam: ${st.antispam_on ? "🛡️ ON" : "OFF"}${st.antispam_all ? " (ALL)" : ""} · Blacklist: ${st.antispam_list.length}`,
      ].join("\n");
    }

    // ===== ANTI-SPAM =====
    case "antispam": {
      const v = arg.toLowerCase();
      if (v !== "on" && v !== "off") return "⚠️ Cú pháp: <code>/antispam on|off</code>";
      saveState(db, accountId, { antispam_on: v === "on" ? 1 : 0 });
      return v === "on"
        ? "🛡️ Anti-spam <b>BẬT</b>. Mọi tin từ ID trong blacklist sẽ tự xoá ngay."
        : "🛡️ Anti-spam <b>TẮT</b>.";
    }
    case "antispam-all":
    case "antispamall": {
      const v = arg.toLowerCase();
      if (v !== "on" && v !== "off") return "⚠️ Cú pháp: <code>/antispam-all on|off</code>";
      saveState(db, accountId, { antispam_all: v === "on" ? 1 : 0, antispam_on: v === "on" ? 1 : st.antispam_on });
      return v === "on"
        ? "🛡️ Anti-spam ALL <b>BẬT</b>. Mọi tin incoming trong DM sẽ tự xoá. Cẩn thận!"
        : "🛡️ Anti-spam ALL <b>TẮT</b>.";
    }
    case "antispam-add":
    case "antispamadd": {
      if (!arg) return "⚠️ Cú pháp: <code>/antispam-add @user</code> hoặc id";
      const u = normUser(arg);
      if (st.antispam_list.includes(u)) return `ℹ️ <b>${u}</b> đã có trong blacklist.`;
      st.antispam_list.push(u);
      saveState(db, accountId, { antispam_list: st.antispam_list, antispam_on: 1 });
      return `🚫 Đã thêm <b>${u}</b>. Blacklist: ${st.antispam_list.length}. Anti-spam đã bật.`;
    }
    case "antispam-del":
    case "antispamdel": {
      if (!arg) return "⚠️ Cú pháp: <code>/antispam-del @user</code>";
      const u = normUser(arg);
      const before = st.antispam_list.length;
      st.antispam_list = st.antispam_list.filter(x => x !== u && x !== arg);
      saveState(db, accountId, { antispam_list: st.antispam_list });
      return before === st.antispam_list.length
        ? `❌ Không thấy <b>${u}</b>.`
        : `✅ Đã bỏ <b>${u}</b>. Còn lại: ${st.antispam_list.length}.`;
    }
    case "antispam-list":
    case "antispamlist": {
      if (!st.antispam_list.length) return "📭 Blacklist rỗng.";
      return "🚫 <b>BLACKLIST</b>\n" + st.antispam_list.map((u, i) => `${i + 1}. ${u}`).join("\n");
    }
    case "antispam-clear":
    case "antispamclear": {
      const n = st.antispam_list.length;
      saveState(db, accountId, { antispam_list: [] });
      return `🧹 Đã xoá ${n} mục khỏi blacklist.`;
    }

    // ===== CALL-SPAM =====
    case "call": {
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length < 1) return "⚠️ Cú pháp: <code>/call @user [số_lần] [delay_giây]</code>";
      const target = parts[0];
      const count = Math.max(1, Math.min(50, parseInt(parts[1] || "1", 10) || 1));
      const delay = Math.max(0.5, Number(parts[2] || "1.5"));
      if (ctx && ctx.scheduleCallSpam) {
        ctx.scheduleCallSpam({ accountId, target, count, delay });
        return `📞 Đã lên lịch gọi <b>${target}</b>: ${count} lần, mỗi lần cách ${delay}s. Sẽ cúp máy ngay khi đổ chuông.`;
      }
      return "⚠️ Call-spam chưa khởi tạo cho acc này.";
    }
    case "callstop": {
      if (ctx && ctx.stopCallSpam) {
        const n = ctx.stopCallSpam(accountId);
        return n ? `🛑 Đã dừng ${n} job call-spam.` : "ℹ️ Không có job call-spam nào đang chạy.";
      }
      return "⚠️ Call-spam chưa khởi tạo.";
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

// ---------- Call-spam runner ----------
const callJobs = new Map(); // accountId -> array of timers

function scheduleCallSpamFor(accountId, client) {
  return ({ target, count, delay }) => {
    (async () => {
      const list = callJobs.get(accountId) || [];
      for (let i = 0; i < count; i++) {
        try {
          const entity = await resolveTarget(client, target);
          if (!entity) { console.error(`[call#${accountId}] entity not found: ${target}`); break; }
          if (entity.broadcast || entity.megagroup || entity.title) {
            console.error(`[call#${accountId}] ${target} không phải user, bỏ qua.`);
            break;
          }
          await placeCallAndHangup(client, entity);
        } catch (e) {
          console.error(`[call#${accountId}] err:`, e.errorMessage || e.message);
        }
        if (i < count - 1) await new Promise(r => setTimeout(r, Math.max(500, delay * 1000)));
        if (callJobs.get(accountId) === null) break; // stop signal
      }
      callJobs.delete(accountId);
    })();
    callJobs.set(accountId, []);
  };
}

function stopCallSpamFor(accountId) {
  const had = callJobs.has(accountId);
  callJobs.set(accountId, null);
  setTimeout(() => callJobs.delete(accountId), 50);
  return had ? 1 : 0;
}

async function placeCallAndHangup(client, userEntity) {
  // Tạo random g_a_hash rỗng để request call, rồi discard ngay.
  const randomId = Math.floor(Math.random() * 2147483647);
  const gAHash = Buffer.alloc(32, 0);
  let phoneCall;
  try {
    const res = await client.invoke(new Api.phone.RequestCall({
      userId: userEntity,
      randomId,
      gAHash,
      protocol: new Api.PhoneCallProtocol({
        udpP2p: true, udpReflector: true,
        minLayer: 65, maxLayer: 92,
        libraryVersions: ["2.4.4"],
      }),
    }));
    phoneCall = res.phoneCall;
  } catch (e) {
    throw e;
  }
  // Dập ngay
  try {
    await client.invoke(new Api.phone.DiscardCall({
      peer: new Api.InputPhoneCall({
        id: phoneCall.id,
        accessHash: phoneCall.accessHash,
      }),
      duration: 0,
      reason: new Api.PhoneCallDiscardReasonHangup(),
      connectionId: bigInt(0),
    }));
  } catch {}
}

// ---------- Anti-spam handler ----------
function senderIdMatchesBlacklist(senderId, username, list) {
  if (!list || !list.length) return false;
  const idStr = String(senderId || "");
  const uName = username ? "@" + username.toLowerCase() : null;
  for (const item of list) {
    const it = String(item).trim();
    if (!it) continue;
    if (/^-?\d+$/.test(it) && it === idStr) return true;
    if (uName && it.toLowerCase() === uName) return true;
    if (it.toLowerCase().replace(/^@/, "") === (username || "").toLowerCase() && username) return true;
  }
  return false;
}

// ---------- Attach handler to TelegramClient ----------
function attachCommandHandler(db, accountId, client) {
  ensureSchema(db);

  const ctx = {
    scheduleCallSpam: scheduleCallSpamFor(accountId, client),
    stopCallSpam: stopCallSpamFor,
  };

  // 1) Outgoing — handler lệnh
  const outHandler = async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.out) return;
      const text = msg.message || "";
      if (!text.startsWith("/")) return;
      const reply = buildReply(db, accountId, text, ctx);
      if (!reply) return;
      try {
        await client.editMessage(msg.peerId, { message: msg.id, text: reply, parseMode: "html" });
      } catch {
        try {
          await client.sendMessage(msg.peerId, { message: reply, parseMode: "html", replyTo: msg.id });
        } catch (ee) { console.error(`[ub#${accountId}] reply fail:`, ee.message); }
      }
    } catch (e) {
      console.error(`[ub#${accountId}] out handler:`, e.message);
    }
  };

  // 2) Incoming — anti-spam auto-delete
  const inHandler = async (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.out) return;
      const st = getState(db, accountId);
      if (!st.antispam_on) return;

      // Chỉ xử lý private chat (DM). Anti-spam ALL = mọi DM. Có blacklist = chỉ DM từ ID/username trong list.
      const peer = msg.peerId;
      const isUserPeer = peer && peer.className === "PeerUser";
      if (!isUserPeer) return;

      let senderUsername = null;
      try {
        const sender = await msg.getSender();
        if (sender && sender.username) senderUsername = sender.username;
      } catch {}

      const senderId = (peer && peer.userId) ? String(peer.userId) : null;

      const shouldDelete = st.antispam_all
        || senderIdMatchesBlacklist(senderId, senderUsername, st.antispam_list);
      if (!shouldDelete) return;

      try {
        await client.deleteMessages(peer, [msg.id], { revoke: true });
      } catch (e) {
        // revoke fail → xoá phía mình
        try { await client.deleteMessages(peer, [msg.id], { revoke: false }); } catch {}
      }
    } catch (e) {
      console.error(`[ub#${accountId}] antispam:`, e.message);
    }
  };

  client.addEventHandler(outHandler, new NewMessage({ outgoing: true, incoming: false }));
  client.addEventHandler(inHandler, new NewMessage({ outgoing: false, incoming: true }));

  return { outHandler, inHandler };
}

// ---------- Runner tick ----------
const runnerLocks = new Map();

async function resolveTarget(client, raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
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

async function tickRunner(db, liveAccounts) {
  ensureSchema(db);
  const rows = db.prepare("SELECT * FROM account_cmd_state WHERE running=1").all();
  for (const row of rows) {
    const live = liveAccounts.get(row.account_id);
    if (!live) continue;
    // v5.9: chỉ skip nếu client thực sự không kết nối; runner vẫn giữ trạng thái running để
    // ngay khi reconnect xong là rải tiếp ("rải off telegram nó vẫn cứ rải").
    if (live.client && live.client.connected === false) continue;
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

module.exports = { ensureSchema, attachCommandHandler, tickRunner };
