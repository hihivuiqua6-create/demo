// v5.7 — Userbot In-Chat Commands ("AI" controller)
// Acc đã đăng nhập sẽ tự nhận các lệnh KHI CHÍNH NÓ gõ ra (outgoing message).
// Lệnh được EDIT vào chính tin nhắn vừa gõ để phản hồi tức thời.
"use strict";

const { Api } = require("telegram");
const { NewMessage } = require("telegram/events");

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
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    if (["users","channels","contents"].includes(k)) {
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
function normChannel(s) {
  return String(s || "").trim();
}

const HELP = [
  "🤖 <b>USERBOT COMMAND PANEL</b>",
  "━━━━━━━━━━━━━━━━━━",
  "/list — Hiện toàn bộ lệnh",
  "/adduser &lt;@user&gt; — Add user vào danh sách rải",
  "/addchannel &lt;link&gt; — Add channel/group vào danh sách (tự join)",
  "/checkuser — Xem user đã add",
  "/checkchannel — Xem channel đã add",
  "/delete &lt;@user|link&gt; — Xoá khỏi danh sách",
  "/inuser &lt;@user&gt; — Mặc định CHỈ rải user này",
  "/inchannel &lt;link&gt; — Mặc định CHỈ rải nhóm/kênh này",
  "/run — Bắt đầu rải",
  "/stop — Dừng rải",
  "/addcmt &lt;nội dung&gt; — Thêm 1 nội dung",
  "/addlist &lt;nd1 | nd2 | nd3&gt; — Thêm nhiều nội dung (xoay vòng)",
  "/listcmt — Liệt kê nội dung đã add (kèm STT)",
  "/deletecmt &lt;số&gt; — Xoá nội dung theo STT (vd: /deletecmt 1)",
  "/delete-allcmt — Xoá toàn bộ nội dung rải",
  "/delay1 &lt;giây&gt; — Delay giữa các vòng (≥0)",
  "/delay2 &lt;giây&gt; — Delay giữa mỗi target (≥0)",
  "/liston — Xem trạng thái & cấu hình hiện tại",
].join("\n");

// Trả về text reply hoặc null nếu không xử lý
function buildReply(db, accountId, raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("/")) return null;
  const m = text.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();
  const st = getState(db, accountId);

  switch (cmd) {
    case "list":
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
      if (!arg) {
        saveState(db, accountId, { in_user: null });
        return "🔄 Đã bỏ <b>in_user</b>. Sẽ rải toàn bộ danh sách.";
      }
      const u = normUser(arg);
      saveState(db, accountId, { in_user: u });
      return `🎯 Bot chỉ rải tới user: <b>${u}</b>.`;
    }

    case "inchannel": {
      if (!arg) {
        saveState(db, accountId, { in_channel: null });
        return "🔄 Đã bỏ <b>in_channel</b>. Sẽ rải toàn bộ danh sách.";
      }
      const c = normChannel(arg);
      saveState(db, accountId, { in_channel: c });
      return `🎯 Bot chỉ rải tới kênh/nhóm: <b>${c}</b>.`;
    }

    case "run": {
      const targets = pickTargets(st);
      if (!st.contents.length) return "⚠️ Chưa có nội dung. Dùng <code>/addcmt</code> hoặc <code>/addlist</code>.";
      if (!targets.length) return "⚠️ Chưa có target. Dùng <code>/adduser</code> / <code>/addchannel</code> hoặc <code>/inuser</code> / <code>/inchannel</code>.";
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
      if (!st.contents.length) return "📭 Chưa có nội dung nào. Dùng <code>/addcmt</code> hoặc <code>/addlist</code>.";
      const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return "📝 <b>NỘI DUNG ĐÃ ADD</b>\n" +
        st.contents.map((c, i) => `${i + 1}. ${esc(c)}`).join("\n");
    }

    case "deletecmt": {
      const n = parseInt(arg, 10);
      if (!arg || Number.isNaN(n) || n < 1) return "⚠️ Cú pháp: <code>/deletecmt 1</code> (số thứ tự nội dung)";
      if (n > st.contents.length) return `❌ Chỉ có ${st.contents.length} nội dung, không có #${n}.`;
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

// ---------- Attach handler to TelegramClient ----------
function attachCommandHandler(db, accountId, client) {
  ensureSchema(db);

  const handler = async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.out) return; // chỉ tin do chính acc gửi
      const text = msg.message || "";
      if (!text.startsWith("/")) return;
      const reply = buildReply(db, accountId, text);
      if (!reply) return;
      // Cố gắng EDIT chính tin vừa gửi → phản hồi tức thì
      try {
        await client.editMessage(msg.peerId, { message: msg.id, text: reply, parseMode: "html" });
      } catch (e) {
        // Một số chat không cho edit → gửi reply mới
        try {
          await client.sendMessage(msg.peerId, { message: reply, parseMode: "html", replyTo: msg.id });
        } catch (ee) {
          console.error(`[ub#${accountId}] reply fail:`, ee.message);
        }
      }
    } catch (e) {
      console.error(`[ub#${accountId}] handler:`, e.message);
    }
  };

  client.addEventHandler(handler, new NewMessage({ outgoing: true, incoming: false }));
  return handler;
}

// ---------- Runner tick ----------
const runnerLocks = new Map(); // accountId -> bool

async function resolveTarget(client, raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // số → user id / chat id
  if (/^-?\d+$/.test(s)) {
    try { return await client.getEntity(Number(s)); } catch {}
  }
  // invite link private
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
  // public link / @username
  const pub = s.match(/(?:t\.me|telegram\.me)\/@?([A-Za-z0-9_]{3,})/i) || s.match(/^@?([A-Za-z0-9_]{3,})$/);
  if (pub) {
    const handle = "@" + pub[1];
    try { await client.invoke(new Api.channels.JoinChannel({ channel: handle })); }
    catch (e) {
      const m = String(e.errorMessage || e.message || "");
      if (!/USER_ALREADY_PARTICIPANT|already|CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|INVITE_REQUEST_SENT|CHAT_INVALID/i.test(m)) {
        // ignore — có thể là user thường, không phải channel
      }
    }
    try { return await client.getEntity(handle); } catch (e) {
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
