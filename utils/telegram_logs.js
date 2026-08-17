const axios = require("axios");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const MIN_SEND_INTERVAL_MS = Number(
  process.env.TELEGRAM_LOG_MIN_INTERVAL_MS || 1000,
);
let nextAllowedSendAt = 0;

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

const handleTelegramError = (err) => {
  const retryAfterSeconds = Number(
    err?.response?.data?.parameters?.retry_after || 0,
  );
  if (retryAfterSeconds > 0) {
    nextAllowedSendAt = Date.now() + retryAfterSeconds * 1000;
  }
  console.error(
    "Telegram Log Error:",
    err?.response?.data?.description || err.message,
  );
};

function telegramOrderLog(title, data = {}) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const now = Date.now();
  if (now < nextAllowedSendAt) return;
  nextAllowedSendAt = now + MIN_SEND_INTERVAL_MS;

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

    void axios
      .post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: CHAT_ID,
          text,
        },
        { timeout: 5000 },
      )
      .catch(handleTelegramError);
  } catch (err) {
    handleTelegramError(err);
  }
}

module.exports = telegramOrderLog;
