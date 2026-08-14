const axios = require("axios");

const BOT_TOKEN = "8685766369:AAH-K2i16HL3XeXz7fZHwCGX0ofFjqkmvf8";
const CHAT_ID = "-1003983250616";

const isBlank = (value) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "");

const formatValue = (value) => {
  if (isBlank(value)) return "N/A";
  if (Array.isArray(value)) {
    return value.length ? value.map(formatValue).join(", ") : "N/A";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

async function telegramOrderLog(title, data = {}) {
  try {
    let text = `${title}\n`;

    if (typeof data === "string") {
      text += `${data}\n`;
    } else if (Array.isArray(data)) {
      for (const item of data) {
        if (!item) continue;
        const label = formatValue(item.label ?? item.key ?? "");
        const value = formatValue(item.value ?? item.text ?? "");
        if (label !== "N/A" || value !== "N/A") {
          text += `${label}: ${value}\n`;
        }
      }
    } else {
      Object.entries(data || {}).forEach(([key, value]) => {
        if (isBlank(value)) return;
        text += `${key}: ${formatValue(value)}\n`;
      });
    }

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
    });
  } catch (err) {
    console.error("Telegram Log Error:", err.message);
  }
}

module.exports = telegramOrderLog;
