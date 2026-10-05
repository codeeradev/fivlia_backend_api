// NEW FILE: controlers/shippingControler.js
// PUT /order/tracking/:orderId  (seller / admin)
// Updates courier / tracking details of an already SHIPPED global order.
// Body (all optional, at least one required):
//   platform             name of an active entry in settings.shippingPlatforms
//   courierName          free text (defaults to the platform name)
//   trackingId           string
//   trackingUrl          full http(s) URL (overrides the platform template)
//   expectedDeliveryDate YYYY-MM-DD, not in the past (India date)

const mongoose = require("mongoose");
const { Order } = require("../modals/order");
const User = require("../modals/User");
const { SettingAdmin } = require("../modals/setting");
const sendNotification = require("../firebase/pushnotification");
const { DEFAULT_PUSH_SOUND } = require("../utils/pushSoundConfig");
const {
  emitUserOrderStatusUpdate,
} = require("../utils/emitUserOrderStatusUpdate");
const {
  findShippingPlatform,
  buildTrackingUrl,
} = require("../utils/shippingPlatforms");

const isHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
};

exports.updateTracking = async (req, res) => {
  try {
    const { orderId } = req.params;
    const body = req.body || {};

    const platformName = String(body.platform || "").trim();
    const courierNameIn = String(body.courierName || "").trim();
    const trackingIdIn = String(body.trackingId || "").trim();
    const trackingUrlIn = String(body.trackingUrl || "").trim();
    const expectedRaw = String(body.expectedDeliveryDate || "").trim();

    if (
      !platformName &&
      !courierNameIn &&
      !trackingIdIn &&
      !trackingUrlIn &&
      !expectedRaw
    ) {
      return res.status(400).json({
        status: false,
        message: "Send at least one field to update",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ status: false, message: "Order not found" });
    }

    // Ownership: seller -> own store only, admin -> any
    const isAdmin = req.auth?.role === "admin";
    if (!isAdmin && String(order.storeId) !== String(req.auth?.storeId)) {
      return res.status(403).json({
        status: false,
        message: "This order does not belong to your store",
      });
    }

    if (order.serviceScope !== "global") {
      return res.status(400).json({
        status: false,
        message: "Only global orders have tracking",
      });
    }

    if (String(order.orderStatus || "").trim().toLowerCase() !== "shipped") {
      return res.status(400).json({
        status: false,
        message: "Tracking can only be updated while the order is Shipped",
      });
    }

    const current = order.shipping || {};
    const set = {};

    // ---- platform -> courierName + tracking link
    let platform = null;
    if (platformName) {
      const settings = await SettingAdmin.findOne()
        .select("shippingPlatforms")
        .lean();
      platform = findShippingPlatform(settings?.shippingPlatforms, platformName);
      if (!platform) {
        return res.status(400).json({
          status: false,
          message: `Shipping platform "${platformName}" is not available`,
        });
      }
      set["shipping.platform"] = platform.name;
    }

    const courierName = courierNameIn || (platform ? platform.name : "");
    if (courierName) set["shipping.courierName"] = courierName;

    const trackingId = trackingIdIn || String(current.trackingId || "");
    if (trackingIdIn) set["shipping.trackingId"] = trackingIdIn;

    // ---- tracking url: explicit > built from platform template
    if (trackingUrlIn) {
      if (!isHttpUrl(trackingUrlIn)) {
        return res
          .status(400)
          .json({ status: false, message: "trackingUrl must be a valid URL" });
      }
      set["shipping.trackingUrl"] = trackingUrlIn;
    } else if (platform && platform.trackingUrlTemplate && trackingId) {
      set["shipping.trackingUrl"] = buildTrackingUrl(
        platform.trackingUrlTemplate,
        trackingId,
      );
    }

    // ---- expected delivery date
    if (expectedRaw) {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(expectedRaw);
      const d = ok ? new Date(`${expectedRaw}T00:00:00.000Z`) : null;
      if (!d || Number.isNaN(d.getTime())) {
        return res.status(400).json({
          status: false,
          message: "expectedDeliveryDate must be in YYYY-MM-DD format",
        });
      }
      const todayIST = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });
      if (expectedRaw < todayIST) {
        return res.status(400).json({
          status: false,
          message: "expectedDeliveryDate cannot be in the past",
        });
      }
      set["shipping.expectedDeliveryDate"] = d;
    }

    // Conditional on still being Shipped so a concurrent Delivered wins
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: order.orderStatus },
      { $set: set },
      { new: true },
    );
    if (!updated) {
      return res.status(400).json({
        status: false,
        message: "Tracking can only be updated while the order is Shipped",
      });
    }

    // Customer push (never fails the request)
    try {
      const user = await User.findById(updated.userId).lean();
      if (user?.fcmToken && user.fcmToken !== "null") {
        await sendNotification(
          user.fcmToken,
          `📦 Order #${updated.orderId} tracking updated`,
          `Courier: ${updated.shipping.courierName || "-"}. Tracking ID: ${
            updated.shipping.trackingId || "-"
          }`,
          "/dashboard1",
          {
            orderId: String(updated.orderId),
            status: "Shipped",
            courierName: updated.shipping.courierName || "",
            trackingId: updated.shipping.trackingId || "",
            trackingUrl: updated.shipping.trackingUrl || "",
          },
          DEFAULT_PUSH_SOUND,
        );
      }
    } catch (err) {
      console.warn("⚠️ Tracking notification failed:", err.message);
    }

    // Customer app live update (never fails the request)
    try {
      await emitUserOrderStatusUpdate(updated, "shippingControler.updateTracking");
    } catch (err) {
      console.error("User socket emit failed:", err.message);
    }

    return res.status(200).json({
      status: true,
      message: "Tracking updated",
      order: {
        id: updated._id,
        orderId: updated.orderId,
        orderStatus: updated.orderStatus,
        shipping: {
          platform: updated.shipping.platform || null,
          courierName: updated.shipping.courierName,
          trackingId: updated.shipping.trackingId,
          trackingUrl: updated.shipping.trackingUrl || null,
          shippedAt: updated.shipping.shippedAt,
          expectedDeliveryDate: updated.shipping.expectedDeliveryDate,
        },
      },
    });
  } catch (error) {
    console.error("updateTracking error:", error.message);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};
