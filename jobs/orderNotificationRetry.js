const { Order } = require("../modals/order");
const Store = require("../modals/store");
const sendNotification = require("../firebase/pushnotification");

const MAX_ATTEMPTS = 10;
const RETRY_INTERVAL = 10000;

async function notifySeller(store, title, body) {
  let tokens = [];

  if (Array.isArray(store.devices)) {
    tokens = store.devices.map(d => d.fcmToken).filter(Boolean);
  }

  if (tokens.length === 0) {
    tokens = [store.fcmToken, store.fcmTokenMobile].filter(Boolean);
  }

  for (const token of tokens) {
    await sendNotification(token, title, body, "/dashboard1", {
      orderId: store._id.toString(),
      ts: Date.now().toString()
    },
    "custom_sound",
  );
  }
}

setInterval(async () => {
  const now = new Date();

  const orders = await Order.find({
    orderStatus: "Pending",
    notifyAttempts: { $lt: MAX_ATTEMPTS },
    $or: [
      { lastNotifyAt: null },
      { lastNotifyAt: { $lte: new Date(now - RETRY_INTERVAL) } }
    ]
  });

  for (const order of orders) {
    const store = await Store.findById(order.storeId);
    if (!store) continue;

    await notifySeller(
      store,
      `⏰ Order #${order.orderId}`,
      `Please accept or reject the order worth ₹${order.totalPrice}`
    );

    await Order.updateOne(
      { _id: order._id },
      {
        $inc: { notifyAttempts: 1 },
        lastNotifyAt: new Date()
      }
    );
  }
}, 5000);
