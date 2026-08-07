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
} = require("../../utils/pushSoundConfig");
const { getRedisClient } = require("../../utils/redisClient");
const {
  upsertPendingDriverOffer,
  removePendingDriverOffer,
} = require("../../utils/pendingDriverOffers");
// new socket code of user order status
const {
  emitUserOrderStatusUpdate,
} = require("../../utils/emitUserOrderStatusUpdate");

// Tracks the active retry timer for each orderId.
const orderTimeouts = new Map();

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

// Adds and removes order-specific socket listeners safely.
const registerSocketOrderListeners = (socket, orderKey, handlers) => {
  if (!socket.__orderListenerRegistry) {
    socket.__orderListenerRegistry = new Map();
  }

  const { onAccept, onReject, onDisconnect } = handlers;
  socket.on("acceptOrder", onAccept);
  socket.on("rejectOrder", onReject);
  socket.on("disconnect", onDisconnect);

  socket.__orderListenerRegistry.set(orderKey, handlers);
};

const removeSocketOrderListeners = (socket, orderKey) => {
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

  const availableDrivers = drivers.filter(
    (driver) => !rejectedDrivers.has(driver._id.toString()),
  );

  if (availableDrivers.length === 0) {
    console.info(`😕 No available drivers to broadcast for order ${orderId}`);
    // return;
  }

  const cleanupAllListeners = () => {
    availableDrivers.forEach(async (driver) => {
      const driverId = driver._id.toString();
      const socket = driverSocketMap.get(driverId);
      removeSocketOrderListeners(socket, orderKey);
    });
  };

  const broadcastOrder = () => {
    console.log(
      `📢 Broadcasting order ${orderId} to ${availableDrivers.length} drivers...`,
    );

    // 🔹 Step 1: Send FCM to ALL available drivers (socket or not)
    availableDrivers.forEach(async (driver) => {
      const driverId = driver._id.toString();

      if (driver.fcmToken) {
        await telegramOrderLog("📲 PUSH ATTEMPT", {
          orderId,
          driverId,
        });
        admin
          .messaging()
          .send({
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
                channel_id: "delivery_alerts_v3",
                sound: "custom_sound",
                default_sound: false,
              },
            },
          })
          .then(async () => {
            console.log(`📩 Push sent to driver ${driverId}`);

            await telegramOrderLog("📲 PUSH SENT TO DRIVER", {
              orderId,
              driverId,
            });
          })
          .catch(async (err) => {
            console.error("Push error:", err);

            await telegramOrderLog("❌ PUSH FAILED", {
              orderId,
              driverId,
              errorCode: err.code || "UNKNOWN",
              error: err.message,
            });
          });
      }
    });

    // 🔹 Step 2: Emit socket event only for online drivers
    availableDrivers.forEach(async (driver) => {
      const driverId = driver._id.toString();
      const socket = driverSocketMap.get(driverId);

      telegramOrderLog("🔌 DRIVER SOCKET STATUS", {
        driverId,
        socketExists: !!socket,
        socketId: socket?.id || null,
        socketConnected: socket?.connected === true,
        orderId,
      }).catch((error) => {
        console.error("Telegram socket-status log failed:", error.message);
      });

      if (!socket) {
        console.log(
          `📱 Driver ${driverId} not connected to socket, push-only mode`,
        );
        return;
      }

      if (socket.connected !== true) {
        console.log(`⚠️ Driver ${driverId} socket exists but is disconnected`);
        return;
      }

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

        telegramOrderLog("🟡 DRIVER ACCEPT REQUEST RECEIVED", {
          orderId,
          expectedOrderId: orderId,

          incomingOrderId,

          driverId,
          incomingDriverId,

          orderAssigned,

          driverName: driver?.driverName,

          socketId: socket?.id || null,

          timestamp: new Date().toISOString(),
        }).catch((error) => {
          console.error("Telegram accept-request log failed:", error.message);
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
              orderId,
            });

            return;
          }

          if (
            incomingOrderId !== orderId ||
            incomingDriverId !== driverId ||
            orderAssigned
          ) {
            const reason =
              incomingOrderId !== orderId
                ? "ORDER_ID_MISMATCH"
                : incomingDriverId !== driverId
                  ? "DRIVER_ID_MISMATCH"
                  : "ALREADY_ASSIGNED";

            console.warn("❌ ACCEPT VALIDATION FAILED", {
              orderId,
              incomingOrderId,

              driverId,
              incomingDriverId,

              orderAssigned,
              reason,
            });

            telegramOrderLog("❌ ACCEPT VALIDATION FAILED", {
              orderId,
              incomingOrderId,

              driverId,
              incomingDriverId,

              orderAssigned,
              reason,
            }).catch((error) => {
              console.error("Telegram validation log failed:", error.message);
            });

            sendCallback({
              status: false,
              success: false,
              message:
                reason === "ALREADY_ASSIGNED"
                  ? "Order already accepted"
                  : "Invalid order accept request",
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
              orderId,
            });

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

          console.log("🟠 TRYING ORDER UPDATE", {
            orderId,
            driverId,
            driverName: driver.driverName,
            orderStatus: "Going to Pickup",
          });

          telegramOrderLog("🟠 TRYING ORDER UPDATE", {
            orderId,
            driverId,
            driverName: driver.driverName,
            orderStatus: "Going to Pickup",
          }).catch((error) => {
            console.error("Telegram trying-update log failed:", error.message);
          });

          /*
           * Atomic update:
           * Sirf wahi request successful hogi jisme driver pehle assigned nahi hai.
           */
          const updateResult = await Order.findOneAndUpdate(
            {
              orderId,
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
            console.warn(
              `🉑 Order already accepted/not available: ${driverId} - ${orderId}`,
            );

            telegramOrderLog("❌ ORDER UPDATE FAILED", {
              orderId,
              driverId,
              reason: "ORDER_ALREADY_ACCEPTED_OR_NOT_FOUND",
            }).catch((error) => {
              console.error(
                "Telegram update-failed log failed:",
                error.message,
              );
            });

            socket.emit("orderAlreadyAccepted", {
              orderId,
            });

            sendCallback({
              status: false,
              success: false,
              message: "Order already accepted",
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

          telegramOrderLog("✅ DRIVER ACCEPTED", {
            orderId,
            driverId,
            driverName: driver.driverName,
          }).catch((error) => {
            console.error("Telegram accepted log failed:", error.message);
          });

          /*
           * Dusre drivers se same order remove karo.
           */
          availableDrivers.forEach((availableDriver) => {
            const otherDriverId = availableDriver._id.toString();

            if (otherDriverId === driverId) {
              return;
            }

            const otherSocket = driverSocketMap.get(otherDriverId);

            if (otherSocket?.connected) {
              otherSocket.emit("orderTaken", {
                orderId,
                acceptedBy: driverId,
              });
            }
          });

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
            error: err.message,
            orderId,
          });

          telegramOrderLog("❌ DRIVER ACCEPT FAILED", {
            orderId,
            driverId,
            driverName: driver?.driverName,
            reason: err.message,
          }).catch((telegramError) => {
            console.error(
              "Telegram accept-error log failed:",
              telegramError.message,
            );
          });
        }
      };

      // ---------------- REJECT HANDLER ----------------

      const handleReject = async (payload = {}) => {
        const incomingDriverId = payload?.driverId?.toString().trim() || "";

        const incomingOrderId = payload?.orderId?.toString().trim() || "";

        if (
          incomingOrderId !== orderId ||
          incomingDriverId !== driverId ||
          orderAssigned
        ) {
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

        telegramOrderLog("❌ DRIVER REJECTED", {
          orderId,
          driverId,
          driverName: driver.driverName,
        }).catch((error) => {
          console.error("Telegram reject log failed:", error.message);
        });

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

      const onReject = (data) => {
        console.log("📥 RAW rejectOrder EVENT RECEIVED", {
          orderId,
          driverId,
          socketId: socket.id,
          data,
        });

        handleReject(data).catch((error) => {
          console.error("❌ Reject handler error:", error);
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

      telegramOrderLog("📤 ORDER SENT TO DRIVER SOCKET", {
        orderId,
        driverId,
        socketId: socket.id,
        timeLeft: TIMEOUT_MS / 1000,
      }).catch((error) => {
        console.error("Telegram order-sent log failed:", error.message);
      });

      /*
       * Pending-offer flow same rakha hai.
       * Iska await listener registration ko delay nahi karega,
       * kyunki listener aur socket emit already ho chuke hain.
       */
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

        telegramOrderLog("⚠️ PENDING DRIVER OFFER SAVE FAILED", {
          orderId,
          driverId,
          socketId: socket.id,
          reason: pendingOfferError.message,
        }).catch((logError) => {
          console.error("Telegram pending-offer log failed:", logError.message);
        });
      }
    });
  };

  broadcastOrder();

  // Ensure only one active retry timer exists for this order.
  clearDispatchTimeout(orderId);

  const timeout = setTimeout(async () => {
    orderTimeouts.delete(orderId);
    const existingOrder = await Order.findOne({ orderId }).lean();

    if (existingOrder.orderStatus === "Cancelled") {
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
