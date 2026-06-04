const Dispatch = require("../modals/dispatch");
const { Order } = require("../modals/order");
const autoAssignDriver = require("../config/driverOrderAccept/AutoAssignDriver");

async function resumePendingDispatch() {
  try {
    const pendingDispatch = await Dispatch.find({
      assigned: false,
      status: "pending",
    }).lean();

    console.log("Resuming dispatch for orders:", pendingDispatch.length);

    for (const d of pendingDispatch) {
      const order = await Order.findOne({ orderId: d.orderId }).lean();
      if (!order) continue;
      if (
        ["Cancelled", "Delivered"].includes(order.orderStatus) ||
        (order.driver && order.orderStatus === "Going to Pickup")
      ) {
        continue;
      }

      console.log("Resuming order:", order.orderId);
      // Await to avoid starting too many assignment loops at once after reboot.
      await autoAssignDriver(order._id);
    }
  } catch (err) {
    console.error("Resume dispatch error:", err);
  }
}

module.exports = { resumePendingDispatch };
