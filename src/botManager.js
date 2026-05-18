const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const path = require('path');
require('dotenv').config();

const activeBots = new Map();

function getBotBaseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

async function startBot(botRecord) {
  if (activeBots.has(botRecord.id)) {
    console.log(`Bot ${botRecord.username} already running`);
    return activeBots.get(botRecord.id);
  }

  try {
    const bot = new TelegramBot(botRecord.token, { polling: true });

    // /start command
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const user = msg.from;

      // Upsert user
      try {
        db.prepare(`
          INSERT INTO telegram_users (bot_id, telegram_id, username, first_name, last_name, language_code)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_id, telegram_id) DO UPDATE SET
            last_seen = CURRENT_TIMESTAMP,
            message_count = message_count + 1,
            username = excluded.username,
            first_name = excluded.first_name
        `).run(botRecord.id, user.id, user.username || '', user.first_name || '', user.last_name || '', user.language_code || '');
      } catch (e) {}

      // Log analytics
      db.prepare(`INSERT INTO analytics (bot_id, event_type, telegram_user_id) VALUES (?, 'start', ?)`)
        .run(botRecord.id, user.id);

      // Update bot last activity
      db.prepare(`UPDATE bots SET last_activity = CURRENT_TIMESTAMP WHERE id = ?`).run(botRecord.id);

      // Get default miniapp
      const defaultApp = db.prepare(`
        SELECT * FROM miniapps WHERE bot_id = ? AND is_default = 1 LIMIT 1
      `).get(botRecord.id);

      const allApps = db.prepare(`SELECT * FROM miniapps WHERE bot_id = ? ORDER BY is_default DESC`).all(botRecord.id);

      const welcomeMsg = botRecord.welcome_message || 'Chào mừng! Nhấn nút bên dưới để mở Mini App.';
      const btnText = botRecord.welcome_button_text || '🚀 Mở Mini App';

      if (allApps.length === 0) {
        // No miniapp uploaded yet
        bot.sendMessage(chatId,
          `👋 Xin chào ${user.first_name || 'bạn'}!\n\n${welcomeMsg}\n\n⚠️ Chưa có Mini App nào được tải lên. Vui lòng vào dashboard để upload HTML.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const appToOpen = defaultApp || allApps[0];
      const appUrl = `${getBotBaseUrl()}/app/${botRecord.id}/${appToOpen.id}`;

      const keyboard = {
        inline_keyboard: [[
          {
            text: btnText,
            web_app: { url: appUrl }
          }
        ]]
      };

      // Add more apps buttons if multiple
      if (allApps.length > 1) {
        allApps.slice(0, 5).forEach(app => {
          if (app.id !== appToOpen.id) {
            keyboard.inline_keyboard.push([{
              text: `📱 ${app.name}`,
              web_app: { url: `${getBotBaseUrl()}/app/${botRecord.id}/${app.id}` }
            }]);
          }
        });
      }

      bot.sendMessage(chatId,
        `👋 Xin chào <b>${user.first_name || 'bạn'}</b>!\n\n${welcomeMsg}`,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard
        }
      );
    });

    // Handle /apps command - list all apps
    bot.onText(/\/apps/, (msg) => {
      const chatId = msg.chat.id;
      const allApps = db.prepare(`SELECT * FROM miniapps WHERE bot_id = ?`).all(botRecord.id);

      if (allApps.length === 0) {
        bot.sendMessage(chatId, '❌ Chưa có Mini App nào.');
        return;
      }

      const keyboard = {
        inline_keyboard: allApps.map(app => [{
          text: `📱 ${app.name}`,
          web_app: { url: `${getBotBaseUrl()}/app/${botRecord.id}/${app.id}` }
        }])
      };

      bot.sendMessage(chatId, '📱 Danh sách Mini App:', { reply_markup: keyboard });
    });

    // Handle all messages for analytics
    bot.on('message', (msg) => {
      if (!msg.text?.startsWith('/')) {
        db.prepare(`INSERT INTO analytics (bot_id, event_type, telegram_user_id, data) VALUES (?, 'message', ?, ?)`)
          .run(botRecord.id, msg.from?.id, msg.text?.substring(0, 200) || '');
        db.prepare(`UPDATE bots SET last_activity = CURRENT_TIMESTAMP WHERE id = ?`).run(botRecord.id);
      }
    });

    // Handle web_app_data
    bot.on('message', (msg) => {
      if (msg.web_app_data) {
        db.prepare(`INSERT INTO analytics (bot_id, event_type, telegram_user_id, data) VALUES (?, 'webapp_data', ?, ?)`)
          .run(botRecord.id, msg.from?.id, msg.web_app_data.data?.substring(0, 500) || '');

        bot.sendMessage(msg.chat.id, `✅ Nhận dữ liệu từ Mini App:\n<code>${msg.web_app_data.data}</code>`, {
          parse_mode: 'HTML'
        });
      }
    });

    // Handle pre_checkout_query for payments
    bot.on('pre_checkout_query', (query) => {
      bot.answerPreCheckoutQuery(query.id, true);
    });

    bot.on('successful_payment', (msg) => {
      db.prepare(`INSERT INTO analytics (bot_id, event_type, telegram_user_id, data) VALUES (?, 'payment', ?, ?)`)
        .run(botRecord.id, msg.from?.id, JSON.stringify(msg.successful_payment));
      bot.sendMessage(msg.chat.id, '✅ Thanh toán thành công! Cảm ơn bạn.');
    });

    activeBots.set(botRecord.id, bot);
    console.log(`✅ Bot started: @${botRecord.username}`);
    return bot;
  } catch (err) {
    console.error(`❌ Failed to start bot ${botRecord.id}:`, err.message);
    throw err;
  }
}

async function stopBot(botId) {
  const bot = activeBots.get(botId);
  if (bot) {
    await bot.stopPolling();
    activeBots.delete(botId);
    console.log(`🛑 Bot ${botId} stopped`);
  }
}

async function restartBot(botId) {
  await stopBot(botId);
  const record = db.prepare(`SELECT * FROM bots WHERE id = ?`).get(botId);
  if (record) {
    await startBot(record);
  }
}

async function startAllBots() {
  const bots = db.prepare(`SELECT * FROM bots WHERE status = 'active'`).all();
  console.log(`🚀 Starting ${bots.length} bots...`);
  for (const bot of bots) {
    try {
      await startBot(bot);
    } catch (e) {
      console.error(`Failed to start bot ${bot.id}: ${e.message}`);
    }
  }
}

module.exports = { startBot, stopBot, restartBot, startAllBots, activeBots };
