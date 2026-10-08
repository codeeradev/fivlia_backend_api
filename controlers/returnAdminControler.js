// controlers/returnAdminControler.js
// GET /order/returns                              (store panel + admin panel, list + full details)
// PUT /order/returns/:orderId/:returnId/status    (store panel + admin panel, process a return)
//   requested -> approved | rejected
//   approved  -> picked   | rejected
//   picked    -> refunded
//   rejected / refunded are final
//
// Auth  : sellerOrAdminAuth  -> req.auth = { role: "seller", storeId } | { role: "admin", staffId }
//         seller : always limited to its OWN store (a storeId in the query is ignored)
//         admin  : sees every store; may pass ?storeId= to look at one store
//         admin must have the ORDER_VIEW permission (same permission the Orders page uses)
//
// Query : status  = all | requested | approved | rejected | picked | refunded   (default all)
//         search  = part of the order id, e.g. "OID20"
//         page    = 1,2,3...   (default 1)
//         limit   = 1..100     (default 20)
//         storeId = admin only
//
// The list endpoint never writes. updateReturnStatus is the only writer.

const mongoose = require("mongoose");
const { Order } = require("../modals/order");
const Staff = require("../modals/roleBase/adminStaff");
const Role = require("../modals/roleBase/roles");
const User = require("../modals/User");
const sendNotification = require("../firebase/pushnotification");
const { DEFAULT_PUSH_SOUND } = require("../utils/pushSoundConfig");
const { emitUserOrderStatusUpdate } = require("../utils/emitUserOrderStatusUpdate");

const STATUSES = ["requested", "approved", "rejected", "picked", "refunded"];
const ADMIN_PERMISSION = "ORDER_VIEW";

// current status -> statuses it may move to
const TRANSITIONS = {
  requested: ["approved", "rejected"],
  approved: ["picked", "rejected"],
  picked: ["refunded"],
  rejected: [],
  refunded: [],
};

const round2 = (n) => Number(Number(n || 0).toFixed(2));

// Returns true when the admin may use the returns screens
const adminAllowed = async (staffId) => {
  const staff = await Staff.findById(staffId).select("roleId").lean();
  const role = staff?.roleId
    ? await Role.findById(staff.roleId).select("permissions").lean()
    : null;
  return !!role && (role.permissions || []).includes(ADMIN_PERMISSION);
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildAddress = (a) => {
  if (!a) return { fullName: "N/A", mobileNumber: "", alternateNumber: "", fullAddress: "N/A" };
  const fullAddress =
    [
      a.address || "",
      a.house_No || "",
      a.floor ? `Floor ${a.floor}` : "",
      a.landmark || "",
      a.city || "",
      a.state || "",
      a.pincode || "",
    ]
      .filter(Boolean)
      .join(", ") || "N/A";
  return {
    fullName: a.fullName || "N/A",
    mobileNumber: a.mobileNumber || "",
    alternateNumber: a.alternateNumber || "",
    fullAddress,
  };
};

exports.listReturnRequests = async (req, res) => {
  try {
    const isAdmin = req.auth?.role === "admin";

    // ---- admin must be allowed to view orders --------------------------------
    if (isAdmin && !(await adminAllowed(req.auth.staffId))) {
      return res.status(403).json({ status: false, message: "Permission denied" });
    }

    // ---- query validation ----------------------------------------------------
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const status = String(req.query.status || "all").trim().toLowerCase();
    const search = String(req.query.search || "").trim();

    if (status !== "all" && !STATUSES.includes(status)) {
      return res.status(400).json({ status: false, message: "Invalid status filter" });
    }

    // ---- which store(s) ------------------------------------------------------
    let storeObjectId = null;
    if (!isAdmin) {
      storeObjectId = new mongoose.Types.ObjectId(req.auth.storeId);
    } else if (req.query.storeId) {
      if (!mongoose.Types.ObjectId.isValid(String(req.query.storeId))) {
        return res.status(400).json({ status: false, message: "Invalid storeId" });
      }
      storeObjectId = new mongoose.Types.ObjectId(String(req.query.storeId));
    }

    const orderMatch = { "returnRequests.0": { $exists: true } };
    if (storeObjectId) orderMatch.storeId = storeObjectId;
    if (search) orderMatch.orderId = { $regex: escapeRegex(search), $options: "i" };

    const statusMatch = status === "all" ? [] : [{ $match: { "returnRequests.status": status } }];

    const [result] = await Order.aggregate([
      { $match: orderMatch },
      { $unwind: "$returnRequests" },
      {
        // everything the details window shows
        $project: {
          orderId: 1,
          orderStatus: 1,
          storeId: 1,
          addressId: 1,
          cashOnDelivery: 1,
          paymentStatus: 1,
          totalPrice: 1,
          deliveryCharges: 1,
          platformFee: 1,
          transactionId: 1,
          createdAt: 1,
          items: 1,
          note: 1,
          serviceScope: 1,
          orderDeliveredTime: 1,
          shipping: 1,
          returnRequest: "$returnRequests",
        },
      },
      {
        $facet: {
          counts: [{ $group: { _id: "$returnRequest.status", n: { $sum: 1 } } }],
          total: [...statusMatch, { $count: "n" }],
          rows: [
            ...statusMatch,
            { $sort: { "returnRequest.requestedAt": -1, _id: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
          ],
        },
      },
    ]);

    const rows = result?.rows || [];
    const count = result?.total?.[0]?.n || 0;

    const statusCounts = { all: 0 };
    STATUSES.forEach((s) => (statusCounts[s] = 0));
    for (const c of result?.counts || []) {
      if (c?._id in statusCounts) statusCounts[c._id] = c.n;
      statusCounts.all += c.n;
    }

    await Order.populate(rows, [
      {
        path: "addressId",
        select: "fullName address mobileNumber alternateNumber house_No floor landmark city state pincode",
      },
      { path: "storeId", select: "storeName ownerName PhoneNumber serviceScope" },
    ]);

    const returns = rows.map((row) => {
      const rr = row.returnRequest || {};
      const items = (rr.items || []).map((it) => ({
        productId: it.productId,
        varientId: it.varientId,
        name: it.name,
        image: it.image,
        price: it.price,
        quantity: it.quantity,
        lineTotal: Number(((it.price || 0) * (it.quantity || 0)).toFixed(2)),
      }));
      return {
        returnId: rr._id,
        status: rr.status || "requested",
        reason: rr.reason || "",
        note: rr.note || "",
        images: Array.isArray(rr.images) ? rr.images : [], // paths like /ReturnImages/xxx.jpg
        requestedAt: rr.requestedAt || null,
        rejectReason: rr.rejectReason || "",
        pickup: rr.pickup || null,
        refund: rr.refund || null,
        history: (rr.history || []).map((h) => ({
          status: h.status,
          by: h.by || "",
          note: h.note || "",
          at: h.at || null,
        })),
        allowedNext: TRANSITIONS[rr.status || "requested"] || [],
        items,
        itemsCount: items.reduce((s, i) => s + (i.quantity || 0), 0),
        itemsValue: Number(items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2)),
        order: {
          id: row._id,
          orderId: row.orderId,
          orderStatus: row.orderStatus,
          serviceScope: row.serviceScope || "city",
          cashOnDelivery: !!row.cashOnDelivery,
          paymentStatus: row.paymentStatus || "",
          transactionId: row.transactionId || "",
          totalPrice: row.totalPrice,
          deliveryCharges: row.deliveryCharges || 0,
          platformFee: row.platformFee || 0,
          orderedAt: row.createdAt || null,
          deliveredAt: row.orderDeliveredTime || null,
          note: row.note || "",
          shipping: row.shipping?.trackingId ? row.shipping : null,
          items: (row.items || []).map((it) => ({
            name: it.name,
            image: it.image,
            price: it.price,
            quantity: it.quantity,
            lineTotal: round2((it.price || 0) * (it.quantity || 0)),
          })),
        },
        store: row.storeId
          ? {
              id: row.storeId._id,
              storeName: row.storeId.storeName || "N/A",
              ownerName: row.storeId.ownerName || "",
              phone: row.storeId.PhoneNumber || "",
            }
          : null,
        customer: buildAddress(row.addressId),
      };
    });

    return res.status(200).json({
      status: true,
      message: "Return requests retrieved successfully",
      returns,
      statusCounts,
      page,
      limit,
      count,
      totalPages: Math.ceil(count / limit),
    });
  } catch (error) {
    console.error("listReturnRequests error:", error.message);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};


// ---------------------------------------------------------------------------
// PUT /order/returns/:orderId/:returnId/status
// body: { status, note?, courierName?, trackingId?, refundAmount?, refundReference? }
//   rejected  -> note is required (shown to the customer as the reject reason)
//   picked    -> courierName / trackingId optional
//   refunded  -> refundAmount optional (defaults to the items value, never more),
//                refundReference optional (gateway refund id / UTR)
// ---------------------------------------------------------------------------
const PUSH_TEXT = {
  approved: (id) => ["Return approved", `Your return for order #${id} is approved. Pickup will be arranged.`],
  rejected: (id, extra) => ["Return rejected", `Your return for order #${id} was rejected.${extra ? " Reason: " + extra : ""}`],
  picked: (id) => ["Return picked up", `Your return for order #${id} has been picked up.`],
  refunded: (id, extra) => ["Refund processed", `Refund${extra ? " of ₹" + extra : ""} for order #${id} has been processed.`],
};

const notifyCustomer = async (order, status, extra) => {
  try {
    const user = await User.findById(order.userId).lean();
    if (user?.fcmToken && user.fcmToken !== "null") {
      const [title, body] = PUSH_TEXT[status](order.orderId, extra);
      await sendNotification(
        user.fcmToken,
        title,
        body,
        "/dashboard1",
        { orderId: String(order.orderId), returnStatus: status },
        DEFAULT_PUSH_SOUND,
      );
    }
  } catch (err) {
    console.warn("Return notification failed:", err.message);
  }
  try {
    await emitUserOrderStatusUpdate(order, "returnAdminControler.updateReturnStatus");
  } catch (err) {
    console.warn("Return socket emit failed:", err.message);
  }
};

exports.updateReturnStatus = async (req, res) => {
  try {
    const isAdmin = req.auth?.role === "admin";
    if (isAdmin && !(await adminAllowed(req.auth.staffId))) {
      return res.status(403).json({ status: false, message: "Permission denied" });
    }

    const { orderId, returnId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId) || !mongoose.Types.ObjectId.isValid(returnId)) {
      return res.status(404).json({ status: false, message: "Return request not found" });
    }

    const body = req.body || {};
    const next = String(body.status || "").trim().toLowerCase();
    const note = String(body.note || "").trim();
    if (!STATUSES.includes(next) || next === "requested") {
      return res.status(400).json({ status: false, message: "Invalid status" });
    }
    if (note.length > 500) {
      return res.status(400).json({ status: false, message: "Note is too long (max 500 characters)" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }
    if (!isAdmin && String(order.storeId) !== String(req.auth.storeId)) {
      return res.status(403).json({ status: false, message: "This order does not belong to your store" });
    }

    const rr = (order.returnRequests || []).find((r) => String(r._id) === String(returnId));
    if (!rr) {
      return res.status(404).json({ status: false, message: "Return request not found" });
    }

    const current = rr.status || "requested";
    if (!(TRANSITIONS[current] || []).includes(next)) {
      return res.status(400).json({
        status: false,
        message: `Cannot change a ${current} return to ${next}`,
      });
    }

    const P = "returnRequests.$.";
    const set = { [`${P}status`]: next };
    let pushNote = note;
    let pushExtra = "";

    if (next === "rejected") {
      if (note.length < 3) {
        return res.status(400).json({ status: false, message: "Please give a reject reason (min 3 characters)" });
      }
      set[`${P}rejectReason`] = note;
      pushExtra = note;
    }

    if (next === "picked") {
      set[`${P}pickup`] = {
        courierName: String(body.courierName || "").trim().slice(0, 100),
        trackingId: String(body.trackingId || "").trim().slice(0, 100),
        pickedAt: new Date(),
      };
    }

    if (next === "refunded") {
      const itemsValue = round2(
        (rr.items || []).reduce((sum, it) => sum + (it.price || 0) * (it.quantity || 0), 0),
      );
      const amount =
        body.refundAmount === undefined || body.refundAmount === ""
          ? itemsValue
          : round2(body.refundAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ status: false, message: "Refund amount must be more than 0" });
      }
      if (amount > itemsValue) {
        return res.status(400).json({
          status: false,
          message: `Refund cannot be more than the returned items value (₹${itemsValue})`,
        });
      }
      set[`${P}refund`] = {
        amount,
        reference: String(body.refundReference || "").trim().slice(0, 100),
        refundedAt: new Date(),
      };
      pushExtra = String(amount);
      pushNote = pushNote || `Refund of ₹${amount}`;
    }

    // Only applies while the return is still in the status we validated against
    const updated = await Order.findOneAndUpdate(
      {
        _id: order._id,
        returnRequests: { $elemMatch: { _id: rr._id, status: current } },
      },
      {
        $set: set,
        $push: {
          [`${P}history`]: {
            status: next,
            by: isAdmin ? "admin" : "store",
            note: pushNote,
            at: new Date(),
          },
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      return res.status(409).json({ status: false, message: "This return was just changed, please refresh" });
    }

    await notifyCustomer(updated, next, pushExtra);

    const saved = (updated.returnRequests || []).find((r) => String(r._id) === String(returnId));
    return res.status(200).json({
      status: true,
      message: `Return ${next}`,
      returnId: saved?._id,
      returnStatus: saved?.status,
      allowedNext: TRANSITIONS[saved?.status] || [],
    });
  } catch (error) {
    console.error("updateReturnStatus error:", error.message);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};
