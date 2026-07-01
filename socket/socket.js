const {
  driverSocketMap,
  sellerSocketMap,
  adminSocketMap,
  userSocketMap,
} = require("../utils/driverSocketMap");
const { updateDriverStatus } = require("../controlers/driverControler");
const { getPendingDriverOffers } = require("../utils/pendingDriverOffers");
const { Order } = require("../modals/order");


const replayPendingOrdersToDriver = async (socket, driverId) => {
  if (!driverId) return 0;
  const pendingOffers = await getPendingDriverOffers(driverId);
  for (const offer of pendingOffers) {
    socket.emit("newOrder", offer);
  }
  return pendingOffers.length;
};

module.exports = (io) => {
  io.on("connection", (socket) => {
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
      const result = await updateDriverStatus(driverId, status);

      if (result.success) {
        // Keep in-memory socket map aligned with persisted driver status.
        if (status === "online") {
          driverSocketMap.set(driverId, socket);
          console.log("driverSocketMap entries:", [...driverSocketMap.keys()]);
          const replayed = await replayPendingOrdersToDriver(socket, driverId);
          if (replayed > 0) {
            console.log(
              `Replayed ${replayed} pending orders to driver ${driverId}`,
            );
          }
        } else {
          driverSocketMap.delete(driverId);
        }

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

      const { driverId } = payload || {};
      if (!driverId) return;

      const replayed = await replayPendingOrdersToDriver(socket, driverId);
      socket.emit("driverPendingOrdersSynced", {
        driverId,
        replayed,
      });
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
