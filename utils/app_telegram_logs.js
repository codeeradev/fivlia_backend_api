const axios = require("axios");

const BOT_TOKEN = "8685766369:AAH-K2i16HL3XeXz7fZHwCGX0ofFjqkmvf8";
const CHAT_ID = "-5414335388";

async function appTelegramOrderLog(title, data = {}) {
  try {

    let text = `🚀 ${title}\n\n`;

    Object.entries(data).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        text += `• ${key}: ${value.join(", ")}\n`;
      } else if (typeof value === "object" && value !== null) {
        text += `• ${key}: ${JSON.stringify(value)}\n`;
      } else {
        text += `• ${key}: ${value}\n`;
      }
    });

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text
    });

  } catch (err) {
    console.error("Telegram Log Error:", err);
  }
}

module.exports = appTelegramOrderLog;