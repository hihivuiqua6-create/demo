// src/services/botManager.js
const TelegramBot = require('node-telegram-bot-api');
const { botQueries, userQueries, analyticsQueries, webhookQueries } = require('../models/database');
const axios = require('axios').default || require('https');

class BotManager {
  constructor() {
    this.bots = new Map(); // botId => TelegramBot instance
  }

  // Lấy thông tin bot từ Telegram API
  async validateToken(token) {
    try {
      const tempBot = new TelegramBot(token);
      const info = await tempBot.getMe();
      return { valid: true, info };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  // Khởi động 1 bot
  async startBot(botRecord) {
    if (this.bots.has(botRecord.id)) {
      console.log(`Bot ${botRecord.id} already running`);
      return true;
    }

    try {
      const bot = new TelegramBot(botRecord.token, { polling: true });

      // Handler /start
      bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const user = msg.from;

        // Track user
        try {
          userQueries.upsert.run({
            bot_id: botRecord.id,
            telegram_user_id: user.id,
            username: user.username || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null,
            language_code: user.language_code || null,
          });

          analyticsQueries.insert.run({
            bot_id: botRecord.id,
            event_type: 'start',
            telegram_user_id: user.id,
            metadata: JSON.stringify({ username: user.username }),
          });
        } catch (e) { /* ignore db errors */ }

        // Lấy thông tin bot mới nhất từ DB (có thể đã update web_url)
        const freshBot = botQueries.findById.get(botRecord.id);
        const welcomeMsg = freshBot?.welcome_message || botRecord.welcome_message;
        const buttonText = freshBot?.button_text || botRecord.button_text;
        const webUrl = freshBot?.web_url || botRecord.web_url;

        const opts = {
          reply_markup: {
            inline_keyboard: [[
              {
                text: buttonText || '🚀 Mở Mini App',
                web_app: { url: webUrl }
              }
            ]]
          },
          parse_mode: 'HTML'
        };

        await bot.sendMessage(chatId, welcomeMsg || 'Xin chào! Nhấn nút bên dưới để mở ứng dụng.', opts);

        // Trigger webhook
        this._triggerWebhook(botRecord.id, 'user_start', { user_id: user.id, username: user.username });
      });

      // Handler /help
      bot.onText(/\/help/, async (msg) => {
        const chatId = msg.chat.id;
        const freshBot = botQueries.findById.get(botRecord.id);
        const webUrl = freshBot?.web_url || botRecord.web_url;
        const buttonText = freshBot?.button_text || botRecord.button_text;

        await bot.sendMessage(chatId, '📱 Nhấn nút bên dưới để mở ứng dụng:', {
          reply_markup: {
            inline_keyboard: [[
              { text: buttonText || '🚀 Mở Mini App', web_app: { url: webUrl } }
            ]]
          }
        });
      });

      // Handler mọi tin nhắn khác
      bot.on('message', async (msg) => {
        if (msg.text && (msg.text.startsWith('/start') || msg.text.startsWith('/help'))) return;

        try {
          analyticsQueries.insert.run({
            bot_id: botRecord.id,
            event_type: 'message',
            telegram_user_id: msg.from?.id || null,
            metadata: JSON.stringify({ type: msg.document ? 'document' : 'text' }),
          });
        } catch (e) {}
      });

      // Handler web_app_data (data gửi từ Mini App về bot)
      bot.on('web_app_data', async (msg) => {
        const chatId = msg.chat.id;
        const data = msg.web_app_data?.data;

        try {
          analyticsQueries.insert.run({
            bot_id: botRecord.id,
            event_type: 'webapp_data',
            telegram_user_id: msg.from?.id || null,
            metadata: data,
          });
        } catch (e) {}

        this._triggerWebhook(botRecord.id, 'webapp_data', {
          user_id: msg.from?.id,
          data: data
        });
      });

      bot.on('polling_error', (error) => {
        console.error(`Bot ${botRecord.id} polling error:`, error.message);
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          this.stopBot(botRecord.id);
        }
      });

      this.bots.set(botRecord.id, bot);
      console.log(`✅ Bot started: ${botRecord.bot_username || botRecord.id}`);
      return true;
    } catch (err) {
      console.error(`❌ Failed to start bot ${botRecord.id}:`, err.message);
      return false;
    }
  }

  // Dừng 1 bot
  async stopBot(botId) {
    const bot = this.bots.get(botId);
    if (bot) {
      try {
        await bot.stopPolling();
      } catch (e) {}
      this.bots.delete(botId);
      console.log(`🛑 Bot stopped: ${botId}`);
    }
  }

  // Khởi động tất cả bot active từ DB
  async startAllBots() {
    const bots = botQueries.findAll.all();
    let started = 0;
    for (const botRecord of bots) {
      if (botRecord.status === 'active') {
        const ok = await this.startBot(botRecord);
        if (ok) started++;
        // Delay nhỏ để tránh rate limit
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log(`🚀 Started ${started}/${bots.length} bots`);
  }

  // Gửi tin nhắn broadcast
  async broadcastToBot(botId, message, opts = {}) {
    const users = userQueries.findByBot.all(botId);
    const bot = this.bots.get(botId);
    if (!bot) return { sent: 0, failed: 0 };

    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        await bot.sendMessage(user.telegram_user_id, message, opts);
        sent++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        failed++;
      }
    }
    return { sent, failed };
  }

  isRunning(botId) {
    return this.bots.has(botId);
  }

  getRunningCount() {
    return this.bots.size;
  }

  // Trigger webhook cho external systems
  async _triggerWebhook(botId, event, data) {
    try {
      const webhooks = webhookQueries.findByBot.all(botId);
      for (const wh of webhooks) {
        const events = wh.events === 'all' ? null : wh.events.split(',');
        if (events && !events.includes(event)) continue;

        const payload = JSON.stringify({ event, bot_id: botId, data, timestamp: Date.now() });
        const headers = { 'Content-Type': 'application/json' };
        if (wh.secret) headers['X-Webhook-Secret'] = wh.secret;

        // Fire and forget
        fetch(wh.url, { method: 'POST', body: payload, headers }).catch(() => {});
      }
    } catch (e) {}
  }
}

module.exports = new BotManager();
