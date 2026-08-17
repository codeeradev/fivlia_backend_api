const axios = require("axios");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID =
  process.env.TELEGRAM_APP_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
const SEND_INTERVAL_MS = Number(
  process.env.TELEGRAM_APP_LOG_INTERVAL_MS || 3000,
);
const MAX_QUEUE_SIZE = Number(process.env.TELEGRAM_APP_LOG_MAX_QUEUE || 100);

// Queue
const queue = [];
let processing = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processQueue() {
  if (processing) return;

  processing = true;

  while (queue.length) {
    const { title, data } = queue.shift();

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

      await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: CHAT_ID,
          text,
        },
        { timeout: 5000 },
      );
    } catch (err) {
      const retryAfterSeconds = Number(
        err?.response?.data?.parameters?.retry_after || 0,
      );
      if (retryAfterSeconds > 0) {
        await sleep(retryAfterSeconds * 1000);
      }
      console.error(
        "Telegram Log Error:",
        err?.response?.data?.description || err.message,
      );
    }

    await sleep(SEND_INTERVAL_MS);
  }

  processing = false;
}

function appTelegramOrderLog(title, data = {}) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  if (queue.length >= MAX_QUEUE_SIZE) queue.shift();
  queue.push({ title, data });
  void processQueue();
}

module.exports = appTelegramOrderLog;
