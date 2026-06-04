const axios = require("axios");
const getAccessToken = require("./getAccessToken"); // adjust path if needed
const { buildPlatformPushConfig } = require("../utils/pushSoundConfig");

async function sendNotification(
  fcmToken,
  title,
  body,
  clickAction = "/dashboard1",
  data = {},
  soundType,
) {
  const token = await getAccessToken();

  const fcmUrl = "https://fcm.googleapis.com/v1/projects/fivlia-quick-commerce/messages:send";

  const message = {
    message: {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      ...buildPlatformPushConfig(title, body, soundType),
      webpush: {
        notification: {title,body,icon: "/logo192.png",},
        fcmOptions: {link: clickAction,},
      },
      data: {
        click_action: clickAction,
        ...data,
      },
    },
  };

  try {
    const response = await axios.post(fcmUrl, message, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ Notification sent");
  } catch (err) {
    console.error("❌ Sending error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = sendNotification;
