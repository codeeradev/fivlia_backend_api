const {
  driverSocketMap,
  sellerSocketMap,
  adminSocketMap,
  userSocketMap,
} = require("../utils/driverSocketMap");
const { updateDriverStatus } = require("../controlers/driverControler");
const { getPendingDriverOffers } = require("../utils/pendingDriverOffers");
const { Order } = require("../modals/order");
const { getDriverSocketRouter } = require("./driverSocketRouter");
const autoAssignDriver = require("../config/driverOrderAccept/AutoAssignDriver");
const Driver = require("../modals/driver");
const {
  isDriverBusyForOrder,
} = require("../config/driverOrderAccept/assignDriver");
const { removePendingDriverOffer } = require("../utils/pendingDriverOffers");
const {
  recoverPendingDriverOffers,
} = require("../utils/pendingOrderRecovery");

const replayPendingOrdersToDriver = async (socket, driverId) => {
  const router = getDriverSocketRouter(socket);
  return recoverPendingDriverOffers({
    driverId,
    getPendingOffers: getPendingDriverOffers,
    findOrderByOrderId: (orderId) => Order.findOne({ orderId }).lean(),
    removePendingOffer: removePendingDriverOffer,
    recreateDispatch: autoAssignDriver,
    isSocketConnected: () => socket.connected === true,
    isHandlerReady: (orderId) => router?.has(orderId) === true,
    isOfferStillEligible: async ({ orderId }) => {
      const driver = await Driver.findOne({
        _id: driverId,
        status: true,
        activeStatus: "online",
      })
        .select("driverId")
        .lean();
      if (!driver) return false;

      return !(await isDriverBusyForOrder(
        [String(driverId), driver.driverId?.toString()].filter(Boolean),
        orderId,
      ));
    },
  });
};

module.exports = (io) => {
  io.on("connection", (socket) => {
    getDriverSocketRouter(socket);
    console.log("Driver connected:", socket.id);

    socket.on("updateDriverStatus", async (payload) => {
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          console.error("Failed to parse payload:", payload);
          return;
        }
      }

      const { driverId, status } = payload || {};
      if (socket.data.driverLoggedOut && status !== "offline") return;
      const result = await updateDriverStatus(driverId, status);

      if (socket.data.driverLoggedOut && status !== "offline") {
        await updateDriverStatus(driverId, "offline");
        return;
      }

      if (result.success) {
        // Keep in-memory socket map aligned with persisted driver status.
        // if (status === "online") {
        
        const previousSocket = driverSocketMap.get(String(driverId));
        if (previousSocket && previousSocket !== socket && previousSocket.connected) {
          previousSocket.disconnect(true);
        }
        driverSocketMap.set(String(driverId), socket);
        console.log("driverSocketMap entries:", [...driverSocketMap.keys()]);
        // } else {
        //   driverSocketMap.delete(driverId);
        // }

        io.emit("activeStatus", {
          message: "Driver status updated",
          driverId,
          status,
        });
      } else {
        socket.emit("statusUpdateError", {
          message: result.message,
          error: result.error,
        });
      }
    });

    socket.on("joinSeller", (payload) => {
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          console.error("Failed to parse payload:", payload);
          return;
        }
      }

      const { storeId } = payload || {};
      if (!storeId) return;

      sellerSocketMap.set(storeId, socket);
      console.log("Seller connected:", storeId);
      console.log("sellerSocketMap keys:", [...sellerSocketMap.keys()]);

      socket.emit("joinedSellerRoom", {
        message: "Seller joined successfully",
        storeId,
      });
    });

    socket.on("joinAdmin", () => {
      adminSocketMap.set("admin", socket);
      console.log("Admin connected");
      socket.emit("joinedAdminRoom", { message: "Admin joined successfully" });
    });

    socket.on("joinUser", (payload) => {
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          console.error("Failed to parse joinUser payload:", payload);
          return;
        }
      }

      const { userId } = payload || {};
      if (!userId) return;

      userSocketMap.set(userId, socket);
      console.log("User connected:", userId);
      socket.emit("joinedUserRoom", {
        message: "User joined successfully",
        userId,
      });
    });

    socket.on("driverReadyForOrders", async (payload) => {
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          console.error(
            "Failed to parse driverReadyForOrders payload:",
            payload,
          );
          return;
        }
      }

      const { driverId, status } = payload || {};
      if (!driverId) return;
      if (socket.data.driverLoggedOut) return;

      try {
        // Socket.IO invokes async event handlers independently, so the prior
        // updateDriverStatus event may still be writing MongoDB. Applying the
        // status carried by this handshake removes that race before checking
        // online/busy eligibility and recovering cards.
        if (status) {
          const statusResult = await updateDriverStatus(driverId, status);
          if (!statusResult.success) {
            throw new Error(
              statusResult.message || "Driver status update failed",
            );
          }
        }

        // driverReadyForOrders is also the recovery handshake. Keep the map
        // correct even if updateDriverStatus was missed during a reconnect.
        const previousSocket = driverSocketMap.get(String(driverId));
        if (
          previousSocket &&
          previousSocket !== socket &&
          previousSocket.connected
        ) {
          previousSocket.disconnect(true);
        }
        driverSocketMap.set(String(driverId), socket);

        const orders = await replayPendingOrdersToDriver(socket, driverId);
        console.log("PENDING ORDERS SYNCED TO DRIVER APP", {
          driverId: String(driverId),
          socketId: socket.id,
          replayed: orders.length,
        });
        socket.emit("driverPendingOrdersSynced", {
          success: true,
          driverId: String(driverId),
          replayed: orders.length,
          orders,
        });
      } catch (error) {
        console.error("Pending order sync failed:", {
          driverId: String(driverId),
          socketId: socket.id,
          error: error.message,
        });
        socket.emit("driverPendingOrdersSynced", {
          success: false,
          driverId: String(driverId),
          replayed: 0,
          orders: [],
          reason: "RECOVERY_FAILED",
        });
      }
    });

    socket.on("orderOfferReceived", (payload = {}, callback) => {
      const orderId = String(payload.orderId || "").trim();
      const driverId = String(payload.driverId || "").trim();
      console.log("ORDER RECEIVED BY DRIVER APP", {
        orderId,
        driverId,
        socketId: socket.id,
      });
      if (typeof callback === "function") {
        callback({ success: Boolean(orderId), orderId });
      }
    });

    socket.on("driverLogout", async (payload = {}, callback) => {
      const driverId = String(payload.driverId || "").trim();
      socket.data.driverLoggedOut = true;
      try {
        if (driverId) {
          await updateDriverStatus(driverId, "offline");
          if (driverSocketMap.get(driverId) === socket) {
            driverSocketMap.delete(driverId);
          }
        }
        getDriverSocketRouter(socket)?.clear();
        if (typeof callback === "function") {
          callback({ success: true, driverId });
        }
      } catch (error) {
        console.error("Driver logout cleanup failed:", error);
        if (typeof callback === "function") {
          callback({ success: false, driverId, reason: "LOGOUT_FAILED" });
        }
      }
    });

    socket.on("ping", (data = {}) => {
      socket.emit("pong", {
        success: true,
        timestamp: data.timestamp || new Date().toISOString(),
        serverTime: new Date().toISOString(),
      });

      console.log(
        `💓 Heartbeat from ${socket.id} at ${data.timestamp || "N/A"}`,
      );
    });

    socket.on("instructionRead", async ({ orderId }) => {
      const order = await Order.findOneAndUpdate(
        { orderId },
        {
          instructionStatus: "read",
        },
        {
          new: true,
        },
      );

      if (!order) return;

      const userSocket = userSocketMap.get(order.userId.toString());

      if (userSocket) {
        userSocket.emit("instructionRead", {
          orderId,
          status: "read",
        });
      }
    });

    socket.on("disconnect", () => {
      for (const [driverId, s] of driverSocketMap.entries()) {
        if (s.id === socket.id) driverSocketMap.delete(driverId);
      }
      for (const [storeId, s] of sellerSocketMap.entries()) {
        if (s.id === socket.id) sellerSocketMap.delete(storeId);
      }
      for (const [adminId, s] of adminSocketMap.entries()) {
        if (s.id === socket.id) adminSocketMap.delete(adminId);
      }
      for (const [userId, s] of userSocketMap.entries()) {
        if (s.id === socket.id) userSocketMap.delete(userId);
      }
    });
  });
};
