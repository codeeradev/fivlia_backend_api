// NEW FILE: controlers/returnControler.js
// POST /order/return/:orderId   (customer / mobile app, user token)
// Body: { reason (required), note?, items?: [{ productId, varientId?, quantity? }] }
// No "items" = return everything that is still returnable.

const mongoose = require("mongoose");
const { Order } = require("../modals/order");
const {
  itemKey,
  remainingQtyMap,
  getReturnEligibility,
} = require("../utils/returnPolicy");

exports.requestReturn = async (req, res) => {
  try {
    const { orderId } = req.params;
    const body = req.body || {};
    const reason = String(body.reason || "").trim();
    const note = String(body.note || "").trim();

    if (reason.length < 3 || reason.length > 300) {
      return res.status(400).json({
        status: false,
        message: "Return reason is required (3 to 300 characters)",
      });
    }
    if (note.length > 500) {
      return res
        .status(400)
        .json({ status: false, message: "Note is too long (max 500 characters)" });
    }
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }

    const order = await Order.findOne({ _id: orderId, userId: req.user._id }).lean();
    if (!order) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }

    const eligibility = getReturnEligibility(order);
    if (!eligibility.canRequestReturn) {
      return res
        .status(400)
        .json({ status: false, message: eligibility.reason, returnInfo: eligibility });
    }

    const remaining = remainingQtyMap(order);
    const wanted = [];

    if (Array.isArray(body.items) && body.items.length) {
      const seen = new Set();
      for (const row of body.items) {
        const orderItem = order.items.find(
          (it) =>
            String(it.productId) === String(row?.productId) &&
            (!row?.varientId || String(it.varientId) === String(row.varientId)),
        );
        if (!orderItem) {
          return res.status(400).json({
            status: false,
            message: "An item in the request is not part of this order",
          });
        }
        const realKey = itemKey(orderItem.productId, orderItem.varientId);
        if (seen.has(realKey)) {
          return res
            .status(400)
            .json({ status: false, message: "Same item sent twice" });
        }
        seen.add(realKey);

        const left = remaining.get(realKey) || 0;
        const qty = row?.quantity === undefined ? left : Number(row.quantity);
        if (!Number.isInteger(qty) || qty < 1) {
          return res
            .status(400)
            .json({ status: false, message: "Item quantity must be a whole number, 1 or more" });
        }
        if (qty > left) {
          return res.status(400).json({
            status: false,
            message: `Only ${left} unit(s) of ${orderItem.name} can still be returned`,
          });
        }
        wanted.push({ orderItem, qty });
      }
    } else {
      const done = new Set();
      for (const it of order.items) {
        const k = itemKey(it.productId, it.varientId);
        if (done.has(k)) continue;
        done.add(k);
        const left = remaining.get(k) || 0;
        if (left > 0) wanted.push({ orderItem: it, qty: left });
      }
    }

    if (!wanted.length) {
      return res
        .status(400)
        .json({ status: false, message: "Nothing to return" });
    }

    const returnRequest = {
      _id: new mongoose.Types.ObjectId(),
      status: "requested",
      reason,
      note,
      requestedAt: new Date(),
      items: wanted.map(({ orderItem, qty }) => ({
        productId: orderItem.productId,
        varientId: orderItem.varientId,
        name: orderItem.name,
        image: orderItem.image,
        price: orderItem.price,
        quantity: qty,
      })),
    };

    // Only add while the order is still Delivered (a concurrent change wins)
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, userId: req.user._id, orderStatus: order.orderStatus },
      { $push: { returnRequests: returnRequest } },
      { new: true },
    ).lean();

    if (!updated) {
      return res
        .status(409)
        .json({ status: false, message: "Order changed, please try again" });
    }

    return res.status(200).json({
      status: true,
      message: "Return request submitted",
      returnRequest,
      returnInfo: getReturnEligibility(updated),
    });
  } catch (error) {
    console.error("requestReturn error:", error.message);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};
