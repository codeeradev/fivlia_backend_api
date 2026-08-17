const test = require("node:test");
const assert = require("node:assert/strict");

const { getDynamicRetryCount } = require("../utils/driverSocketMap");
const {
  buildPlatformPushConfig,
  DRIVER_NOTIFICATION_CHANNEL,
} = require("../utils/pushSoundConfig");
const {
  upsertPendingDriverOffer,
  removePendingDriverOffer,
  getPendingDriverOffers,
} = require("../utils/pendingDriverOffers");
const {
  recoverPendingDriverOffers,
} = require("../utils/pendingOrderRecovery");

test("retry count covers the configured cancellation window", () => {
  assert.deepEqual(getDynamicRetryCount(5, 10000), {
    TIMEOUT_MS: 10000,
    MAX_RETRY_COUNT: 30,
  });
});

test("driver push uses Flutter's high-priority notification channel", () => {
  const config = buildPlatformPushConfig("New order", "Order O-1");
  assert.equal(DRIVER_NOTIFICATION_CHANNEL, "delivery_alerts_v4");
  assert.equal(config.android.priority, "high");
  assert.equal(
    config.android.notification.channelId,
    "delivery_alerts_v4",
  );
});

test("pending offers recover and clean up without Redis", async () => {
  const driverId = `driver-${Date.now()}`;
  const orderId = "order-recovery";
  await upsertPendingDriverOffer(driverId, orderId, {
    orderId,
    order: { orderId },
  });
  assert.equal((await getPendingDriverOffers(driverId)).length, 1);
  await removePendingDriverOffer(driverId, orderId);
  assert.deepEqual(await getPendingDriverOffers(driverId), []);
});

test("pending recovery returns the full offer only after handlers are ready", async () => {
  const timeline = [];
  const offer = {
    order: { orderId: "O-RECOVER", storeName: "Store" },
    driverId: "D-1",
    timeLeft: 10,
  };

  const orders = await recoverPendingDriverOffers({
    driverId: "D-1",
    getPendingOffers: async () => [offer],
    findOrderByOrderId: async () => {
      timeline.push("order_checked");
      return {
        _id: "mongo-order-id",
        orderId: "O-RECOVER",
        orderStatus: "Accepted",
      };
    },
    removePendingOffer: async () => timeline.push("offer_removed"),
    recreateDispatch: async () => timeline.push("handlers_ready"),
  });

  assert.deepEqual(orders, [offer]);
  assert.deepEqual(timeline, [
    "order_checked",
    "handlers_ready",
    "order_checked",
  ]);
});

test("pending recovery removes stale taken and cancelled offers", async () => {
  const removed = [];
  const offers = [
    { order: { orderId: "TAKEN" } },
    { order: { orderId: "CANCELLED" } },
  ];

  const orders = await recoverPendingDriverOffers({
    driverId: "D-1",
    getPendingOffers: async () => offers,
    findOrderByOrderId: async (orderId) =>
      orderId === "TAKEN"
        ? { _id: "1", orderStatus: "Going to Pickup", driver: { driverId: "D-2" } }
        : { _id: "2", orderStatus: "Cancelled" },
    removePendingOffer: async (_driverId, orderId) => removed.push(orderId),
    recreateDispatch: async () => {
      throw new Error("stale offers must not recreate dispatch");
    },
  });

  assert.deepEqual(orders, []);
  assert.deepEqual(removed, ["TAKEN", "CANCELLED"]);
});

test("repeated ready handshake does not recreate an existing handler", async () => {
  let dispatchCalls = 0;
  const offer = { order: { orderId: "ALREADY-READY" } };
  const order = {
    _id: "mongo-id",
    orderId: "ALREADY-READY",
    orderStatus: "Accepted",
  };

  const recovered = await recoverPendingDriverOffers({
    driverId: "D-1",
    getPendingOffers: async () => [offer],
    findOrderByOrderId: async () => order,
    removePendingOffer: async () => {},
    recreateDispatch: async () => {
      dispatchCalls += 1;
    },
    isHandlerReady: () => true,
  });

  assert.deepEqual(recovered, [offer]);
  assert.equal(dispatchCalls, 0);
});

test("pending recovery removes an offer when the driver became busy", async () => {
  const removed = [];
  let dispatchCalls = 0;
  const order = {
    _id: "mongo-id",
    orderId: "BUSY-OFFER",
    orderStatus: "Accepted",
  };

  const recovered = await recoverPendingDriverOffers({
    driverId: "D-BUSY",
    getPendingOffers: async () => [{ order: { orderId: "BUSY-OFFER" } }],
    findOrderByOrderId: async () => order,
    removePendingOffer: async (_driverId, orderId) => removed.push(orderId),
    recreateDispatch: async () => {
      dispatchCalls += 1;
    },
    isOfferStillEligible: async () => false,
  });

  assert.deepEqual(recovered, []);
  assert.deepEqual(removed, ["BUSY-OFFER"]);
  assert.equal(dispatchCalls, 0);
});
