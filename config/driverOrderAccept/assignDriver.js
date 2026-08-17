const {
  driverSocketMap,
  getDynamicRetryCount,
} = require("../../utils/driverSocketMap");
const Assign = require("../../modals/driverModals/assignments");
const { Order } = require("../../modals/order");
const Dispatch = require("../../modals/dispatch");
const admin = require("../../firebase/firebase");
const Store = require("../../modals/store");
const User = require("../../modals/User");
const { SettingAdmin } = require("../../modals/setting");
const telegramOrderLog = require("../../utils/telegram_logs");
const { notifyEntity } = require("../../utils/notifyStore");
const {
  buildPlatformPushConfig,
  DEFAULT_PUSH_SOUND,
  DRIVER_NOTIFICATION_CHANNEL,
} = require("../../utils/pushSoundConfig");
const { getRedisClient } = require("../../utils/redisClient");
const {
  upsertPendingDriverOffer,
  removePendingDriverOffer,
} = require("../../utils/pendingDriverOffers");
const {
  sendDriverOfferClosedPush,
} = require("../../utils/driverOfferNotifications");
// new socket code of user order status
const {
  emitUserOrderStatusUpdate,
} = require("../../utils/emitUserOrderStatusUpdate");
const { getDriverSocketRouter } = require("../../socket/driverSocketRouter");

// Tracks the active retry timer for each orderId.
const orderTimeouts = new Map();

const safeText = (value, fallback = "N/A") => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
};

const safeNumberText = (value, fallback = "N/A", fractionDigits = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num.toFixed(fractionDigits);
};

const telegramDriverId = (driverDoc, fallbackId = "N/A") => {
  if (!driverDoc) return fallbackId;
  return safeText(driverDoc.driverId, safeText(fallbackId));
};

const safeTelegramLog = async (title, data) => {
  try {
    await telegramOrderLog(title, data);
  } catch (err) {
    console.error("Telegram dispatch log failed:", err.message);
  }
};

const buildDriverSummaryLine = (index, driver, extra = "") =>
  `${index + 1}. ${safeText(driver.driverName)} (${safeText(driver._id)})${extra ? ` | ${extra}` : ""}`;

const clearDispatchTimeout = (orderId) => {
  orderId = orderId.toString();

  if (orderTimeouts.has(orderId)) {
    clearTimeout(orderTimeouts.get(orderId));
    orderTimeouts.delete(orderId);

    console.log(`🧹 Cleared timeout for order ${orderId}`);
  }
};

const DISPATCH_REDIS_TTL_SECONDS = Number(
  process.env.DISPATCH_REDIS_TTL_SECONDS || 24 * 60 * 60,
);

const getDispatchRedisKeys = (orderId) => ({
  state: `dispatch:${orderId}:state`,
  rejectedDrivers: `dispatch:${orderId}:rejectedDrivers`,
  respondedDrivers: `dispatch:${orderId}:respondedDrivers`,
});

// Refreshes Redis TTL for all dispatch keys that belong to one order.
const touchDispatchRedisKeys = async (redis, keys) => {
  if (!redis || !DISPATCH_REDIS_TTL_SECONDS) return;

  await Promise.all([
    redis.expire(keys.state, DISPATCH_REDIS_TTL_SECONDS),
    redis.expire(keys.rejectedDrivers, DISPATCH_REDIS_TTL_SECONDS),
    redis.expire(keys.respondedDrivers, DISPATCH_REDIS_TTL_SECONDS),
  ]);
};

const cacheRedisDispatchState = async (orderId, state, redisClient = null) => {
  const redis = redisClient || (await getRedisClient());
  if (!redis || !state) return;

  const keys = getDispatchRedisKeys(orderId);
  const rejectedDrivers = (state.rejectedDrivers || []).map((id) =>
    id.toString(),
  );
  const respondedDrivers = (state.respondedDrivers || []).map((id) =>
    id.toString(),
  );

  try {
    await redis.hSet(keys.state, {
      assigned: state.assigned ? "1" : "0",
      retryCount: String(state.retryCount || 0),
      status: state.status || "pending",
    });

    await redis.del(keys.rejectedDrivers);
    if (rejectedDrivers.length) {
      await redis.sAdd(keys.rejectedDrivers, rejectedDrivers);
    }

    await redis.del(keys.respondedDrivers);
    if (respondedDrivers.length) {
      await redis.sAdd(keys.respondedDrivers, respondedDrivers);
    }

    await touchDispatchRedisKeys(redis, keys);
  } catch (err) {
    console.warn("Redis dispatch cache write failed:", err.message);
  }
};

// Reads dispatch state from Redis first to reduce repeated DB reads.
const readRedisDispatchState = async (orderId) => {
  const redis = await getRedisClient();
  if (!redis) return null;

  const keys = getDispatchRedisKeys(orderId);

  try {
    const state = await redis.hGetAll(keys.state);
    if (
      !state ||
      !Object.prototype.hasOwnProperty.call(state, "assigned") ||
      !Object.prototype.hasOwnProperty.call(state, "retryCount")
    ) {
      return null;
    }

    const [rejectedDrivers, respondedDrivers] = await Promise.all([
      redis.sMembers(keys.rejectedDrivers),
      redis.sMembers(keys.respondedDrivers),
    ]);

    await touchDispatchRedisKeys(redis, keys);

    return {
      assigned: state.assigned === "1",
      retryCount: Number(state.retryCount || 0),
      rejectedDrivers,
      respondedDrivers,
      status: state.status || "pending",
    };
  } catch (err) {
    console.warn("Redis dispatch cache read failed:", err.message);
    return null;
  }
};

const createDispatchState = async (orderId) =>
  Dispatch.findOneAndUpdate(
    { orderId },
    {
      $setOnInsert: {
        orderId,
        assigned: false,
        retryCount: 0,
        rejectedDrivers: [],
        respondedDrivers: [],
        status: "pending",
      },
    },
    { upsert: true, new: true },
  ).lean();

// Returns dispatch state by preferring Redis and falling back to MongoDB.
const getDispatchState = async (orderId) => {
  const redisState = await readRedisDispatchState(orderId);
  if (redisState) return redisState;

  const dispatchState = await createDispatchState(orderId);
  await cacheRedisDispatchState(orderId, dispatchState);
  return dispatchState;
};

// Applies a small Redis-side state update if cache exists.
const updateRedisDispatchState = async (orderId, updater) => {
  const redis = await getRedisClient();
  if (!redis || !updater) return;

  const keys = getDispatchRedisKeys(orderId);

  try {
    const stateExists = await redis.exists(keys.state);
    if (!stateExists) {
      const dispatchState = await Dispatch.findOne({ orderId }).lean();
      await cacheRedisDispatchState(orderId, dispatchState, redis);
      return;
    }

    await updater(redis, keys);
    await touchDispatchRedisKeys(redis, keys);
  } catch (err) {
    console.warn("Redis dispatch cache update failed:", err.message);
  }
};

// Source of truth update for dispatch state in MongoDB and Redis.
const updateDispatchState = async (orderId, update, redisUpdater = null) => {
  await Dispatch.updateOne(
    { orderId },
    { $setOnInsert: { orderId }, ...update },
    { upsert: true, setDefaultsOnInsert: false },
  );

  await updateRedisDispatchState(orderId, redisUpdater);
};

const toStringSet = (values = []) =>
  new Set(values.map((value) => value.toString()));

const FINAL_ORDER_STATUSES = [
  "Delivered",
  "Completed",
  "Cancelled",
  "Rejected",
];

const isOrderDispatchable = (order) =>
  Boolean(
    order &&
      !order.driver?.driverId &&
      !FINAL_ORDER_STATUSES.includes(order.orderStatus),
  );

const getBusyDriverIds = async (excludeOrderId = null) => {
  const orderQuery = {
    "driver.driverId": { $exists: true, $nin: [null, ""] },
    orderStatus: { $nin: FINAL_ORDER_STATUSES },
  };
  const assignQuery = {
    driverId: { $exists: true, $ne: null },
    orderStatus: { $ne: "Rejected" },
  };

  if (excludeOrderId) {
    const orderId = excludeOrderId.toString();
    orderQuery.orderId = { $ne: orderId };
    assignQuery.orderId = { $ne: orderId };
  }

  const [activeOrders, activeAssignments] = await Promise.all([
    Order.find(orderQuery).select("driver.driverId").lean(),
    Assign.find(assignQuery).select("driverId").lean(),
  ]);

  return new Set([
    ...activeOrders
      .map((order) => order?.driver?.driverId)
      .filter(Boolean)
      .map((id) => id.toString()),
    ...activeAssignments
      .map((assignment) => assignment?.driverId)
      .filter(Boolean)
      .map((id) => id.toString()),
  ]);
};

const isDriverBusyForOrder = async (driverIdentifiers, excludeOrderId = null) => {
  const identifiers = Array.isArray(driverIdentifiers)
    ? driverIdentifiers
    : [driverIdentifiers];
  const normalizedIdentifiers = identifiers
    .filter(Boolean)
    .map((value) => value.toString());
  const assignmentDriverIds = normalizedIdentifiers.filter((value) =>
    /^[a-f\d]{24}$/i.test(value),
  );

  if (!normalizedIdentifiers.length) {
    return false;
  }

  const orderQuery = {
    "driver.driverId": { $in: normalizedIdentifiers },
    orderStatus: { $nin: FINAL_ORDER_STATUSES },
  };
  const assignQuery = {
    // assignments.driverId is an ObjectId, while orders.driver.driverId is a
    // string and may contain the public driver code (for example "FV004").
    // Passing that public code to Mongoose's ObjectId field aborts the entire
    // pending-offer recovery with a CastError.
    driverId: { $in: assignmentDriverIds },
    orderStatus: { $ne: "Rejected" },
  };

  if (excludeOrderId) {
    const orderId = excludeOrderId.toString();
    orderQuery.orderId = { $ne: orderId };
    assignQuery.orderId = { $ne: orderId };
  }

  const [busyOrder, busyAssignment] = await Promise.all([
    Order.findOne(orderQuery).select("_id").lean(),
    Assign.findOne(assignQuery).select("_id").lean(),
  ]);

  return !!busyOrder || !!busyAssignment;
};

// Adds and removes order-specific socket listeners safely.
const registerSocketOrderListeners = (socket, orderKey, handlers) => {
  getDriverSocketRouter(socket).register(String(orderKey).replace(/^order:/, ""), {
    accept: handlers.onAccept,
    reject: handlers.onReject,
  });
};

const removeSocketOrderListeners = (socket, orderKey) => {
  getDriverSocketRouter(socket)?.unregister(String(orderKey).replace(/^order:/, ""));
  return;

  if (!socket?.__orderListenerRegistry?.has(orderKey)) {
    return;
  }

  const { onAccept, onReject, onDisconnect } =
    socket.__orderListenerRegistry.get(orderKey);

  if (onAccept) {
    socket.off("acceptOrder", onAccept);
  }

  if (onReject) {
    socket.off("rejectOrder", onReject);
  }

  if (onDisconnect) {
    socket.off("disconnect", onDisconnect);
  }

  socket.__orderListenerRegistry.delete(orderKey);

  console.log("🧹 Socket order listeners removed", {
    orderKey,
    socketId: socket.id,
  });
};

// Main order broadcast flow with retry, acceptance race protection, and cleanup.
const assignWithBroadcast = async (order, drivers) => {
  const orderId = order.orderId.toString();
  const orderKey = `order:${orderId}`;
  const latestOrderAtStart = await Order.findOne({ orderId })
    .select("orderStatus driver.driverId")
    .lean();
  if (!isOrderDispatchable(latestOrderAtStart)) {
    console.warn(`Order ${orderId} is no longer dispatchable. Aborting.`);
    return;
  }
  const dispatchState = await getDispatchState(orderId);

  if (dispatchState?.assigned) {
    console.warn(`⚠️ Order ${orderId} already assigned. Aborting broadcast.`);
    return;
  }
  let cancelAfterMinutes = 5;
  try {
    const setting = await SettingAdmin.findOne().lean();
    if (setting?.minimumOrderCancelTime)
      cancelAfterMinutes = Number(setting.minimumOrderCancelTime);
  } catch (err) {
    console.warn("⚠️ Could not load admin settings:", err.message);
  }

  // ===== Dynamic retry calculation =====
  const { TIMEOUT_MS, MAX_RETRY_COUNT } = getDynamicRetryCount(
    cancelAfterMinutes,
    10000,
  );
  const offerTtlSeconds = Math.max(Math.ceil(TIMEOUT_MS / 1000) + 30, 60);

  console.log(
    `⚙️ Auto-adjusted retries: ${MAX_RETRY_COUNT} x ${
      TIMEOUT_MS / 1000
    }s = ${cancelAfterMinutes} min`,
  );

  const retryCount = dispatchState?.retryCount || 0;
  if (retryCount >= MAX_RETRY_COUNT) {
    const cancelledOrder = await Order.findOneAndUpdate(
      { orderId },
      { orderStatus: "Cancelled" },
      { new: true },
    );
    // new socket code of user order status
    await emitUserOrderStatusUpdate(
      cancelledOrder,
      "assignDriver.retryTimeoutCancelled",
    );
    console.error(`🚫 Max retry attempts reached for order ${orderId}.`);

    try {
      const orderData = await Order.findOne({ orderId })
        .populate("userId")
        .populate("storeId")
        .lean();

      if (orderData) {
        const { userId: user, storeId: store } = orderData;

        // ===== send to user =====
        if (user?.fcmToken) {
          try {
            await admin.messaging().send({
              token: user.fcmToken,
              notification: {
                title: "Order Cancelled ❌",
                body: `Your order #${orderId} was cancelled as no driver accepted.`,
              },
              ...buildPlatformPushConfig(
                "Order Cancelled ❌",
                `Your order #${orderId} was cancelled as no driver accepted.`,
                DEFAULT_PUSH_SOUND,
              ),
              data: { type: "cancelled", orderId },
            });
          } catch (err) {
            console.error(`❌ Push to user ${user._id} failed:`, err.message);
          }
        }

        // ===== send to store =====
        if (store && store.devices?.length) {
          await notifyEntity(
            store,
            "Order Cancelled ❌",
            `Order #${orderId} got cancelled (no driver accepted).`,
            { type: "cancelled", orderId: orderId.toString() },
          );
        }
      }
    } catch (e) {
      console.error("⚠️ Auto-cancel push error:", e);
    }

    await Promise.all(
      drivers.map((driver) =>
        removePendingDriverOffer(driver._id?.toString(), orderId),
      ),
    );
    await Promise.all(
      drivers.map(async (driver) => {
        const driverId = driver._id?.toString();
        driverSocketMap.get(driverId)?.emit("orderTaken", {
          orderId,
          reason: "CANCELLED",
        });
        await sendDriverOfferClosedPush(driver, orderId, "order_cancelled");
      }),
    );

    await updateDispatchState(
      orderId,
      {
        $set: { assigned: false, status: "cancelled" },
      },
      async (redis, keys) => {
        await redis.hSet(keys.state, {
          assigned: "0",
          status: "cancelled",
        });
      },
    );
    return;
  }

  await updateDispatchState(
    orderId,
    {
      $inc: { retryCount: 1 },
      $set: { status: "pending" },
    },
    async (redis, keys) => {
      await Promise.all([
        redis.hIncrBy(keys.state, "retryCount", 1),
        redis.hSet(keys.state, { status: "pending" }),
      ]);
    },
  );

  let orderAssigned = false;
  const respondedDrivers = toStringSet(dispatchState?.respondedDrivers);
  const respondedDriversThisCycle = new Set();

  const orderStore = await Store.findOne({ _id: order.storeId }).lean();
  const orderUser = await User.findOne({ _id: order.userId }).lean();

  const rejectedDrivers = toStringSet(dispatchState?.rejectedDrivers);
  const busyDriverIds = await getBusyDriverIds(orderId);

  const availableDrivers = drivers.filter(
    (driver) => {
      const driverIdentifiers = [
        driver._id?.toString(),
        driver.driverId?.toString(),
      ].filter(Boolean);

      return (
        !rejectedDrivers.has(driver._id.toString()) &&
        !driverIdentifiers.some((identifier) => busyDriverIds.has(identifier))
      );
    },
  );

  if (availableDrivers.length === 0) {
    console.info(`😕 No available drivers to broadcast for order ${orderId}`);
    // return;
  }

  await safeTelegramLog("DISPATCH START", [
    { label: "orderId", value: orderId },
    { label: "totalDriversInput", value: drivers.length },
    { label: "eligibleDrivers", value: availableDrivers.length },
    { label: "rejectedDrivers", value: rejectedDrivers.size },
    { label: "respondedDrivers", value: respondedDrivers.size },
  ]);

  const userLocation = orderUser?.location || {};
  const orderWithLocation = {
    ...(order.toObject ? order.toObject() : order),

    storeName: orderStore?.storeName || null,
    storeLat: orderStore?.Latitude || null,
    storeLng: orderStore?.Longitude || null,

    userLat: userLocation.latitude || null,
    userLng: userLocation.longitude || null,

    deliveryPayout:
      order.deliveryPayout != null
        ? Math.round(Number(order.deliveryPayout) * 100) / 100
        : null,
  };

  const cleanupAllListeners = () => {
    availableDrivers.forEach(async (driver) => {
      const driverId = driver._id.toString();
      const socket = driverSocketMap.get(driverId);
      removeSocketOrderListeners(socket, orderKey);
    });
  };

  const broadcastOrder = async () => {
    const latestOrder = await Order.findOne({ orderId })
      .select("orderStatus driver.driverId")
      .lean();
    if (!isOrderDispatchable(latestOrder)) {
      console.warn(
        `Order ${orderId} changed before broadcast. Skipping stale offer.`,
      );
      return false;
    }

    console.log(
      `📢 Broadcasting order ${orderId} to ${availableDrivers.length} drivers...`,
    );

    let pushEligibleCount = 0;
    let pushSentCount = 0;
    let socketConnectedCount = 0;
    let socketSkippedCount = 0;
    const deliverySummary = new Map();

    const getSummaryEntry = (driverDoc) => {
      const driverKey = driverDoc._id.toString();
      if (!deliverySummary.has(driverKey)) {
        deliverySummary.set(driverKey, {
          driverId: telegramDriverId(driverDoc, driverKey),
          driverName: safeText(driverDoc.driverName),
          pushStatus: "not_processed",
          pushReason: "N/A",
          socketStatus: "not_processed",
          socketReason: "N/A",
        });
      }

      return deliverySummary.get(driverKey);
    };

    // 🔹 Step 1: Send FCM to ALL available drivers (socket or not)
    for (const driver of availableDrivers) {
      if (orderAssigned) {
        break;
      }

      const driverId = driver._id.toString();
      const summary = getSummaryEntry(driver);

      // Persist FIRST. A foreground FCM can immediately request recovery;
      // that request must never beat the pending-offer write.
      try {
        await upsertPendingDriverOffer(
          driverId,
          orderId,
          {
            order: orderWithLocation,
            driverId,
            timeLeft: TIMEOUT_MS / 1000,
          },
          offerTtlSeconds,
        );
      } catch (pendingOfferError) {
        console.error(
          `⚠️ Failed to save pending offer for ${driverId} - ${orderId}:`,
          pendingOfferError,
        );
      }

      if (driver.fcmToken) {
        pushEligibleCount += 1;
        console.log("PUSH ATTEMPT", { orderId, driverId });
        try {
          await admin.messaging().send({
            token: driver.fcmToken,
            notification: {
              title: "New Order Request 🚗",
              body: `Order #${orderId} is waiting for your response`,
            },
            data: {
              type: "new_order",
              orderId,
              timeLeft: (TIMEOUT_MS / 1000).toString(),
              screen: "TodayOrderScreen",
              title: "New Order Request 🚗",
              body: `Order #${orderId} is waiting for your response`,
            },
            android: {
              priority: "high",
              notification: {
                channelId: DRIVER_NOTIFICATION_CHANNEL,
                sound: "custom_sound",
              },
            },
          });
          console.log(`📩 Push sent to driver ${driverId}`);
          pushSentCount += 1;
          summary.pushStatus = "sent";
          summary.pushReason = "sent_successfully";
        } catch (err) {
          console.error("Push error:", err);
          summary.pushStatus = "failed";
          summary.pushReason = err?.message || "push_failed";
        }
      } else {
        summary.pushStatus = "skipped";
        summary.pushReason = "missing_fcm_token";
      }
    }

    const latestOrderBeforeSocket = await Order.findOne({ orderId })
      .select("orderStatus driver.driverId")
      .lean();
    if (!isOrderDispatchable(latestOrderBeforeSocket)) {
      await Promise.all(
        availableDrivers.map((driver) =>
          removePendingDriverOffer(driver._id.toString(), orderId),
        ),
      );
      console.warn(
        `Order ${orderId} changed during push delivery. Socket emit skipped.`,
      );
      return false;
    }

    // 🔹 Step 2: Emit socket event only for online drivers
    for (const driver of availableDrivers) {
      if (orderAssigned) {
        break;
      }

      const driverId = driver._id.toString();
      const logDriverId = telegramDriverId(driver, driverId);
      const socket = driverSocketMap.get(driverId);
      const summary = getSummaryEntry(driver);

      if (!socket) {
        console.log(
          `📱 Driver ${driverId} not connected to socket, push-only mode`,
        );
        socketSkippedCount += 1;
        summary.socketStatus = "skipped";
        summary.socketReason = "socket_not_found";
        continue;
      }

      if (socket.connected !== true) {
        console.log(`⚠️ Driver ${driverId} socket exists but is disconnected`);
        socketSkippedCount += 1;
        summary.socketStatus = "skipped";
        summary.socketReason = "socket_disconnected";
        continue;
      }

      socketConnectedCount += 1;
      summary.socketStatus = "connected";
      summary.socketReason = "socket_ready";

      /*
       * IMPORTANT:
       * Listener newOrder emit se pehle register hoga.
       * Isse Flutter ka fast Accept tap miss nahi hoga.
       */

      // ---------------- ACCEPT HANDLER ----------------

      const handleAccept = async (payload = {}, callback) => {
        const incomingDriverId = payload?.driverId?.toString().trim() || "";

        const incomingOrderId = payload?.orderId?.toString().trim() || "";

        let callbackSent = false;

        const sendCallback = (response) => {
          if (callbackSent) {
            return;
          }

          callbackSent = true;

          if (typeof callback === "function") {
            callback(response);
          }
        };

        console.log("🟡 DRIVER ACCEPT REQUEST RECEIVED", {
          orderId,
          expectedOrderId: orderId,
          incomingOrderId,

          driverId,
          incomingDriverId,

          orderAssigned,

          driverName: driver?.driverName,
          socketId: socket?.id || null,
          socketConnected: socket?.connected === true,

          timestamp: new Date().toISOString(),
        });

        try {
          if (!incomingOrderId || !incomingDriverId) {
            console.warn("❌ ACCEPT PAYLOAD MISSING", {
              orderId,
              driverId,
              incomingOrderId,
              incomingDriverId,
            });

            sendCallback({
              status: false,
              success: false,
              message: "driverId and orderId are required",
              reason: "INVALID_REQUEST",
              orderId,
            });

            return;
          }

          if (
            incomingOrderId !== orderId ||
            incomingDriverId !== driverId
          ) {
            const reason =
              incomingOrderId !== orderId
                ? "ORDER_ID_MISMATCH"
                : "DRIVER_ID_MISMATCH";

            console.warn("❌ ACCEPT VALIDATION FAILED", {
              orderId,
              incomingOrderId,

              driverId,
              incomingDriverId,

              orderAssigned,
              reason,
            });

            await safeTelegramLog("ACCEPT REJECTED", [
              { label: "orderId", value: orderId },
              { label: "driverId", value: logDriverId },
              { label: "driverName", value: driver?.driverName },
              { label: "reason", value: reason },
              { label: "incomingOrderId", value: incomingOrderId },
              { label: "incomingDriverId", value: incomingDriverId },
            ]);

            sendCallback({
              status: false,
              success: false,
              message: "Invalid order accept request",
              reason,
              orderId,
            });

            return;
          }

          const latestOrder = await Order.findOne({
            orderId,
          }).lean();

          if (!latestOrder) {
            sendCallback({
              status: false,
              success: false,
              message: "Order not found",
              reason: "ORDER_NOT_FOUND",
              orderId,
            });

            return;
          }

          const existingDriverId = latestOrder.driver?.driverId?.toString?.() || "";
          if (existingDriverId && existingDriverId === driverId && latestOrder.orderStatus === "Going to Pickup") {
            sendCallback({
              status: true,
              success: true,
              message: "Order already accepted by this driver",
              reason: "ALREADY_ACCEPTED_BY_DRIVER",
              orderId,
              driverId,
            });
            return;
          }
          if (existingDriverId) {
            socket.emit("orderAlreadyAccepted", { orderId });
            sendCallback({
              status: false,
              success: false,
              message: "Order already accepted",
              reason: "ALREADY_ACCEPTED",
              orderId,
            });
            return;
          }

          const driverBusy = await isDriverBusyForOrder(
            [driverId, driver.driverId],
            orderId,
          );
          if (driverBusy) {
            console.warn(`⚠️ Driver ${driverId} already has an active order.`);

            await safeTelegramLog("DRIVER BUSY", [
              { label: "orderId", value: orderId },
              { label: "driverId", value: logDriverId },
              { label: "driverName", value: driver.driverName },
              { label: "reason", value: "active order already exists" },
            ]);

            sendCallback({
              status: false,
              success: false,
              message: "Driver already has an active order",
              reason: "DRIVER_BUSY",
              orderId,
            });

            removeSocketOrderListeners(socket, orderKey);
            await removePendingDriverOffer(driverId, orderId);
            return;
          }

          const orderUpdate = {
            driver: {
              driverId,
              name: driver.driverName,
              mobileNumber: driver.address?.mobileNo,
            },
            orderStatus: "Going to Pickup",
          };

          console.log("TRYING ORDER UPDATE", {
            orderId,
            driverId,
            driverName: driver.driverName,
            orderStatus: "Going to Pickup",
          });

          /*
           * Atomic update:
           * Sirf wahi request successful hogi jisme driver pehle assigned nahi hai.
           */
          const updateResult = await Order.findOneAndUpdate(
            {
              orderId,
              orderStatus: { $nin: FINAL_ORDER_STATUSES },
              $or: [
                {
                  driver: {
                    $exists: false,
                  },
                },
                {
                  driver: null,
                },
                {
                  "driver.driverId": {
                    $exists: false,
                  },
                },
                {
                  "driver.driverId": null,
                },
                {
                  "driver.driverId": "",
                },
              ],
            },
            {
              $set: orderUpdate,
            },
            {
              new: true,
            },
          );

          if (!updateResult) {
            const claimedOrder = await Order.findOne({ orderId })
              .select("driver.driverId orderStatus")
              .lean();
            const claimedDriverId =
              claimedOrder?.driver?.driverId?.toString?.() || "";
            const failureReason = claimedDriverId
              ? "ALREADY_ACCEPTED"
              : "ORDER_NOT_AVAILABLE";
            console.warn(
              `🉑 Order already accepted/not available: ${driverId} - ${orderId}`,
            );

            await safeTelegramLog("ORDER UPDATE FAILED", [
              { label: "orderId", value: orderId },
              { label: "driverId", value: logDriverId },
              { label: "driverName", value: driver?.driverName },
              { label: "reason", value: "ORDER_ALREADY_ACCEPTED_OR_NOT_FOUND" },
            ]);

            socket.emit("orderAlreadyAccepted", {
              orderId,
            });

            sendCallback({
              status: false,
              success: false,
              message: claimedDriverId
                ? "Order already accepted"
                : "Order is no longer available",
              reason: failureReason,
              orderId,
            });

            removeSocketOrderListeners(socket, orderKey);

            return;
          }

          /*
           * Order MongoDB me successfully claim ho chuka hai.
           * Ab local race flag immediately set karo.
           */
          orderAssigned = true;
          respondedDriversThisCycle.add(driverId);

          clearDispatchTimeout(orderId);

          /*
           * Flutter ko pehle success ACK bhej do.
           * Redis, assignment, notifications ya cleanup slow hone par
           * frontend timeout nahi karega.
           */
          sendCallback({
            status: true,
            success: true,
            message: "Order accepted successfully",
            orderId,
            driverId,
          });

          console.log("✅ ACCEPT ACK SENT TO DRIVER", {
            orderId,
            driverId,
            socketId: socket.id,
          });

          // MongoDB is authoritative. As soon as the atomic claim succeeds,
          // remove the offer from every other connected driver; secondary
          // Redis/logging/assignment writes must not delay stale-card cleanup.
          availableDrivers.forEach((availableDriver) => {
            const otherDriverId = availableDriver._id.toString();
            if (otherDriverId === driverId) return;
            driverSocketMap.get(otherDriverId)?.emit("orderTaken", {
              orderId,
              acceptedBy: driverId,
            });
          });

          /*
           * Neeche existing backend updates hain.
           * Inme failure aaye to order accept already MongoDB me safe hai.
           */

          try {
            await emitUserOrderStatusUpdate(
              updateResult,
              "assignDriver.driverAccepted",
            );
          } catch (statusError) {
            console.error("⚠️ User order-status emit failed:", statusError);
          }

          try {
            await updateDispatchState(
              orderId,
              {
                $set: {
                  assigned: true,
                  status: "assigned",
                },
                $addToSet: {
                  respondedDrivers: driverId,
                },
              },
              async (redis, keys) => {
                await Promise.all([
                  redis.hSet(keys.state, {
                    assigned: "1",
                    status: "assigned",
                  }),
                  redis.sAdd(keys.respondedDrivers, driverId),
                ]);
              },
            );
          } catch (dispatchError) {
            console.error("⚠️ Dispatch state update failed:", dispatchError);
          }

          try {
            await Assign.updateOne(
              {
                driverId,
                orderId,
              },
              {
                $set: {
                  orderStatus: "Accepted",
                },
              },
              {
                upsert: true,
              },
            );
          } catch (assignError) {
            console.error(
              "⚠️ Driver assignment record update failed:",
              assignError,
            );
          }

          console.log(`🎉 Driver ${driverId} accepted order ${orderId}`);

          await safeTelegramLog("DRIVER ACCEPTED", [
            { label: "orderId", value: orderId },
            { label: "driverId", value: logDriverId },
            { label: "driverName", value: driver.driverName },
            { label: "status", value: "assigned" },
          ]);

          /*
           * Dusre drivers se same order remove karo.
           */
          await Promise.all(
            availableDrivers
              .filter(
                (availableDriver) =>
                  availableDriver._id.toString() !== driverId,
              )
              .map((availableDriver) =>
                sendDriverOfferClosedPush(
                  availableDriver,
                  orderId,
                  "order_taken",
                ),
              ),
          );

          try {
            await Promise.all(
              availableDrivers.map((availableDriver) =>
                removePendingDriverOffer(
                  availableDriver._id.toString(),
                  orderId,
                ),
              ),
            );
          } catch (pendingOfferCleanupError) {
            console.error(
              "⚠️ Pending offers cleanup failed:",
              pendingOfferCleanupError,
            );
          }

          cleanupAllListeners();
        } catch (err) {
          console.error("❌ Accept Order Error:", err);

          sendCallback({
            status: false,
            success: false,
            message: "Failed to accept order",
            reason: "INTERNAL_ERROR",
            error: err.message,
            orderId,
          });

          await safeTelegramLog("DRIVER ACCEPT FAILED", [
            { label: "orderId", value: orderId },
            { label: "driverId", value: logDriverId },
            { label: "driverName", value: driver?.driverName },
            { label: "reason", value: err.message },
          ]);
        }
      };

      // ---------------- REJECT HANDLER ----------------

      const handleReject = async (payload = {}, sendCallback = null) => {
        const incomingDriverId = payload?.driverId?.toString().trim() || "";

        const incomingOrderId = payload?.orderId?.toString().trim() || "";

        if (
          incomingOrderId !== orderId ||
          incomingDriverId !== driverId ||
          orderAssigned
        ) {
          if (typeof sendCallback === "function") {
            sendCallback({
              status: false,
              success: false,
              message: "Order is no longer available",
              reason: orderAssigned ? "ALREADY_ACCEPTED" : "INVALID_REQUEST",
              orderId,
            });
          }
          return;
        }

        const currentOrder = await Order.findOne({ orderId }).select("driver.driverId orderStatus").lean();
        if (!currentOrder || currentOrder.driver?.driverId || ["Cancelled", "Delivered", "Rejected"].includes(currentOrder.orderStatus)) {
          await removePendingDriverOffer(driverId, orderId);
          if (typeof sendCallback === "function") {
            sendCallback({
              status: false,
              success: false,
              message: "Order is no longer available",
              reason: currentOrder?.driver?.driverId ? "ALREADY_ACCEPTED" : "ORDER_NOT_AVAILABLE",
              orderId,
            });
          }
          return;
        }

        respondedDrivers.add(driverId);
        respondedDriversThisCycle.add(driverId);
        rejectedDrivers.add(driverId);

        await updateDispatchState(
          orderId,
          {
            $set: {
              assigned: false,
              status: "pending",
            },
            $addToSet: {
              rejectedDrivers: driverId,
              respondedDrivers: driverId,
            },
          },
          async (redis, keys) => {
            await Promise.all([
              redis.hSet(keys.state, {
                assigned: "0",
                status: "pending",
              }),
              redis.sAdd(keys.rejectedDrivers, driverId),
              redis.sAdd(keys.respondedDrivers, driverId),
            ]);
          },
        );

        if (typeof sendCallback === "function") {
          sendCallback({
            status: true,
            success: true,
            message: "Order rejected successfully",
            reason: "REJECTED",
            orderId,
            driverId,
          });
        }

        await Assign.updateOne(
          {
            driverId,
            orderId,
          },
          {
            $set: {
              orderStatus: "Rejected",
            },
          },
          {
            upsert: true,
          },
        );

        console.log(`❌ Driver ${driverId} rejected order ${orderId}`);

        await safeTelegramLog("DRIVER REJECTED", [
          { label: "orderId", value: orderId },
          { label: "driverId", value: logDriverId },
          { label: "driverName", value: driver.driverName },
          { label: "status", value: "rejected" },
        ]);

        await removePendingDriverOffer(driverId, orderId);

        removeSocketOrderListeners(socket, orderKey);
      };

      // ---------------- RAW SOCKET WRAPPERS ----------------

      const onAccept = (data, callback) => {
        console.log("📥 RAW acceptOrder EVENT RECEIVED", {
          orderId,
          driverId,
          socketId: socket.id,
          socketConnected: socket.connected,
          data,
          callbackExists: typeof callback === "function",
        });

        handleAccept(data, callback).catch((error) => {
          console.error("❌ Unhandled accept handler error:", error);

          if (typeof callback === "function") {
            callback({
              status: false,
              success: false,
              message: "Failed to accept order",
              error: error.message,
              orderId,
            });
          }
        });
      };

      const onReject = (data, callback) => {
        let callbackSent = false;
        const sendOnce = (response) => {
          if (callbackSent || typeof callback !== "function") return;
          callbackSent = true;
          callback(response);
        };
        console.log("📥 RAW rejectOrder EVENT RECEIVED", {
          orderId,
          driverId,
          socketId: socket.id,
          data,
        });

        handleReject(data, sendOnce).catch((error) => {
          console.error("❌ Reject handler error:", error);
          sendOnce({
            status: false,
            success: false,
            message: "Failed to reject order",
            reason: "INTERNAL_ERROR",
            orderId,
          });
        });
      };

      const onDisconnect = () => {
        console.log("🔌 Driver socket disconnected", {
          orderId,
          driverId,
          socketId: socket.id,
        });

        removeSocketOrderListeners(socket, orderKey);
      };

      /*
       * Listener FIRST.
       */
      registerSocketOrderListeners(socket, orderKey, {
        onAccept,
        onReject,
        onDisconnect,
      });

      console.log("✅ Order listeners ready before newOrder emit", {
        orderId,
        driverId,
        socketId: socket.id,
        connected: socket.connected,
        acceptListenerCount: socket.listenerCount("acceptOrder"),
      });

      /*
       * Order emit SECOND.
       */
      socket.emit("newOrder", {
        order: orderWithLocation,
        driverId,
        timeLeft: TIMEOUT_MS / 1000,
      });

      console.log(`✅ Socket order ${orderId} sent to driver ${driverId}`);

      console.log("ORDER SENT TO DRIVER SOCKET", {
        orderId,
        driverId,
        socketId: socket.id,
        timeLeft: TIMEOUT_MS / 1000,
      });

    }

    await safeTelegramLog("DISPATCH DELIVERY SUMMARY", [
      { label: "orderId", value: orderId },
      { label: "eligibleDrivers", value: availableDrivers.length },
      { label: "pushEligibleCount", value: pushEligibleCount },
      { label: "pushSentCount", value: pushSentCount },
      { label: "socketConnectedCount", value: socketConnectedCount },
      { label: "socketSkippedCount", value: socketSkippedCount },
      ...Array.from(deliverySummary.values()).map((item, index) => ({
        label: `${index + 1}`,
        value: `${index + 1}. ${safeText(item.driverName)} (${safeText(item.driverId)}) | push=${safeText(item.pushStatus)} | pushReason=${safeText(item.pushReason)} | socket=${safeText(item.socketStatus)} | socketReason=${safeText(item.socketReason)}`,
      })),
    ]);
    return true;
  };

  let broadcastStarted = false;
  try {
    broadcastStarted = await broadcastOrder();
  } catch (err) {
    console.error("Broadcast order flow failed:", err.message);
  }

  if (!broadcastStarted) {
    cleanupAllListeners();
    return;
  }

  // Ensure only one active retry timer exists for this order.
  clearDispatchTimeout(orderId);

  const timeout = setTimeout(async () => {
    orderTimeouts.delete(orderId);
    const existingOrder = await Order.findOne({ orderId }).lean();

    if (!existingOrder || existingOrder.orderStatus === "Cancelled") {
      console.log(`Order ${orderId} already cancelled.`);

      cleanupAllListeners();

      await Promise.all(
        availableDrivers.map((d) =>
          removePendingDriverOffer(d._id.toString(), orderId),
        ),
      );

      return;
    }

    if (
      existingOrder?.driver &&
      existingOrder.orderStatus === "Going to Pickup"
    ) {
      console.log(`🛑 Order ${orderId} already assigned. Skipping retry.`);
      await Promise.all(
        availableDrivers.map((d) =>
          removePendingDriverOffer(d._id.toString(), orderId),
        ),
      );
      cleanupAllListeners();
      return;
    }

    const isStillUnassigned =
      !orderAssigned &&
      (!existingOrder?.driver ||
        existingOrder?.orderStatus !== "Going to Pickup");

    if (isStillUnassigned) {
      const allDriverIds = new Set(drivers.map((d) => d._id.toString()));
      const allRejected = rejectedDrivers.size === allDriverIds.size;
      const noResponsesThisCycle = respondedDriversThisCycle.size === 0;
      const shouldResetRejectedDrivers = allRejected || noResponsesThisCycle;

      if (shouldResetRejectedDrivers) {
        console.info(
          `🔁 All drivers rejected or no response for order ${orderId}. Retrying with all drivers...`,
        );
        await updateDispatchState(
          orderId,
          {
            $set: { rejectedDrivers: [] },
          },
          async (redis, keys) => {
            await redis.del(keys.rejectedDrivers);
          },
        );
      } else {
        console.info(
          `⏱️ No driver accepted order ${orderId}. Retrying with remaining drivers...`,
        );
        await updateDispatchState(
          orderId,
          {
            $set: { rejectedDrivers: Array.from(rejectedDrivers) },
          },
          async (redis, keys) => {
            await redis.del(keys.rejectedDrivers);
            if (rejectedDrivers.size) {
              await redis.sAdd(
                keys.rejectedDrivers,
                Array.from(rejectedDrivers),
              );
            }
          },
        );
      }

      cleanupAllListeners();
      await Promise.all(
        availableDrivers.map((d) =>
          removePendingDriverOffer(d._id.toString(), orderId),
        ),
      );
      //assignWithBroadcast(order, drivers);
      const autoAssignDriver = require("./AutoAssignDriver");
      if (existingOrder?._id) {
        autoAssignDriver(existingOrder._id);
      }
    } else {
      console.log(`✅ Order ${orderId} assigned. Cleaning up.`);
      await Promise.all(
        availableDrivers.map((d) =>
          removePendingDriverOffer(d._id.toString(), orderId),
        ),
      );
      cleanupAllListeners();
    }
  }, TIMEOUT_MS);

  orderTimeouts.set(orderId, timeout);
};

module.exports = assignWithBroadcast;
module.exports.updateDispatchState = updateDispatchState;
module.exports.clearDispatchTimeout = clearDispatchTimeout;
module.exports.getBusyDriverIds = getBusyDriverIds;
module.exports.isDriverBusyForOrder = isDriverBusyForOrder;
