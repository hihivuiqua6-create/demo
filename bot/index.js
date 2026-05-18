require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// dán TOKEN MỚI vào đây
const token = "7854245357:AAGUnxhw1737o-x4bqPL9DkxZjBDqKkxnic";

const bot = new TelegramBot(token,{
    polling:true
});

bot.onText(/\/start/, (msg)=>{

    bot.sendMessage(
        msg.chat.id,
        "🌸 Chào mừng tới bot",
        {
            reply_markup:{
                inline_keyboard:[
                    [
                        {
                            text:"🛒 Mở Shop",
                            web_app:{
                                url:"https://lucvi1k.gt.tc/index.php?p=home"
                            }
                        }
                    ],
                    [
                        {text:"🔑 Mua Key",callback_data:"buy"}
                    ],
                    [
                        {text:"💰 Nạp Tiền",callback_data:"nap"}
                    ],
                    [
                        {text:"👤 Cá Nhân",callback_data:"user"}
                    ]
                ]
            }
        }
    );

});

bot.on("callback_query",(q)=>{

    const map = {
        buy:"🔑 Trang mua key",
        nap:"💰 Trang nạp tiền",
        user:"👤 Hồ sơ cá nhân"
    };

    bot.sendMessage(
        q.message.chat.id,
        map[q.data] || "Đã bấm"
    );

    bot.answerCallbackQuery(q.id);

});

console.log("Bot running...");
