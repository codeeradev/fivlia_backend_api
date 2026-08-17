const admin = require("../firebase/firebase");

async function sendDriverOfferClosedPush(driverDoc, orderId, type) {
  if (!driverDoc?.fcmToken) return;
  try {
    await admin.messaging().send({
      token: driverDoc.fcmToken,
      data: { type, orderId: String(orderId) },
      android: { priority: "high" },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { contentAvailable: true } },
      },
    });
  } catch (error) {
    console.warn(
      `Driver offer-close push failed for ${driverDoc._id}:`,
      error.message,
    );
  }
}

module.exports = { sendDriverOfferClosedPush };
