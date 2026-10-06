// NEW FILE: controlers/returnControler.js
// POST /order/return/:orderId   (customer / mobile app, user token)
// Content-Type: multipart/form-data  (or JSON when there are no photos)
//   reason  (required)   3-300 characters
//   note    (optional)   up to 500 characters
//   items   (optional)   JSON array string: [{"productId","varientId","quantity"}]
//                        no items = everything still returnable
//   images  (optional)   up to RETURN_MAX_IMAGES photos (form field "images", repeat the field)

const mongoose = require("mongoose");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const s3 = require("../config/aws");
const { Order } = require("../modals/order");
const {
  RETURN_MAX_IMAGES,
  RETURN_IMAGES_REQUIRED,
  itemKey,
  remainingQtyMap,
  getReturnEligibility,
} = require("../utils/returnPolicy");

// Photos are uploaded before validation runs, so remove them again when the request is rejected
const removeUploaded = async (files) => {
  await Promise.all(
    (files || []).map((f) =>
      s3
        .send(new DeleteObjectCommand({ Bucket: process.env.AWS_BUCKET_NAME, Key: f.key }))
        .catch((e) => console.warn("Return image cleanup failed:", f.key, e.message)),
    ),
  );
};

exports.requestReturn = async (req, res) => {
  const uploaded = Array.isArray(req.files) ? req.files : [];

  const reject = async (code, message, extra = {}) => {
    await removeUploaded(uploaded);
    return res.status(code).json({ status: false, message, ...extra });
  };

  try {
    const { orderId } = req.params;
    const body = req.body || {};
    const reason = String(body.reason || "").trim();
    const note = String(body.note || "").trim();

    if (reason.length < 3 || reason.length > 300) {
      return reject(400, "Return reason is required (3 to 300 characters)");
    }
    if (note.length > 500) {
      return reject(400, "Note is too long (max 500 characters)");
    }
    if (RETURN_IMAGES_REQUIRED && !uploaded.length) {
      return reject(400, "Please attach at least one photo of the product");
    }
    if (uploaded.length > RETURN_MAX_IMAGES) {
      return reject(400, `You can upload up to ${RETURN_MAX_IMAGES} images`);
    }

    // items arrives as a JSON string in multipart requests
    let itemsIn = body.items;
    if (typeof itemsIn === "string" && itemsIn.trim()) {
      try {
        itemsIn = JSON.parse(itemsIn);
      } catch (e) {
        return reject(400, "items must be a valid JSON array");
      }
    }
    if (itemsIn !== undefined && itemsIn !== "" && !Array.isArray(itemsIn)) {
      return reject(400, "items must be a valid JSON array");
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return reject(404, "Order not found");
    }

    const order = await Order.findOne({ _id: orderId, userId: req.user._id }).lean();
    if (!order) {
      return reject(404, "Order not found");
    }

    const eligibility = getReturnEligibility(order);
    if (!eligibility.canRequestReturn) {
      return reject(400, eligibility.reason, { returnInfo: eligibility });
    }

    const remaining = remainingQtyMap(order);
    const wanted = [];

    if (Array.isArray(itemsIn) && itemsIn.length) {
      const seen = new Set();
      for (const row of itemsIn) {
        const orderItem = order.items.find(
          (it) =>
            String(it.productId) === String(row?.productId) &&
            (!row?.varientId || String(it.varientId) === String(row.varientId)),
        );
        if (!orderItem) {
          return reject(400, "An item in the request is not part of this order");
        }
        const realKey = itemKey(orderItem.productId, orderItem.varientId);
        if (seen.has(realKey)) {
          return reject(400, "Same item sent twice");
        }
        seen.add(realKey);

        const left = remaining.get(realKey) || 0;
        const qty = row?.quantity === undefined ? left : Number(row.quantity);
        if (!Number.isInteger(qty) || qty < 1) {
          return reject(400, "Item quantity must be a whole number, 1 or more");
        }
        if (qty > left) {
          return reject(400, `Only ${left} unit(s) of ${orderItem.name} can still be returned`);
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
      return reject(400, "Nothing to return");
    }

    const returnRequest = {
      _id: new mongoose.Types.ObjectId(),
      status: "requested",
      reason,
      note,
      images: uploaded.map((f) => `/${f.key}`),
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
      return reject(409, "Order changed, please try again");
    }

    return res.status(200).json({
      status: true,
      message: "Return request submitted",
      returnRequest,
      returnInfo: getReturnEligibility(updated),
    });
  } catch (error) {
    console.error("requestReturn error:", error.message);
    await removeUploaded(uploaded);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};
