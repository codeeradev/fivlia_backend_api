const routers = new WeakMap();

const defaultModelProvider = () => ({
  Order: require("../modals/order").Order,
  Assign: require("../modals/driverModals/assignments"),
});
let modelProvider = defaultModelProvider;

const normalizeId = (value) => (value == null ? "" : String(value).trim());

function createRouter(socket) {
  const pending = new Map();
  const reply = (ack, response) => {
    if (typeof ack === "function") ack(response);
  };
  const recoverCompletedAction = async (eventName, payload, ack, orderId) => {
    const { Order, Assign } = modelProvider();
    const driverId = normalizeId(payload?.driverId);
    if (eventName === "accept") {
      const order = await Order.findOne({ orderId })
        .select("driver.driverId orderStatus")
        .lean();
      const acceptedDriverId = normalizeId(order?.driver?.driverId);
      if (order && acceptedDriverId === driverId && order.orderStatus === "Going to Pickup") {
        reply(ack, {
          status: true,
          success: true,
          message: "Order already accepted by this driver",
          reason: "ALREADY_ACCEPTED_BY_DRIVER",
          orderId,
          driverId,
        });
        return;
      }
      reply(ack, {
        status: false,
        success: false,
        message: acceptedDriverId ? "Order already accepted" : "Order is no longer available",
        reason: acceptedDriverId ? "ALREADY_ACCEPTED" : "OFFER_NOT_FOUND",
        orderId,
      });
      return;
    }

    const rejected = await Assign.findOne({
      orderId,
      driverId,
      orderStatus: "Rejected",
    })
      .select("_id")
      .lean();
    if (rejected) {
      reply(ack, {
        status: true,
        success: true,
        message: "Order already rejected by this driver",
        reason: "ALREADY_REJECTED",
        orderId,
        driverId,
      });
      return;
    }
    reply(ack, {
      status: false,
      success: false,
      message: "Order is no longer available",
      reason: "OFFER_NOT_FOUND",
      orderId,
    });
  };
  const route = async (eventName, payload, ack) => {
    const orderId = normalizeId(payload?.orderId);
    const entry = pending.get(orderId);
    if (!orderId) {
      reply(ack, {
        status: false,
        success: false,
        message: "orderId is required",
        reason: "INVALID_REQUEST",
        orderId,
      });
      return;
    }
    if (!entry || typeof entry[eventName] !== "function") {
      try {
        await recoverCompletedAction(eventName, payload, ack, orderId);
      } catch (error) {
        console.error(`Driver ${eventName} recovery failed:`, error);
        reply(ack, {
          status: false,
          success: false,
          message: "Request failed",
          reason: "INTERNAL_ERROR",
          orderId,
        });
      }
      return;
    }
    try {
      await entry[eventName](payload, ack);
    } catch (error) {
      console.error(`Driver ${eventName} handler failed:`, error);
      reply(ack, {
        status: false,
        success: false,
        message: "Request failed",
        reason: "INTERNAL_ERROR",
        orderId,
      });
    }
  };
  const onAccept = (payload, ack) => void route("accept", payload, ack);
  const onReject = (payload, ack) => void route("reject", payload, ack);
  const onDisconnect = () => {
    // Pending offers live in Redis and are recovered on the next connection.
    pending.clear();
    routers.delete(socket);
  };
  socket.on("acceptOrder", onAccept);
  socket.on("rejectOrder", onReject);
  socket.once("disconnect", onDisconnect);
  return {
    register(orderId, handlers) { pending.set(normalizeId(orderId), handlers); },
    has(orderId) { return pending.has(normalizeId(orderId)); },
    unregister(orderId) { pending.delete(normalizeId(orderId)); },
    clear() { pending.clear(); },
    destroy() {
      pending.clear();
      socket.off("acceptOrder", onAccept);
      socket.off("rejectOrder", onReject);
      socket.off("disconnect", onDisconnect);
      routers.delete(socket);
    },
  };
}

function getDriverSocketRouter(socket) {
  if (!socket) return null;
  if (!routers.has(socket)) routers.set(socket, createRouter(socket));
  return routers.get(socket);
}

function setDriverSocketRouterModelProviderForTests(provider) {
  modelProvider = provider || defaultModelProvider;
}

module.exports = {
  getDriverSocketRouter,
  setDriverSocketRouterModelProviderForTests,
};
