const Dispatch = require("../modals/dispatch");
const { Order } = require("../modals/order");
const autoAssignDriver = require("../config/driverOrderAccept/AutoAssignDriver");

async function resumePendingDispatch() {
  try {

    const pendingDispatch = await Dispatch.find({
      assigned: false,
      status: "pending"
    });

    console.log("Resuming dispatch for orders:", pendingDispatch.length);

    for (const d of pendingDispatch) {

      const order = await Order.findOne({ orderId: d.orderId });

      if (!order) continue;
      if (order.orderStatus === "Cancelled") continue;

      console.log("Resuming order:", order.orderId);

      autoAssignDriver(order._id);
    }

  } catch (err) {
    console.error("Resume dispatch error:", err);
  }
}

module.exports = {resumePendingDispatch};