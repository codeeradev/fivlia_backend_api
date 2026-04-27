const {
  driverSocketMap,
  getDynamicRetryCount,
} = require("../../utils/driverSocketMap");
const Assign = require("../../modals/driverModals/assignments");
const Address = require("../../modals/Address");
const { Order } = require("../../modals/order");
const admin = require("../../firebase/firebase");
const Store = require("../../modals/store");
const User = require("../../modals/User");
const { SettingAdmin } = require("../../modals/setting");
const { notifyEntity } = require("../../utils/notifyStore");
// new socket code of user order status
const {
  emitUserOrderStatusUpdate,
} = require("../../utils/emitUserOrderStatusUpdate");

const assignedOrders = new Set();
const rejectedDriversMap = new Map();
const retryTracker = new Map();
const orderTimeouts = new Map();

const assignWithBroadcast = async (order, drivers) => {
  const orderId = order.orderId.toString();

  if (assignedOrders.has(orderId)) {
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

  console.log(
    `⚙️ Auto-adjusted retries: ${MAX_RETRY_COUNT} x ${
      TIMEOUT_MS / 1000
    }s = ${cancelAfterMinutes} min`,
  );

  const retryCount = retryTracker.get(orderId) || 0;
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
          await admin.messaging().send({
            token: user.fcmToken,
            notification: {
              title: "Order Cancelled ❌",
              body: `Your order #${orderId} was cancelled as no driver accepted.`,
            },
            android: {
              notification: { channelId: "default_channel", sound: "default" },
            },
            data: { type: "cancelled", orderId },
          });
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
    return;
  }

  retryTracker.set(orderId, retryCount + 1);

  let orderAssigned = false;
  const respondedDrivers = new Set();

  const orderStore = await Store.findOne({ _id: order.storeId }).lean();
  const orderUser = await User.findOne({ _id: order.userId }).lean();

  const rejectedDrivers = rejectedDriversMap.get(orderId) || new Set();

  const availableDrivers = drivers.filter(
    (driver) => !rejectedDrivers.has(driver._id.toString()),
  );

  if (availableDrivers.length === 0) {
    console.info(`😕 No available drivers to broadcast for order ${orderId}`);
    // return;
  }

  const cleanupAllListeners = () => {
    availableDrivers.forEach((driver) => {
      const driverId = driver._id.toString();
      const socket = driverSocketMap.get(driverId);
      if (socket && typeof socket.__cleanupOrder === "function") {
        socket.__cleanupOrder();
        delete socket.__cleanupOrder;
      }
    });
  };

  const broadcastOrder = () => {
    console.log(
      `📢 Broadcasting order ${orderId} to ${availableDrivers.length} drivers...`,
    );

    // 🔹 Step 1: Send FCM to ALL available drivers (socket or not)
    availableDrivers.forEach((driver) => {
      const driverId = driver._id.toString();

      if (driver.fcmToken) {
        admin
          .messaging()
          .send({
            token: driver.fcmToken,
            notification: {
              title: "New Order Request 🚗",
              body: `Order #${orderId} is waiting for your response`,
            },
            android: {
              notification: {
                channelId: "custom_sound_channel",
                sound: "custom_sound",
              },
            },
            data: {
              orderId,
              timeLeft: (TIMEOUT_MS / 1000).toString(),
              screen: "TodayOrderScreen",
            },
          })
          .then(() => {
            console.log(`📩 Push sent to driver ${driverId}`);
          })
          .catch((err) => console.error("Push error:", err));
      }
    });

    // 🔹 Step 2: Emit socket event only for online drivers
    availableDrivers.forEach((driver) => {
      const driverId = driver._id.toString();
      const socket = driverSocketMap.get(driverId);

      if (!socket) {
        console.log(`📱 Driver ${driverId} offline, push-only mode`);
        return;
      }

      const orderWithLocation = {
        ...(order.toObject ? order.toObject() : order),
        storeName: orderStore.storeName,
        storeLat: orderStore.Latitude,
        storeLng: orderStore.Longitude,
        userLat: orderUser.location.latitude,
        userLng: orderUser.location.longitude,
      };

      socket.emit("newOrder", {
        order: orderWithLocation,
        driverId,
        timeLeft: TIMEOUT_MS / 1000,
      });

      console.log(`✅ Socket order ${orderId} sent to driver ${driverId}`);

      // --- Accept Handler ---
      const handleAccept = async (
        { driverId: incomingDriverId, orderId: incomingOrderId },
        callback,
      ) => {
        if (
          incomingOrderId !== orderId ||
          incomingDriverId !== driverId ||
          orderAssigned
        )
          return;

        // Atomic DB update to prevent race condition
        const updateResult = await Order.findOneAndUpdate(
          { orderId, "driver.driverId": { $exists: false } },
          {
            driver: {
              driverId,
              name: driver.driverName,
              mobileNumber: driver.address?.mobileNo,
            },
            orderStatus: "Going to Pickup",
          },
          { new: true },
        );

        if (!updateResult) {
          socket.emit("orderAlreadyAccepted", { orderId });
          if (callback) {
            callback({
              status: false,
              message: "Order already accepted",
            });
          }

          console.warn(`🉑 orderAlreadyAccepted for ${driverId} - ${orderId}`);
          return;
        }

        // new socket code of user order status
        await emitUserOrderStatusUpdate(
          updateResult,
          "assignDriver.driverAccepted",
        );

        assignedOrders.add(orderId);
        orderAssigned = true;

        console.log(`🎉 Driver ${driverId} accepted order ${orderId}`);

        if (orderTimeouts.has(orderId)) {
          clearTimeout(orderTimeouts.get(orderId));
          orderTimeouts.delete(orderId);
          console.log(`🧹 Cleared timeout for order ${orderId}`);
        }

        await Assign.updateOne(
          { driverId, orderId },
          { $set: { orderStatus: "Accepted" } },
          { upsert: true },
        );

        availableDrivers.forEach((d) => {
          const otherSocket = driverSocketMap.get(d._id.toString());
          if (d._id.toString() !== driverId && otherSocket) {
            otherSocket.emit("orderTaken", { orderId });
          }
        });

        if (callback) {
          callback({
            status: true,
            message: "Order accepted successfully",
            orderId,
          });
        }

        cleanupAllListeners();
      };

      // --- Reject Handler ---
      const handleReject = async ({
        driverId: incomingDriverId,
        orderId: incomingOrderId,
      }) => {
        if (
          incomingOrderId !== orderId ||
          incomingDriverId !== driverId ||
          orderAssigned
        )
          return;

        respondedDrivers.add(driverId);
        rejectedDrivers.add(driverId);

        await Assign.updateOne(
          { driverId, orderId },
          { $set: { orderStatus: "Rejected" } },
          { upsert: true },
        );

        console.log(`❌ Driver ${driverId} rejected order ${orderId}`);
      };

      // Attach Listeners
      socket.once("acceptOrder", (data, callback) => {
        handleAccept(data, callback);
      });
      socket.once("rejectOrder", handleReject);
      socket.once("disconnect", () => {
        socket.__cleanupOrder?.();
      });

      socket.__cleanupOrder = () => {
        socket.off("acceptOrder", handleAccept);
        socket.off("rejectOrder", handleReject);
      };
    });
  };

  broadcastOrder();

  const timeout = setTimeout(async () => {
    orderTimeouts.set(orderId, timeout);
    const existingOrder = await Order.findOne({ orderId }).lean();

    if (
      existingOrder?.driver &&
      existingOrder.orderStatus === "Going to Pickup"
    ) {
      console.log(`🛑 Order ${orderId} already assigned. Skipping retry.`);
      cleanupAllListeners();
      return;
    }

    const isStillUnassigned =
      !orderAssigned &&
      !assignedOrders.has(orderId) &&
      (!existingOrder?.driver ||
        existingOrder?.orderStatus !== "Going to Pickup");

    if (isStillUnassigned) {
      const allDriverIds = new Set(drivers.map((d) => d._id.toString()));
      const allRejectedOrNoResponse =
        rejectedDrivers.size === allDriverIds.size ||
        respondedDrivers.size === 0;

      if (allRejectedOrNoResponse) {
        console.info(
          `🔁 All drivers rejected or no response for order ${orderId}. Retrying with all drivers...`,
        );
        rejectedDriversMap.set(orderId, new Set());
      } else {
        console.info(
          `⏱️ No driver accepted order ${orderId}. Retrying with remaining drivers...`,
        );
        rejectedDriversMap.set(orderId, rejectedDrivers);
      }

      cleanupAllListeners();
      //assignWithBroadcast(order, drivers);
      const autoAssignDriver = require("./AutoAssignDriver");
      autoAssignDriver(existingOrder._id);
    } else {
      console.log(`✅ Order ${orderId} assigned. Cleaning up.`);
      cleanupAllListeners();
    }
  }, TIMEOUT_MS);
};

module.exports = assignWithBroadcast;
