const { Order, TempOrder } = require("../modals/order");
const { ZoneData } = require("../modals/cityZone");
const admin = require("../firebase/firebase");
const Products = require("../modals/Product");
const { Cart } = require("../modals/cart");
const autoAssignDriver = require("../config/driverOrderAccept/AutoAssignDriver");
const driver = require("../modals/driver");
const User = require("../modals/User");
const Status = require("../modals/deliveryStatus");
const { SettingAdmin } = require("../modals/setting");
const Address = require("../modals/Address");
const BulkOrderRequest = require("../modals/bulkOrderRequest");
const stock = require("../modals/StoreStock");
const admin_transaction = require("../modals/adminTranaction");
const store_transaction = require("../modals/storeTransaction");
const Notification = require("../modals/Notification");
const Assign = require("../modals/driverModals/assignments");
const sendNotification = require("../firebase/pushnotification");
const Store = require("../modals/store");
const Category = require("../modals/category");
const Rating = require("../modals/rating");
const DriverRating = require("../modals/DriverRating");
const Transaction = require("../modals/driverModals/transaction");
const AdminStaff = require("../modals/roleBase/adminStaff");
const crypto = require("crypto");
const { resolveSellerDeliveryPricing } = require("../utils/sellerDelivery");
const {
  getAppliedOfferContext,
  buildOfferPreviewText,
} = require("../utils/storeOffer");

const {
  getStoresWithinRadius,
  isWithinZone,
  getZoneWindowConfig,
  getCurrentZoneWindowMode,
} = require("../config/google");
const { sellerSocketMap, adminSocketMap } = require("../utils/driverSocketMap");
const { sendAdminNotification } = require("../utils/sendAdminNotification");
// new socket code of user order status
const {
  emitUserOrderStatusUpdate,
} = require("../utils/emitUserOrderStatusUpdate");
const {
  getDistanceMeters,
  getDistanceKm,
  computeDeliveryCharge,
  resolveDeliveryRatesForMode,
} = require("../utils/deliveryCharge");
const {
  buildPlatformPushConfig,
  CUSTOM_PUSH_SOUND,
  DEFAULT_PUSH_SOUND,
} = require("../utils/pushSoundConfig");

const {
  generateAndSendThermalInvoice,
  generateStoreInvoiceId,
} = require("../config/invoice");
const deliveryStatus = require("../modals/deliveryStatus");
const {
  getNextOrderId,
  FeeInvoiceId,
  getNextDriverId,
} = require("../config/counter");

const getOfferContext = async (cartItems, storeId, now = new Date()) => {
  return getAppliedOfferContext(cartItems, storeId, now);
};
const {
  createRazorpayOrder,
  verifyRazorpayPayment,
  getCommison,
} = require("../utils/razorpayService");

const telegramOrderLog = require("../utils/telegram_logs");

const MAX_DISTANCE_METERS = 5000;
const MAX_ATTEMPTS = 10; // retry 10 times (for example, every 30s = 5 minutes total)

const normalizeOrderStatus = (status) =>
  String(status || "")
    .trim()
    .toLowerCase();

const isFoodOrder = (order) =>
  (order?.items || []).some(
    (item) =>
      String(item?.typeName || "")
        .trim()
        .toLowerCase() === "food",
  );

const getPreparationTimeMinutes = (body) => {
  const rawTime =
    body?.preparationTimeMinutes ??
    body?.preparationTime ??
    body?.preparingTime ??
    body?.prepareTime;

  if (rawTime === undefined || rawTime === null || rawTime === "") return null;

  const minutes = Number(rawTime);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
};
const RETRY_INTERVAL = 10000;

// Helper: send repeated notifications until accepted
// const repeatNotifyStore = async (orderId, storeDoc, attempt = 1) => {
//   try {
//     const order = await Order.findOne({ orderId });
//     if (!order) return console.log(`⚠️ Order ${orderId} not found`);

//     // If store already accepted, stop retrying
//     if (order.orderStatus === "Accepted") {
//       console.log(`✅ Store accepted order ${orderId}, stopping retries`);
//       return;
//     }

//     // Otherwise, send notification again
//     await notifySeller(
//       storeDoc,
//       `⏰ Reminder: New Order #${order.orderId} still pending`,
//       `You have a pending order worth ₹${order.totalPrice}. Please accept or reject it.`,
//     );

//     console.log(
//       `🔁 Reminder sent to store ${storeDoc._id} for order ${orderId} (attempt ${attempt})`,
//     );

//     // Schedule next retry if not accepted yet
//     // if (attempt < MAX_ATTEMPTS) {
//     setTimeout(
//       () => repeatNotifyStore(orderId, storeDoc, attempt + 1),
//       RETRY_INTERVAL,
//     );
//     // } else {
//     //   console.log(`🚫 Max retries reached for order ${orderId}`);
//     // }
//   } catch (err) {
//     console.error(`Error in repeatNotifyStore:`, err);
//   }
// };

const notifySeller = async (
  sellerDoc,
  title,
  body,
  clickAction = "/dashboard1",
  data = {},
  soundType = CUSTOM_PUSH_SOUND,
) => {
  try {
    // ✅ Support both new (devices[]) and old (fcmToken) formats
    let tokens = [];

    // New structure: use devices array if available
    if (Array.isArray(sellerDoc.devices) && sellerDoc.devices.length > 0) {
      tokens = sellerDoc.devices
        .map((d) => d.fcmToken)
        .filter((t) => typeof t === "string" && t.trim() !== "");
    }

    // Fallback: use old single tokens if devices not defined
    if (tokens.length === 0) {
      tokens = [sellerDoc.fcmToken, sellerDoc.fcmTokenMobile].filter(Boolean);
    }

    if (tokens.length === 0) {
      console.warn(`⚠️ No valid FCM tokens found for seller ${sellerDoc._id}`);
      return;
    }

    // Send to each token (keep your existing logic)
    for (const token of tokens) {
      try {
        await sendNotification(
          token,
          title,
          body,
          clickAction,
          data,
          soundType,
        );
      } catch (err) {
        console.error(
          "notifySeller: sendNotification failed for token",
          token,
          err?.message || err,
        );

        // Optional cleanup of invalid tokens
        if (
          err?.errorInfo?.code === "messaging/registration-token-not-registered"
        ) {
          sellerDoc.devices = sellerDoc.devices?.filter(
            (d) => d.fcmToken !== token,
          );
          await sellerDoc
            .save()
            .catch(() =>
              console.warn("Failed to remove invalid token from sellerDoc"),
            );
        }
      }
    }
  } catch (error) {
    console.error("notifySeller error:", error.message || error);
  }
};

exports.placeOrder = async (req, res) => {
  try {
    const { cartIds, addressId, instructions, storeId, paymentMode } = req.body;

    if (!cartIds?.length || !addressId || !storeId) {
      console.log(
        "cartIds, addressId and storeId are required something is missing.",
      );
      return res.status(400).json({
        message: "cartIds, addressId and storeId are required",
      });
    }

    const cartItems = await Cart.find({ _id: { $in: cartIds } });
    // console.log(chargesData);
    if (!cartItems || cartItems.length === 0) {
      console.log("Cart items not found.");
      return res
        .status(400)
        .json({ message: `Cart item with ID ${cartIds} not found.` });
    }

    const userId = cartItems[0].userId;

    for (const item of cartItems) {
      const hasStock = await stock.exists({
        storeId: storeId,
        "stock.productId": item.productId,
        "stock.variantId": item.varientId,
        "stock.quantity": { $gte: item.quantity },
      });

      if (!hasStock) {
        return res.status(400).json({
          message: `Store does not have enough stock for ${item.name}`,
        });
      }
    }

    const offerContext = await getOfferContext(cartItems, storeId);
    const offerSummary = {
      cartDiscount: offerContext.cartDiscount.offer
        ? {
            _id: offerContext.cartDiscount.offer._id,
            title: offerContext.cartDiscount.offer.title,
            previewText: buildOfferPreviewText(offerContext.cartDiscount.offer),
            offerType: offerContext.cartDiscount.offer.offerType,
            discountScope: offerContext.cartDiscount.offer.discountScope,
            percent: offerContext.cartDiscount.percent,
            savings: offerContext.cartDiscount.discountAmount,
          }
        : null,
      freeProduct: offerContext.freeProductItem
        ? {
            _id: offerContext.freeProductOffer?._id || null,
            title: offerContext.freeProductOffer?.title || null,
            previewText: buildOfferPreviewText(offerContext.freeProductOffer),
            name: offerContext.freeProductItem.name,
            quantity: offerContext.freeProductItem.quantity,
            savings: offerContext.freeProductItem.freeProductSavings,
          }
        : null,
      freeDelivery: offerContext.freeDeliveryOffer
        ? {
            _id: offerContext.freeDeliveryOffer._id,
            title: offerContext.freeDeliveryOffer.title,
            previewText: buildOfferPreviewText(offerContext.freeDeliveryOffer),
            minimumOrderAmount:
              offerContext.freeDeliveryOffer.minimumOrderAmount ??
              offerContext.freeDeliveryOffer.limit,
          }
        : null,
      subtotal: offerContext.cartDiscount.subtotal,
      discountSavings: offerContext.cartDiscount.discountAmount,
      freeProductSavings: offerContext.freeProductItem?.freeProductSavings || 0,
      totalSavings:
        offerContext.cartDiscount.discountAmount +
        (offerContext.freeProductItem?.freeProductSavings || 0),
      finalSubtotal: offerContext.cartDiscount.finalSubtotal,
    };

    let nextOrderId = await getNextOrderId(true);
    console.log(`${nextOrderId} recived`);
    const chargesData = await SettingAdmin.findOne();

    // OLD: flat delivery charge
    // let deliveryChargeRaw = chargesData.Delivery_Charges || 0;
    // let deliveryGstPercent = chargesData.Delivery_Charges_Gst || 0;
    // let totalDeliveryCharge =
    //   deliveryChargeRaw / (1 + deliveryGstPercent / 100);

    let deliveryChargeRaw = 0;
    let deliveryGstPercent = chargesData.Delivery_Charges_Gst || 0;
    let totalDeliveryCharge = 0;
    let deliveryDistanceKm = 0;
    let deliveryBaseCharge = 0;
    let freeDeliveryApplied = false;
    let freeDeliverySource = null;
    let freeDeliveryThreshold = 0;
    let sellerSponsoredDeliveryPayout = 0;

    const itemsTotal = offerContext.cartDiscount.finalSubtotal;
    const platformFeeRate = (chargesData.Platform_Fee || 0) / 100;
    const platformFeeAmount = itemsTotal * platformFeeRate;

    // OLD: total price before distance-based delivery charge
    // let totalPrice = itemsTotal;
    // if (itemsTotal >= chargesData.freeDeliveryLimit) {
    //   totalPrice = itemsTotal + platformFeeAmount;
    //   deliveryChargeRaw = 0;
    // } else {
    //   totalPrice = itemsTotal + deliveryChargeRaw + platformFeeAmount;
    // }

    // const paymentOption = cartItems[0].paymentOption;

    // if (paymentMode === true && paymentOption !== true) {
    //   return res
    //     .status(401)
    //     .json({ message: "Cash On Delivery is not available in your zone" });
    // }

    const address = await Address.findById(addressId);

    if (!address) {
      console.log("Address not found");
      return res.status(400).json({
        message: "Address not found",
      });
    }

    const userLat = address.latitude;
    const userLng = address.longitude;

    const { matchedStores } = await getStoresWithinRadius(userLat, userLng);

    const storeExistsInZone = matchedStores.some(
      (store) => store._id.toString() === storeId.toString(),
    );
    console.log(`${storeExistsInZone} storeExistsInZone`);
    if (!storeExistsInZone) {
      await Cart.deleteMany({
        userId,
        storeId,
      });

      return res.status(400).json({
        message: "This store does not deliver to your address location.",
      });
    }

    // === Distance-based delivery charge ===
    const storeData = await Store.findById(storeId, {
      Latitude: 1,
      Longitude: 1,
      sellerFreeDeliveryEnabled: 1,
      sellerFreeDeliveryLimit: 1,
    }).lean();

    const storeLat = parseFloat(storeData?.Latitude);
    const storeLng = parseFloat(storeData?.Longitude);

    const mapApi = chargesData?.Map_Api?.[0] || {};
    const googleApi = mapApi.google || {};
    const googleApiKey = googleApi.status ? googleApi.api_key : null;

    let distanceMeters = 0;
    if (
      Number.isFinite(storeLat) &&
      Number.isFinite(storeLng) &&
      Number.isFinite(userLat) &&
      Number.isFinite(userLng)
    ) {
      distanceMeters = await getDistanceMeters({
        storeLat,
        storeLng,
        userLat,
        userLng,
        googleApiKey,
      });
    }

    const distanceKm = getDistanceKm(distanceMeters);
    deliveryDistanceKm = Number(distanceKm.toFixed(2));

    const zoneWindowConfig = await getZoneWindowConfig();
    const currentWindowMode = getCurrentZoneWindowMode(zoneWindowConfig);
    const { fixedFirstKm, perKm } = resolveDeliveryRatesForMode({
      settings: chargesData,
      mode: currentWindowMode,
    });

    deliveryChargeRaw = computeDeliveryCharge({
      distanceMeters,
      fixedFirstKm,
      perKm,
    });

    deliveryBaseCharge = deliveryChargeRaw;

    totalDeliveryCharge = deliveryBaseCharge / (1 + deliveryGstPercent / 100);

    const deliveryPricing = resolveSellerDeliveryPricing({
      itemsTotal,
      settings: chargesData,
      store: storeData,
      freeDeliveryOffer: offerContext.freeDeliveryOffer,
      deliveryChargeRaw: deliveryBaseCharge,
      deliveryPayout: totalDeliveryCharge,
    });

    deliveryChargeRaw = deliveryPricing.customerDeliveryCharge;

    deliveryBaseCharge = deliveryPricing.deliveryBaseCharge;

    freeDeliveryApplied = deliveryPricing.freeDeliveryApplied;

    freeDeliverySource = deliveryPricing.freeDeliverySource;

    freeDeliveryThreshold = deliveryPricing.freeDeliveryThreshold;

    sellerSponsoredDeliveryPayout =
      deliveryPricing.sellerSponsoredDeliveryPayout;

    const totalPrice = itemsTotal + deliveryChargeRaw + platformFeeAmount;

    const cashOnDelivery = paymentMode === true;

    const orderItems = [];

    console.log(offerContext, "offerContext");
    for (const item of offerContext.cartDiscount.items) {
      const productId = item.productId || item._doc?.productId;

      const product = await Products.findById(productId)
        .select("tax category")
        .lean();
      if (!product) {
        console.error(`Product not found: ${item.productId}`);
        return res.status(400).json({
          message: `Product not found for ID: ${item.productId}`,
        });
      }

      const categoryId = product?.category?.[0]?._id;

      const category = await Category.findById(categoryId)
        .populate("typeId", "name")
        .select("typeId")
        .lean();

      const typeId = category?.typeId?._id;
      const typeName = category?.typeId?.name;
      const gst = product.tax;

      const commision = await getCommison(product._id);

      orderItems.push({
        productId: item.productId,
        varientId: item.varientId,
        name: item.name,
        quantity: item.quantity,
        price: Number(item.finalUnitPrice),
        commision,
        image: item.image,
        gst,
        typeId,
        typeName,
        offerId: item.offerId || null,
        offerTitle: item.offerTitle || null,
        offerType: item.offerType || null,
        offerPercent: item.offerPercent || 0,
        isOfferItem: item.isOfferApplied || false,
      });
    }

    if (offerContext.freeProductItem) {
      const freeProduct = await Products.findById(
        offerContext.freeProductItem.productId,
      )
        .select("tax category productName productThumbnailUrl")
        .lean();

      if (freeProduct) {
        const freeCategoryId = freeProduct?.category?.[0]?._id;
        const freeCategory = await Category.findById(freeCategoryId)
          .populate("typeId", "name")
          .select("typeId")
          .lean();

        orderItems.push({
          productId: offerContext.freeProductItem.productId,
          varientId: offerContext.freeProductItem.varientId,
          name: `${freeProduct.productName} (Free)`,
          quantity: offerContext.freeProductItem.quantity,
          price: 0,
          commision: 0,
          image:
            offerContext.freeProductItem.image ||
            freeProduct.productThumbnailUrl,
          gst: freeProduct.tax,
          typeId: freeCategory?.typeId?._id,
          typeName: freeCategory?.typeId?.name,
          offerId: offerContext.freeProductItem.offerId || null,
          offerTitle: offerContext.freeProductItem.offerTitle || null,
          offerType: offerContext.freeProductItem.offerType || "free_product",
          offerPercent: 0,
          isOfferItem: true,
        });
      }
    }

    if (paymentMode === true) {
      console.log(`${nextOrderId} goes for cash on delivery`);
      const newOrder = await Order.create({
        orderId: nextOrderId,
        items: orderItems,
        addressId,
        paymentStatus: "Successful",
        cashOnDelivery,
        totalPrice,
        instructions,
        userId,
        storeId,
        deliveryPayout: totalDeliveryCharge,
        deliveryCharges: deliveryChargeRaw,
        deliveryDistanceKm,
        platformFee: chargesData.Platform_Fee,
        deliveryBaseCharge,
        freeDeliveryApplied,
        freeDeliverySource,
        freeDeliveryThreshold,
        sellerSponsoredDeliveryPayout,
        offerSummary,
      });

      console.log(`${nextOrderId} doc created`);
      for (const item of offerContext.cartDiscount.items) {
        const dataStock = await stock.updateOne(
          {
            storeId: storeId,
            "stock.productId": item.productId,
            "stock.variantId": item.varientId,
          },
          {
            $inc: { "stock.$.quantity": -item.quantity },
          },
        );
        // console.log("dataStock", dataStock);
        await Products.updateOne(
          { _id: item.productId },
          { $inc: { purchases: item.quantity } },
        );
        console.log(
          `${nextOrderId} stock deducted for cart item ${item.productId}`,
        );
      }

      if (offerContext.freeProductItem) {
        await stock.updateOne(
          {
            storeId: storeId,
            "stock.productId": offerContext.freeProductItem.productId,
            "stock.variantId": offerContext.freeProductItem.varientId,
          },
          {
            $inc: {
              "stock.$.quantity": -offerContext.freeProductItem.quantity,
            },
          },
        );
        await Products.updateOne(
          { _id: offerContext.freeProductItem.productId },
          { $inc: { purchases: offerContext.freeProductItem.quantity } },
        );
      }

      await Cart.deleteMany({ _id: { $in: cartIds } });
      console.log(`${nextOrderId} stock deducted cart deleted`);
      const sellerDoc = await Store.findById(storeId);

      await telegramOrderLog("📦 ORDER PLACED", {
        orderId: newOrder.orderId,
        userId: userId,
        storeId: storeId,
        storeName: sellerDoc?.storeName,
        amount: newOrder.totalPrice,
        paymentMode: "Cash On Delivery",
      });

      if (sellerDoc) {
        await notifySeller(
          sellerDoc,
          `New Order #${newOrder.orderId} Received`,
          `You’ve received a new order worth ₹${newOrder.totalPrice}.
           Please confirm and prepare for dispatch.`,
        );
        console.log(
          `${nextOrderId} notification started for seller-> ${sellerDoc.storeName}`,
        );

        await telegramOrderLog("🏪 STORE NOTIFIED", {
          orderId: newOrder.orderId,
          storeId: sellerDoc._id,
          storeName: sellerDoc.storeName,
        });
        // repeatNotifyStore(newOrder.orderId, sellerDoc);

        const sellerSocket = sellerSocketMap.get(sellerDoc._id.toString());
        if (sellerSocket)
          sellerSocket.emit("storeOrder", { orderId: newOrder.orderId });

        // ✅ Emit to admin as well
        const adminSocket = adminSocketMap.get("admin");
        if (adminSocket) {
          adminSocket.emit("storeOrder", {
            orderId: newOrder.orderId,
            storeId: sellerDoc._id,
            totalPrice: newOrder.totalPrice,
          });
          console.log(`👑 Sent new order(${newOrder.orderId}) to admin`);
        }
      }

      // 🔔 ADMIN FCM NOTIFICATION
      const admin = await AdminStaff.findOne({
        roleId: "6924308f010bf6509aecedf0",
      });
      console.log("noti block next");
      if (admin?.fcmToken) {
        console.log("noti block runned");
        try {
          await sendNotification(
            admin.fcmToken,
            "New Order Received 🛒",
            `Order #${newOrder.orderId} worth ₹${newOrder.totalPrice} placed.`,
            "/orders",
            {},
            CUSTOM_PUSH_SOUND,
          );
        } catch (err) {
          console.warn(
            "⚠️ User notification failed order status change:",
            err.response?.data?.error?.message || err.message,
          );
        }
      }

      sendAdminNotification({
        title: `New Order #${newOrder.orderId}`,
        description: `Order worth ₹${newOrder.totalPrice} placed from store ${
          sellerDoc.storeName || ""
        }`,
        type: "order",
        image: sellerDoc?.image || "",
        screen: "/orders",
        city: sellerDoc?.city || "",
        data: {
          orderId: newOrder.orderId,
          storeId: sellerDoc._id,
          totalPrice: newOrder.totalPrice,
        },
      });
      console.log(`Order(${newOrder.orderId}) placed successfully`);
      return res
        .status(200)
        .json({ message: "Order placed successfully", order: newOrder });
    } else {
      const tempOrder = await TempOrder.create({
        userId,
        orderId: nextOrderId,
        items: orderItems,
        addressId,
        totalPrice,
        storeId,
        instructions,
        paymentStatus: "Pending",
        cashOnDelivery,
        cartIds,
        deliveryPayout: totalDeliveryCharge,
        deliveryCharges: deliveryChargeRaw,
        deliveryDistanceKm,
        platformFee: chargesData.Platform_Fee,
        deliveryBaseCharge,
        freeDeliveryApplied,
        freeDeliverySource,
        freeDeliveryThreshold,
        sellerSponsoredDeliveryPayout,
        offerSummary,
      });
      const payResponse = await createRazorpayOrder(
        totalPrice,
        "INR",
        `receipt_${tempOrder._id}`,
        { orderId: nextOrderId },
      );

      await TempOrder.findByIdAndUpdate(tempOrder._id, {
        razorpayOrderId: payResponse.id,
      });

      return res.status(200).json({
        message: "Proceed to payment",
        tempOrderId: tempOrder._id,
        tempOrder,
        payResponse,
      });
    }
  } catch (error) {
    console.error("Order error:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.razorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    const signature = req.headers["x-razorpay-signature"];

    // VERIFY SIGNATURE
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.log("❌ Invalid webhook signature");

      return res.status(400).json({
        success: false,
      });
    }

    // PARSE BODY
    const body = JSON.parse(req.body.toString());

    console.log("✅ Webhook:", body.event);

    // ONLY HANDLE payment.captured
    if (body.event !== "payment.captured") {
      return res.status(200).json({
        success: true,
      });
    }

    const payment = body.payload.payment.entity;

    const paymentId = payment.id;

    const razorpayOrderId = payment.order_id;

    console.log("💰 Captured payment:", paymentId);

    // FIND TEMP ORDER
    const tempOrder = await TempOrder.findOne({
      razorpayOrderId,
    });

    if (!tempOrder) {
      console.log("⚠️ Temp order not found");

      return res.status(200).json({
        success: true,
      });
    }

    // CHECK IF ORDER ALREADY EXISTS
    const existingOrder = await Order.findOne({
      transactionId: paymentId,
    });

    if (existingOrder) {
      console.log("✅ Order already exists");

      return res.status(200).json({
        success: true,
      });
    }

    console.log("🚑 Recovering missed payment via webhook");

    // REUSE EXISTING FLOW
    const fakeReq = {
      body: {
        tempOrderId: tempOrder._id,
        transactionId: paymentId,
        paymentStatus: true,
      },
    };

    const fakeRes = {
      status: (code) => ({
        json: (data) => {
          console.log("Webhook verifyPayment response:", code, data);
        },
      }),
    };

    // CALL EXISTING API FLOW
    await exports.verifyPayment(fakeReq, fakeRes);

    console.log("✅ Webhook recovery completed");

    return res.status(200).json({
      success: true,
    });
  } catch (err) {
    console.log("❌ Webhook Error:", err);

    return res.status(200).json({
      success: true,
    });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { tempOrderId, paymentStatus, transactionId } = req.body;

    console.log("tempOrderId", tempOrderId);
    // 1. Check if temp order exists
    const tempOrder = await TempOrder.findById(tempOrderId);
    if (!tempOrder)
      return res.status(404).json({ message: "Temp order not found" });

    const paymentResult = await verifyRazorpayPayment(
      transactionId,
      tempOrder.razorpayOrderId,
    );

    await TempOrder.findByIdAndUpdate(
      tempOrderId,
      {
        transactionId: transactionId || paymentResult?.raw?.id || "",
        paymentStatus: paymentResult.success
          ? "Successful"
          : "Verification Pending",

        razorpayStatus: paymentResult.status,
        razorpayResponse: paymentResult.raw || {},
      },
      { new: true },
    );
    // ❌ cancel ONLY on real failure
    if (!paymentResult.success) {
      return res.status(200).json({
        status: false,
        message: "Payment verification pending.",
      });
    }

    const existingOrder = await Order.findOne({
      transactionId: transactionId || paymentResult?.raw?.id,
    });

    if (existingOrder) {
      return res.status(200).json({
        status: true,
        message: "Order already exists",
        order: existingOrder,
      });
    }

    const orderData = {
      orderId: tempOrder.orderId,
      items: tempOrder.items,
      addressId: tempOrder.addressId,
      userId: tempOrder.userId,
      cashOnDelivery: tempOrder.cashOnDelivery,
      totalPrice: tempOrder.totalPrice,
      instructions: tempOrder.instructions,
      deliveryCharges: tempOrder.deliveryCharges,
      platformFee: tempOrder.platformFee,
      gst: tempOrder.gst || "",
      deliveryPayout: tempOrder.deliveryPayout,
      deliveryDistanceKm: tempOrder.deliveryDistanceKm,

      deliveryBaseCharge: tempOrder.deliveryBaseCharge,

      freeDeliveryApplied: tempOrder.freeDeliveryApplied,

      freeDeliverySource: tempOrder.freeDeliverySource,

      freeDeliveryThreshold: tempOrder.freeDeliveryThreshold,

      sellerSponsoredDeliveryPayout: tempOrder.sellerSponsoredDeliveryPayout,
      offerSummary: tempOrder.offerSummary || null,

      storeId: tempOrder.storeId,
      transactionId: transactionId || paymentResult?.raw?.id || "",
      paymentStatus: "Successful",
      orderStatus: "Pending",

      notifyAttempts: 0,
      lastNotifyAt: null,
    };

    const finalOrder = await Order.create(orderData);

    await telegramOrderLog("📦 ORDER PLACED", {
      orderId: finalOrder.orderId,
      userId: finalOrder.userId,
      storeId: finalOrder.storeId,
      amount: finalOrder.totalPrice,
    });

    for (const item of tempOrder.items) {
      await stock.updateOne(
        {
          storeId: tempOrder.storeId,
          "stock.productId": item.productId,
          "stock.variantId": item.varientId,
        },
        {
          $inc: { "stock.$.quantity": -item.quantity },
        },
      );
      await Products.updateOne(
        { _id: item.productId },
        { $inc: { purchases: item.quantity } },
      );
    }

    await Cart.deleteMany({ _id: { $in: tempOrder.cartIds } });

    const sellerDoc = await Store.findById(tempOrder.storeId);

    if (sellerDoc) {
      console.log(`seller notified `);
      await notifySeller(
        sellerDoc,
        `New Order #${finalOrder.orderId} Received`,
        `You’ve received a new order worth ₹${finalOrder.totalPrice}.
         Please confirm and prepare for dispatch.`,
      );
      const admin = await AdminStaff.findOne({
        roleId: "6924308f010bf6509aecedf0",
      });

      if (admin?.fcmToken) {
        try {
          await sendNotification(
            admin.fcmToken,
            "New Order Received 🛒",
            `Order #${finalOrder.orderId} worth ₹${finalOrder.totalPrice} placed.`,
            "/orders",
            {},
            CUSTOM_PUSH_SOUND,
          );
        } catch (err) {
          console.warn(
            "⚠️ User notification failed order status change:",
            err.response?.data?.error?.message || err.message,
          );
        }
      }

      const sellerSocket = sellerSocketMap.get(sellerDoc._id.toString());
      if (sellerSocket)
        sellerSocket.emit("storeOrder", { orderId: finalOrder.orderId });

      // ✅ Emit to admin as well
      const adminSocket = adminSocketMap.get("admin");
      if (adminSocket) {
        adminSocket.emit("storeOrder", {
          orderId: finalOrder.orderId,
          storeId: sellerDoc._id,
          totalPrice: finalOrder.totalPrice,
        });
        console.log(`👑 Sent new order to admin`);
      }
    }

    return res.status(200).json({
      status: paymentStatus ? true : false,
      message: "Payment verified. Order placed successfully.",
      order: finalOrder,
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.getOrders = async (req, res) => {
  try {
    const { limit, page = 1, storeId } = req.query;
    const skip = (page - 1) * limit;
    const query = storeId ? { storeId } : {};

    const totalOrders = await Order.countDocuments();
    const orders = await Order.find(query)
      .populate({
        path: "addressId",
        select:
          "fullName address mobileNumber house_No floor landmark city state pincode driver",
      })
      .populate({
        path: "storeId",
        select: "storeName",
      })
      .skip(skip)
      .limit(Number(limit))
      .sort({ createdAt: -1 })
      .lean();

    const ordersWithCity = await Promise.all(
      orders.map(async (order) => {
        // Extract city from address
        let city = "Unknown";
        if (order.addressId?.city) city = order.addressId.city;

        // Format full address
        const formattedAddress = order.addressId
          ? {
              fullName: order.addressId.fullName || "N/A",
              fullAddress:
                [
                  order.addressId.address || "",
                  order.addressId.house_No || "",
                  order.addressId.floor ? `Floor ${order.addressId.floor}` : "",
                  order.addressId.landmark || "",
                  order.addressId.city || "",
                  order.addressId.state || "",
                  order.addressId.pincode || "",
                ]
                  .filter(Boolean)
                  .join(", ") || "N/A",
              moibleNumber: order.addressId.mobileNumber || "",
            }
          : { fullName: "N/A", fullAddress: "N/A" };

        // Inject variant info inside items
        const itemsWithVariant = await Promise.all(
          order.items.map(async (item) => {
            const product = await Products.findById(item.productId).lean();

            if (!product) {
              console.warn(`⚠️ Product not found for ID: ${item.productId}`);
              return {
                ...item,
                product: null,
                variantName: null,
                variantPrice: null,
              };
            }

            const variant = product?.variants?.find(
              (v) => v._id.toString() === item.varientId?.toString(),
            );
            return {
              ...item,
              sku: product.sku || null,
              variantName: variant?.variantValue || null,
              variantPrice: variant?.sell_price || null,
            };
          }),
        );

        return {
          ...order,
          items: itemsWithVariant,
          addressId: formattedAddress,
          storeId: order.storeId
            ? {
                _id: order.storeId._id || "N/A",
                storeName: order.storeId.storeName || "N/A",
              }
            : null,
          city,
          driverPhone: order.driver?.mobileNumber || null,
        };
      }),
    );
    const count = totalOrders;
    return res.status(200).json({
      message: "Orders retrieved successfully",
      orders: ordersWithCity,
      page,
      totalPages: Math.ceil(totalOrders / limit),
      count,
      limit,
    });
  } catch (error) {
    console.error("Get orders error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

exports.getOrderDetails = async (req, res) => {
  try {
    const userId = req.user;

    const userOrders = await Order.find({ userId })
      .sort({ createdAt: -1 })
      .lean();
    const results = [];

    const settings = await SettingAdmin.findOne();

    for (const order of userOrders) {
      // 1. Fetch address
      const address = await Address.findById(order.addressId).lean();

      // 2. Fetch driver details if driverId exists
      let driverInfo = {};
      if (order.driver && order.driver.driverId) {
        driverInfo = await driver
          .findOne({ _id: order.driver.driverId })
          .lean();

        let avgRating = null;
        let totalRatings = 0;

        if (driverInfo) {
          const ratingStats = await DriverRating.aggregate([
            { $match: { driverId: driverInfo._id } },
            {
              $group: {
                _id: "$driverId",
                average: { $avg: "$rating" },
                totalRatings: { $sum: 1 },
              },
            },
          ]);
          if (ratingStats.length) {
            avgRating = Number(ratingStats[0].average.toFixed(1));
            totalRatings = ratingStats[0].totalRatings;
          }

          driverInfo = {
            driverId: driverInfo.driverId || "",
            Id: driverInfo._id || "",
            name: driverInfo.driverName || "",
            mobileNo: driverInfo.address?.mobileNo || "",
            averageRating: avgRating || 0,
            totalRatings: totalRatings,
          };
        }
      }
      let storeLocation = null;
      if (order.storeId) {
        const storeData = await Store.findById(order.storeId, {
          Latitude: 1,
          Longitude: 1,
          storeName: 1,
        }).lean();

        if (storeData) {
          storeLocation = storeData.location || {
            Latitude: storeData.Latitude || null,
            Longitude: storeData.Longitude || null,
          };
          storeName = storeData.storeName;
        }
      }

      if (settings && order.totalPrice > settings.freeDeliveryLimit) {
        order.deliveryCharges = 0;
      }

      const platformFee = Number(
        ((order.totalPrice * settings.Platform_Fee) / 100).toFixed(2),
      );

      const itemsWithDetails = await Promise.all(
        order.items.map(async (item) => {
          const product = await Products.findById(item.productId).lean();
          return {
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            image: item.image,
            gst: item.gst,
            storeId: order.storeId,
            productId: item.productId,
            varientId: item.varientId,
            productDetails: {
              title: product?.title,
              description: product?.description,
              brand: product?.brand,
              images: product?.images,
            },
          };
        }),
      );
      // 4. Push combined data
      results.push({
        id: order._id,
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        totalPrice: order.totalPrice,
        cashOnDelivery: order.cashOnDelivery,
        deliveryCharges: order.deliveryCharges,
        platformFee,
        transactionId: order.transactionId || "",
        items: itemsWithDetails,
        address,
        driver: driverInfo,
        storeLocation,
        storeName,
        createdAt: order.createdAt,
      });
    }

    return res.status(200).json({
      message: "Orders fetched successfully",
      orders: results,
    });
  } catch (error) {
    console.error("Get orders error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

exports.orderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, driverId } = req.body;
    console.log(req.body);
    const normalizedStatus = normalizeOrderStatus(status);

    const updateData = { orderStatus: status };

    if (normalizedStatus === "preparing") {
      const preparationTime = getPreparationTimeMinutes(req.body);
      if (preparationTime !== null) {
        updateData.preparationTime = preparationTime;
      }

      updateData.instantTime = new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      });
    }

    if (driverId) {
      const driverDoc = await driver.findOne({ _id: driverId });
      if (!driverDoc)
        return res.status(404).json({ message: "Driver not found" });

      updateData.driver = {
        driverId: driverDoc._id,
        name: driverDoc.driverName,
        mobileNumber: driverDoc.address?.mobileNo || "",
      };

      if (!status || status === "" || status === undefined) {
        updateData.orderStatus = "Going to Pickup";
      }
      // ✅ Fetch the order before update to get user & store info for notification
      const orderDoc = await Order.findById(id).lean();

      if (orderDoc) {
        const user = await User.findById(orderDoc.userId).lean();
        const storeData = await Store.findById(orderDoc.storeId).lean();

        // 🧠 Notify user that a driver has been assigned
        if (user?.fcmToken && user.fcmToken !== "null") {
          try {
            await sendNotification(
              user.fcmToken,
              "🚗 Driver Assigned!",
              `Your order #${orderDoc.orderId} has been assigned to driver ${driverDoc.driverName}.`,
              "/dashboard1",
              {
                orderId: orderDoc.orderId,
                driverName: driverDoc.driverName,
                driverMobile: driverDoc.address?.mobileNo || "",
                storeName: storeData?.storeName || "Fivlia",
              },
              DEFAULT_PUSH_SOUND,
            );
          } catch (err) {
            console.warn(
              "⚠️ User notification failed order status change:",
              err.response?.data?.error?.message || err.message,
            );
          }
        }

        // 🧠 Optionally notify the store as well
        if (storeData?.fcmTokenMobile) {
          try {
            await sendNotification(
              storeData.fcmTokenMobile,
              "Driver Assigned 🚗",
              `Driver ${driverDoc.driverName} has been assigned for order #${orderDoc.orderId}.`,
              "/dashboard1",
              {
                orderId: orderDoc.orderId,
                driverName: driverDoc.driverName,
              },
              CUSTOM_PUSH_SOUND,
            );
          } catch (err) {
            console.warn(
              "⚠️ User notification failed order status change:",
              err.response?.data?.error?.message || err.message,
            );
          }
        }
      }
    }

    const orderOnTheWay = await Order.exists({
      _id: id,
      orderStatus: {
        $in: ["On The Way", "Going to Pickup", "On Way", "Ready"],
      },
    });

    if (orderOnTheWay && status === "Accepted") {
      return res.status(200).json({ message: "Order Already Accepted" });
    }
    // 1. Update order status
    const updatedOrder = await Order.findByIdAndUpdate(id, updateData, {
      new: true,
    });

    if (driverId !== undefined) {
      try {
        await updateDispatchState(
          updatedOrder.orderId,
          {
            $set: {
              assigned: true,
              status: "assigned",
            },
          },
          async (redis, keys) => {
            await redis.hSet(keys.state, {
              assigned: "1",
              status: "assigned",
            });
          },
        );
      } catch (err) {
        console.warn("⚠️ Dispatch update failed:", err.message);
      }
    }

    await telegramOrderLog("📦 ORDER STATUS UPDATED", {
      orderId: updatedOrder.orderId,
      status,
      storeId: updatedOrder.storeId,
    });

    if (status === "Cancelled") {
      const deleteAssignments = await Assign.deleteMany({
        orderId: updatedOrder.orderId,
        orderStatus: "Accepted",
      });

      try {
        await updateDispatchState(
          updatedOrder.orderId,
          {
            $set: {
              assigned: false,
              status: "cancelled",
            },
          },
          async (redis, keys) => {
            await redis.hSet(keys.state, {
              assigned: "0",
              status: "cancelled",
            });
          },
        );
      } catch (err) {
        console.warn("⚠️ Cancel dispatch update failed:", err.message);
      }

      console.log(
        `Deleted ${deleteAssignments.deletedCount} Accepted assignments for cancelled order ${updatedOrder.orderId}`,
      );
    }

    if (!updatedOrder)
      return res.status(404).json({ message: "Order not found" });

    const shouldAutoAssignDriver =
      normalizedStatus === "accepted" ||
      (normalizedStatus === "preparing" && isFoodOrder(updatedOrder));

    if (shouldAutoAssignDriver) {
      autoAssignDriver(updatedOrder._id).catch((err) => {
        console.error("Driver assignment failed:", err.message);
      });
    }

    if (status === "Delivered" && updatedOrder.driver?.driverId) {
      if (updatedOrder.deliverStatus) {
        console.log(
          `Order ${updatedOrder.orderId} already processed for delivery.`,
        );
      } else {
        console.log(
          `Processing delivery logic for order ${updatedOrder.orderId}...`,
        );
        await Assign.findOneAndDelete({
          driverId: updatedOrder.driver.driverId,
          orderId: updatedOrder.orderId,
          orderStatus: "Accepted",
        });

        // 🧮 Commission + Wallet Update Logic (SAME AS driverOrderStatus)
        const storeBefore = await Store.findById(updatedOrder.storeId).lean();
        const store = storeBefore;

        const setting = await SettingAdmin.findOne().lean();
        // 🧮 Calculate Commission from Items
        const totalCommission = updatedOrder.items.reduce((sum, item) => {
          const itemTotal = item.price * item.quantity;
          const commissionAmount = ((item.commision || 0) / 100) * itemTotal;
          return sum + commissionAmount;
        }, 0);

        const itemTotal = updatedOrder.items.reduce((sum, item) => {
          return sum + item.price * item.quantity;
        }, 0);

        // 1. Apply the extra 5% tax only for food sellers and keep the existing commission logic as-is.
        const foodSellerTaxPercent = Number(setting?.foodSellerTaxPercent || 5);

        const foodItemsTotal = updatedOrder.items.reduce((sum, item) => {
          const typeName = String(item.typeName || "")
            .trim()
            .toLowerCase();

          if (typeName === "food") {
            return sum + item.price * item.quantity;
          }

          return sum;
        }, 0);

        const foodSellerTaxAmount = !store.Authorized_Store
          ? (foodItemsTotal * foodSellerTaxPercent) / 100
          : 0;

        const totalAdminDeduction = totalCommission + foodSellerTaxAmount;

        // ===> Handle seller-sponsored free delivery payout
        const sellerSponsoredPayout =
          updatedOrder.sellerSponsoredDeliveryPayout || 0;

        // 🏦 Credit Store Wallet
        let creditToStore = itemTotal;
        if (!store.Authorized_Store) {
          creditToStore = itemTotal - totalAdminDeduction;
        }

        // Deduct seller-sponsored delivery payout if applicable
        if (sellerSponsoredPayout > 0) {
          creditToStore = creditToStore - sellerSponsoredPayout;
        }

        const storeData = await Store.findByIdAndUpdate(
          updatedOrder.storeId,
          { $inc: { wallet: creditToStore } },
          { new: true },
        );

        // ===> Build transaction description
        let transactionDescription = "";
        if (store.Authorized_Store) {
          transactionDescription =
            sellerSponsoredPayout > 0
              ? `Full amount credited minus seller-sponsored delivery (₹${sellerSponsoredPayout.toFixed(2)} deducted for free delivery offer)`
              : "Full amount credited (Authorized Store)";
        } else {
          const deductions = [];
          if (totalCommission > 0) {
            deductions.push(`₹${totalCommission.toFixed(2)} commission`);
          }
          if (foodSellerTaxAmount > 0) {
            deductions.push(
              `₹${foodSellerTaxAmount.toFixed(2)} food seller tax`,
            );
          }
          if (sellerSponsoredPayout > 0) {
            deductions.push(
              `₹${sellerSponsoredPayout.toFixed(2)} free delivery payout`,
            );
          }

          transactionDescription =
            deductions.length > 0
              ? `Credited after deductions (${deductions.join(", ")} deducted)`
              : "Amount credited";
        }

        // ➕ Create Store Transaction
        await store_transaction.create({
          currentAmount: storeData.wallet,
          lastAmount: storeBefore.wallet,
          type: "Credit",
          amount: creditToStore,
          orderId: updatedOrder.orderId,
          storeId: updatedOrder.storeId,
          description: transactionDescription,
        });

        // 2. Credit admin with the old commission plus the new food-seller tax in one delivered settlement.
        if (!store.Authorized_Store && totalAdminDeduction > 0) {
          const lastAmount = await admin_transaction
            .findById("68ea20d2c05a14a96c12788d")
            .lean();
          const updatedWallet = await admin_transaction.findByIdAndUpdate(
            "68ea20d2c05a14a96c12788d",
            { $inc: { wallet: totalAdminDeduction } },
            { new: true },
          );

          await admin_transaction.create({
            currentAmount: updatedWallet.wallet,
            lastAmount: lastAmount.wallet,
            type: "Credit",
            amount: totalAdminDeduction,
            orderId: updatedOrder.orderId,
            description:
              foodSellerTaxAmount > 0
                ? "Commission and food seller tax credited to Admin wallet"
                : "Commission credited to Admin wallet",
          });
        }

        const payout = updatedOrder.deliveryPayout || 0;
        const deliveryChargeRaw = updatedOrder.deliveryCharges || 0;
        const taxedAmount = Math.max(0, deliveryChargeRaw - payout);

        if (!payout) {
          console.warn("problem is drvier payout order status change");
        }

        // If you have order.driver.driverId, use that for more reliability
        const updatedDriver = await driver.findOneAndUpdate(
          { "address.mobileNo": updatedOrder.driver.mobileNumber },
          { $inc: { wallet: payout } },
          { new: true },
        );
        if (!updatedDriver) {
          console.warn(
            "Driver not found while updating driver wallet order status change",
          );
        }

        await Transaction.create({
          driverId: updatedDriver._id,
          type: "credit",
          amount: payout,
          orderId: updatedOrder._id,
          description: `Payout for Order #${updatedOrder.orderId}`,
        });

        const lastAmount = await admin_transaction
          .findById("68ea20d2c05a14a96c12788d")
          .lean();

        const updatedWallet = await admin_transaction.findByIdAndUpdate(
          "68ea20d2c05a14a96c12788d",
          { $inc: { wallet: taxedAmount } },
          { new: true },
        );

        await admin_transaction.create({
          currentAmount: updatedWallet.wallet,
          lastAmount: lastAmount.wallet,
          type: "Credit",
          amount: taxedAmount,
          orderId: updatedOrder.orderId,
          description: "Delivery Charge GST credited to Admin wallet",
        });

        let storeInvoiceId;
        let feeInvoiceId;
        // 🧾 Generate Store Invoice ID
        if (store.Authorized_Store) {
          // Authorized store: use global counter for both invoices
          storeInvoiceId = await FeeInvoiceId(true); // increments counter
          feeInvoiceId = await FeeInvoiceId(true); // increments counter again
        } else {
          // Unauthorized store: local logic
          storeInvoiceId = await generateStoreInvoiceId(updatedOrder.storeId);
          feeInvoiceId = await FeeInvoiceId(true); // can still increment global counter
        }

        await Order.findByIdAndUpdate(updatedOrder._id, {
          storeInvoiceId,
          feeInvoiceId,
          deliverBy: "admin",
          deliverStatus: true,
          // 3. Save the food-seller tax snapshot so invoice data stays locked after delivery.
          foodSellerTaxPercent,
          foodSellerTaxAmount,
        });

        if (store?.fcmTokenMobile) {
          try {
            await sendNotification(
              store.fcmTokenMobile,
              "Order Delivered 🎉",
              `Driver delivered order #${updatedOrder.orderId}.`,
              "/dashboard1",
              { orderId: updatedOrder.orderId },
              CUSTOM_PUSH_SOUND,
            );
          } catch (err) {
            console.warn(
              "⚠️ Store delivered notification failed order status change:",
              err.response?.data?.error?.message || err.message,
            );
          }
        }

        try {
          await generateAndSendThermalInvoice(updatedOrder.orderId);
        } catch (err) {
          console.error("Error generating thermal invoice:", err);
        }
      }
    }
    const user = await User.findById(updatedOrder.userId).lean();
    const statusInfo = await Status.findOne({ statusTitle: status });

    const store = await Store.findById(updatedOrder.storeId).lean();
    // 3. Send notification if FCM token valid and status exists
    if (user?.fcmToken && user.fcmToken !== "null" && statusInfo?.statusTitle) {
      try {
        await sendNotification(
          user.fcmToken,
          `📦 Order #${updatedOrder.orderId} - ${statusInfo.statusTitle}`,
          `Your order is now marked as ${statusInfo.statusTitle} by ${
            store.storeName || "Fivlia"
          }`,
          "/dashboard1",
          {
            image: statusInfo.image || "",
            orderId: updatedOrder.orderId,
            statusCode: statusInfo.statusCode,
          },
          DEFAULT_PUSH_SOUND,
        );
      } catch (err) {
        console.warn(
          "⚠️ User notification failed order status change:",
          err.response?.data?.error?.message || err.message,
        );
      }
    }

    // new socket code of user order status
    const socketOrderPayload = await Order.findById(updatedOrder._id).lean();
    await emitUserOrderStatusUpdate(
      socketOrderPayload || updatedOrder,
      "orderControler.orderStatus",
    );

    return res
      .status(200)
      .json({ message: "Order Status Updated", update: updatedOrder });
  } catch (error) {
    console.error("Order status error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

exports.deliveryStatus = async (req, res) => {
  try {
    const { statusTitle, status } = req.body;

    const lastStatus = await deliveryStatus.findOne().sort({ statusCode: -1 });

    let nextStatusCode = "100"; // default first code
    if (lastStatus && !isNaN(parseInt(lastStatus.statusCode))) {
      nextStatusCode = (parseInt(lastStatus.statusCode) + 1).toString();
    }
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";
    const newStatus = await deliveryStatus.create({
      statusCode: nextStatusCode,
      statusTitle,
      status,
      image,
    });
    return res.status(200).json({ message: "New Status Created", newStatus });
  } catch (error) {
    console.error("Get orders error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

exports.updatedeliveryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { statusCode, statusTitle, status } = req.body;
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";
    const newStatus = await deliveryStatus.findByIdAndUpdate(id, {
      statusCode,
      statusTitle,
      image,
      status,
    });
    return res.status(200).json({ message: "Status Updated", newStatus });
  } catch (error) {
    console.error("Get orders error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

exports.getdeliveryStatus = async (req, res) => {
  try {
    const Status = await deliveryStatus.find();
    return res.status(200).json({ message: "Delivery Status", Status });
  } catch (error) {
    console.error("Get orders error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};
// routes/testRoute.js or controller
exports.test = async (req, res) => {
  try {
    const token =
      "d4HVM3utRw6dS3eK8J0qUN:APA91bEyK6IHXVqttY8xbhEqckbtvehYD4QaF6LaVzRTuC1Wk0fnCiMTaRNMsV0Sobm9WkDeD0rPnnuQ8SNhtdqO6YcLMvZL1hNBaX3r3Zl2tV8X9UGcOag";

    const response = await sendPushNotification(
      token,
      "🚀 Backend Test",
      "If you received this, backend FCM works!",
      { testMode: "true" },
    );

    res.json({ message: "Notification sent", response });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "❌ Failed to send notification",
      error: error.message,
    });
  }
};

exports.driver = async (req, res) => {
  try {
    const {
      driverName,
      vehicleRegistrationNumber,
      drivingLicenseNumber,
      status,
      email,
      approveStatus,
      password,
    } = req.body;

    const address = JSON.parse(req.body.address);

    const mobileNumber = address?.mobileNo;

    const existingDriver = await driver.findOne({
      $and: [{ approveStatus: { $ne: "rejected" } }],
      $or: [
        { email },
        { "address.mobileNo": mobileNumber }, // check nested field
      ],
    });

    if (existingDriver) {
      if (existingDriver.approveStatus === "pending_admin_approval") {
        return res.status(202).json({
          message:
            "Your request is under review. Our team will contact you soon.",
        });
      }

      if (existingDriver.approveStatus !== "rejected") {
        return res.status(409).json({
          message: "Driver already exists with this email or mobile number",
        });
      }
    }

    let nextDriverId = await getNextDriverId(true);
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";
    const policeKey = req.files?.Police_Verification_Copy?.[0]?.key;
    const Police_Verification_Copy = policeKey ? `/${policeKey}` : "";
    const aadharFrontKey = req.files?.aadharCard?.[0]?.key;
    const aadharBackKey = req.files?.aadharCard?.[1]?.key;

    const dlFrontKey = req.files?.drivingLicence?.[0]?.key;
    const dlBackKey = req.files?.drivingLicence?.[1]?.key;

    const driverId = nextDriverId;
    const newDriver = await driver.create({
      driverId,
      driverName,
      status,
      image,
      address,
      email,
      password,
      approveStatus,
      Police_Verification_Copy,
      vehicleRegistrationNumber,
      drivingLicenseNumber,
      aadharCard: {
        front: aadharFrontKey ? `/${aadharFrontKey}` : "",
        back: aadharBackKey ? `/${aadharBackKey}` : "",
      },
      drivingLicence: {
        front: dlFrontKey ? `/${dlFrontKey}` : "",
        back: dlBackKey ? `/${dlBackKey}` : "",
      },
    });

    if (drivingLicenseNumber || vehicleRegistrationNumber) {
      // 🔔 ADMIN FCM NOTIFICATION
      const admin = await AdminStaff.findOne({
        roleId: "6924308f010bf6509aecedf0",
      });
      console.log("noti block of become a driver next");
      if (admin?.fcmToken) {
        console.log("noti block runned");
        try {
          await sendNotification(
            admin.fcmToken,
            "New Delivery Partner Request",
            `${driverName} has submitted a request to become a delivery partner.`,
            "/drivers",
            {},
            CUSTOM_PUSH_SOUND,
          );
        } catch (err) {
          console.warn(
            "⚠️ admin notification failed driver request:",
            err.response?.data?.error?.message || err.message,
          );
        }
      }
    }

    return res
      .status(200)
      .json({ message: "Driver added successfully", newDriver });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "❌ Failed to add driver", error: error.message });
  }
};

exports.getDriver = async (req, res) => {
  try {
    const Driver = await driver
      .find({ approveStatus: { $nin: ["pending_admin_approval", "rejected"] } })
      .lean();

    const ratings = await DriverRating.aggregate([
      {
        $group: {
          _id: "$driverId",
          averageRating: { $avg: "$rating" },
        },
      },
    ]);

    // Step 3: Convert ratings array to a quick lookup map
    const ratingMap = {};
    ratings.forEach((r) => {
      ratingMap[r._id.toString()] = r.averageRating || 0;
    });

    // Step 4: Attach averageRating to each driver object
    const updatedDrivers = Driver.map((d) => ({
      ...d,
      averageRating: ratingMap[d._id.toString()] || 0,
    }));

    return res.status(200).json({ message: "Drivers", Driver: updatedDrivers });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.editDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const {
      driverName,
      status,
      email,
      password,
      vehicleRegistrationNumber,
      drivingLicenseNumber,
    } = req.body;

    let address = {};
    if (req.body.address) {
      try {
        address = JSON.parse(req.body.address);
      } catch (err) {
        return res.status(400).json({ message: "Invalid address JSON" });
      }
    }
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";
    const policeKey = req.files?.Police_Verification_Copy?.[0]?.key;
    const Police_Verification_Copy = policeKey ? `/${policeKey}` : "";
    const aadharFrontKey = req.files?.aadharCard?.[0]?.key;
    const aadharBackKey = req.files?.aadharCard?.[1]?.key;

    const dlFrontKey = req.files?.drivingLicence?.[0]?.key;
    const dlBackKey = req.files?.drivingLicence?.[1]?.key;

    const updateData = {
      ...(driverName && { driverName }),
      status,
      ...(email && { email }),
      ...(vehicleRegistrationNumber && { vehicleRegistrationNumber }),
      ...(drivingLicenseNumber && { drivingLicenseNumber }),
      ...(password && { password }),
      ...(image && { image }),
      ...(Police_Verification_Copy && {
        Police_Verification_Copy,
      }),
      ...(aadharFrontKey &&
        aadharBackKey && {
          aadharCard: {
            front: aadharFrontKey ? `/${aadharFrontKey}` : "",
            back: aadharBackKey ? `/${aadharBackKey}` : "",
          },
        }),
      ...(dlFrontKey &&
        dlBackKey && {
          drivingLicence: {
            front: dlFrontKey ? `/${dlFrontKey}` : "",
            back: dlBackKey ? `/${dlBackKey}` : "",
          },
        }),
      ...(req.body.address ? { address: JSON.parse(req.body.address) } : {}),
    };

    const edit = await driver.findByIdAndUpdate(driverId, updateData, {
      new: true,
    });

    return res.status(200).json({ message: "Driver Updated", edit });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.getNotification = async (req, res) => {
  try {
    const { type } = req.query;
    if (type === "admin") {
      const notifications = await Notification.find({
        type: { $ne: "general" },
      }).sort({ createdAt: -1 });
      return res
        .status(200)
        .json({ message: "✅ Notifications", notifications });
    }
    const notifications = await Notification.find({ type: "general" }).sort({
      createdAt: -1,
    });
    return res.status(200).json({ message: "✅ Notifications", notifications });
  } catch (error) {
    console.error("❌ Get Notification Error:", error);
    return res
      .status(500)
      .json({ message: "❌ Failed to fetch notifications" });
  }
};

exports.notification = async (req, res) => {
  try {
    const { title, description, sendType, city, zone } = req.body;

    const cityArr = Array.isArray(city) ? city : city ? [city] : [];
    const zoneArr = Array.isArray(zone) ? zone : zone ? [zone] : [];

    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";
    const newNotification = await Notification.create({
      title,
      sendType,
      description,
      image,
      city: cityArr,
      zone: zoneArr,
    });

    return res.status(200).json({
      message: "✅ Notification created successfully",
      notification: newNotification,
    });
  } catch (error) {
    console.error("❌ Notification error:", error.message);
    return res.status(500).json({
      message: "❌ Failed to create notification",
      error: error.message,
    });
  }
};

exports.editNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, sendType, city, zone } = req.body;

    const cityArr = Array.isArray(city) ? city : city ? [city] : [];
    const zoneArr = Array.isArray(zone) ? zone : zone ? [zone] : [];

    const rawImagePath = req.files?.image?.[0]?.key || "";
    const updateData = {
      title,
      description,
      sendType,
      city: cityArr,
      zone: zoneArr,
    };

    if (rawImagePath) {
      updateData.image = `/${rawImagePath}`;
    }
    const newNotification = await Notification.findByIdAndUpdate(
      id,
      updateData,
      { new: true },
    );

    return res.status(200).json({
      message: "✅ Notification updated successfully",
      notification: newNotification,
    });
  } catch (error) {
    console.error("❌ Notification error:", error.message);
    return res.status(500).json({
      message: "❌ Failed to create notification",
      error: error.message,
    });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const deleteNotification = await Notification.findByIdAndDelete(id);
    return res.status(200).json({ message: "✅ Notification deleted" });
  } catch (error) {
    console.error("❌ Notification error:", error.message);
    return res.status(500).json({
      message: "❌ Failed to create notification",
      error: error.message,
    });
  }
};

exports.sendNotifications = async (req, res) => {
  try {
    const { title, description, sendType, city = [], zone = [] } = req.body;

    let tokens = [];

    // Load all zone data once
    const cityZoneDocs = await ZoneData.find({}).lean();

    const zoneWindowConfig = await getZoneWindowConfig();

    const isAllCity = city.includes("all");
    const isAllZone = zone.includes("all");

    /* ---------------------------------------------------------
       1️⃣ USER — Match by location → zone radius
    --------------------------------------------------------- */
    if (sendType === "user" || sendType === "all") {
      const users = await User.find({
        fcmToken: { $exists: true },
      }).select("fcmToken location");

      for (const u of users) {
        if (!u.fcmToken) continue;

        // ALL CITY → include all users
        if (isAllCity) {
          tokens.push(u.fcmToken);
          continue;
        }

        // Missing location → skip (unless ALL city)
        if (!u.location?.latitude) continue;

        const userLat = u.location.latitude;
        const userLng = u.location.longitude;

        for (const cityId of city) {
          const cityDoc = cityZoneDocs.find((x) => x._id.toString() === cityId);
          // console.log('cityDoc',cityDoc)
          if (!cityDoc) continue;

          let zonesToCheck = isAllZone
            ? cityDoc.zones.filter((z) => z.status)
            : cityDoc.zones.filter((z) => zone.includes(z._id.toString()));
          // console.log('zonesToCheck',zonesToCheck)
          const matched = zonesToCheck.some((z) =>
            isWithinZone(userLat, userLng, z, zoneWindowConfig),
          );
          // console.log('user matched',matched)
          if (matched) {
            tokens.push(u.fcmToken);
            break;
          }
        }
      }
    }

    /* ---------------------------------------------------------
       2️⃣ SELLER — Match by city + zone (store has zones)
    --------------------------------------------------------- */
    if (sendType === "seller" || sendType === "all") {
      const stores = await Store.find({}).select(
        "fcmToken fcmTokenMobile devices city zone",
      );

      for (const s of stores) {
        let sellerTokens = [];

        if (s.fcmToken) sellerTokens.push(s.fcmToken);
        if (s.fcmTokenMobile) sellerTokens.push(s.fcmTokenMobile);

        if (s.devices?.length) {
          s.devices.forEach((d) => d.fcmToken && sellerTokens.push(d.fcmToken));
        }

        if (sellerTokens.length === 0) continue;

        // ALL CITY → include all sellers
        if (isAllCity) {
          tokens.push(...sellerTokens);
          continue;
        }

        const storeCity = s.city?._id?.toString();
        if (!storeCity) continue;
        if (!city.includes(storeCity)) continue;

        // ALL ZONE → include all sellers of selected city
        if (isAllZone) {
          tokens.push(...sellerTokens);
          continue;
        }

        const storeZoneIds = (s.zone || []).map((z) => z._id.toString());
        const intersects = storeZoneIds.some((zid) => zone.includes(zid));
        // console.log('seller intersects',intersects)
        if (intersects) {
          tokens.push(...sellerTokens);
        }
      }
    }

    /* ---------------------------------------------------------
       3️⃣ DRIVER — Match by Firestore location against zones
    --------------------------------------------------------- */
    if (sendType === "driver" || sendType === "all") {
      const drivers = await driver
        .find({ fcmToken: { $exists: true } })
        .select("fcmToken");

      // 🔥 Driver location comes from FIRESTORE → fetch here
      for (const dr of drivers) {
        if (!dr.fcmToken) continue;

        // ALL CITY → include all drivers
        if (isAllCity) {
          tokens.push(dr.fcmToken);
          continue;
        }

        // fetch location from firestore
        const driverDocRef = admin
          .firestore()
          .collection("updates")
          .doc(String(dr._id));
        const driverSnapshot = await driverDocRef.get();
        if (!driverSnapshot.exists) continue;
        const driverData = driverSnapshot.data();

        const dLat = driverData.latitude;
        const dLng = driverData.longitude;

        for (const cityId of city) {
          const cityDoc = cityZoneDocs.find((x) => x._id.toString() === cityId);
          if (!cityDoc) continue;

          let zonesToCheck = isAllZone
            ? cityDoc.zones
            : cityDoc.zones.filter((z) => zone.includes(z._id.toString()));

          const matched = zonesToCheck.some((z) =>
            isWithinZone(dLat, dLng, z, zoneWindowConfig),
          );
          // console.log('driver matched',matched)
          if (matched) {
            tokens.push(dr.fcmToken);
            break;
          }
        }
      }
    }

    /* ---------------------------------------------------------
       4️⃣ SEND NOTIFICATIONS
    --------------------------------------------------------- */
    tokens = [...new Set(tokens)].filter(Boolean);

    if (tokens.length === 0)
      return res.status(400).json({ message: "No recipients found" });

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: description },
      data: { click_action: "FLUTTER_NOTIFICATION_CLICK" },
    });

    res.json({
      message: "Notification sent",
      totalSentTo: tokens.length,
      success: response.successCount,
      failed: response.failureCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

exports.bulkOrder = async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user;

    await BulkOrderRequest.create({ productId, userId });

    // 🔔 ADMIN FCM NOTIFICATION
    const admin = await AdminStaff.findOne({
      roleId: "6924308f010bf6509aecedf0",
    });
    console.log("noti block next");
    if (admin?.fcmToken) {
      console.log("noti block runned");
      try {
        await sendNotification(
          admin.fcmToken,
          "Bulk Order request received",
          `Bulk Order request received.`,
          "/orders",
          {},
          CUSTOM_PUSH_SOUND,
        );
      } catch (err) {
        console.warn(
          "⚠️ admin notification for bulk order failed:",
          err.response?.data?.error?.message || err.message,
        );
      }
    }

    return res.status(200).json({ message: "Request Submited" });
  } catch (error) {
    console.error("error", error);
    return res
      .status(500)
      .json({ message: "Something went wrong", error: error.message });
  }
};

exports.getBulkOrders = async (req, res) => {
  try {
    // ✅ Fetch all bulk orders and populate user + product info
    const orders = await BulkOrderRequest.find()
      .populate({
        path: "userId",
        select: "name email mobileNumber", // choose what to show
      })
      .populate({
        path: "productId",
        select: "productName productThumbnailUrl sell_price variants slug", // choose what to show
      })
      .sort({ createdAt: -1 }) // latest first
      .lean();

    if (!orders.length) {
      return res.status(200).json({
        message: "No bulk orders found",
        orders: [],
      });
    }

    const formattedOrders = orders.map((order) => ({
      _id: order._id,
      status: order.status,
      createdAt: order.createdAt,
      user: order.userId
        ? {
            id: order.userId._id,
            name: order.userId.name || "",
            email: order.userId.email || "",
            mobileNumber: order.userId.mobileNumber,
          }
        : null,
      product: order.productId
        ? {
            id: order.productId._id,
            title: order.productId.productName,
            slug: order.productId.slug || "",
            image: order.productId.productThumbnailUrl || "",
            price:
              order.productId.sell_price ||
              (Array.isArray(order.productId.variants) &&
              order.productId.variants.length > 0
                ? order.productId.variants[0].sell_price
                : "") ||
              order.productId.sell_price ||
              "",
          }
        : null,
    }));

    return res.status(200).json({
      message: "Bulk orders fetched successfully",
      count: formattedOrders.length,
      orders: formattedOrders,
    });
  } catch (error) {
    console.error("❌ getBulkOrders error:", error);
    return res.status(500).json({
      message: "Something went wrong",
      error: error.message,
    });
  }
};

exports.updateBulkOrders = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updatedOrder = await BulkOrderRequest.findByIdAndUpdate(
      id,
      { status },
      { new: true },
    );

    return res.status(200).json({ message: "completed", data: updatedOrder });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { type: { $ne: "general" }, isRead: false },
      { $set: { isRead: true } },
    );

    return res.status(200).json({ message: "Marked all read" });
  } catch (error) {
    console.error("Mark read error:", error);
    res.status(500).json({ message: "Failed" });
  }
};

exports.getTempOrders = async (req, res) => {
  try {
    const tempOrders = await TempOrder.find({
      paymentStatus: { $ne: "Successful" },
    })
      .populate("addressId")
      .populate("storeId")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      tempOrders,
    });
  } catch (error) {
    console.error("Temp order fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch temp orders",
    });
  }
};

exports.getRepeatedOrders = async (req, res) => {
  try {
    const userId = req.user._id;

    // ✅ User ke orders fetch karo
    const orders = await Order.find({ userId }).select("storeId");

    // ✅ Store IDs extract
    const storeIds = orders.map((order) => order.storeId.toString());

    // ✅ Count repeated stores
    const storeCount = {};

    storeIds.forEach((id) => {
      storeCount[id] = (storeCount[id] || 0) + 1;
    });

    // ✅ Sirf repeated stores
    const repeatedStoreIds = Object.keys(storeCount).filter(
      (id) => storeCount[id] > 1,
    );

    if (!repeatedStoreIds.length) {
      return res.status(200).json({
        success: true,
        totalRepeatedSellers: 0,
        sellers: [],
      });
    }

    // ✅ Stores fetch
    const sellers = await Store.find({
      _id: { $in: repeatedStoreIds },
    })
      .select("_id storeName image fivliaAssured")
      .lean();

    // ✅ Ratings fetch
    const ratings = await Rating.find({
      storeId: { $in: repeatedStoreIds },
    }).lean();

    // ✅ Group ratings
    const ratingsByStore = ratings.reduce((acc, r) => {
      const id = r.storeId.toString();

      if (!acc[id]) {
        acc[id] = {
          total: 0,
          count: 0,
        };
      }

      acc[id].total += r.rating || 0;
      acc[id].count += 1;

      return acc;
    }, {});

    // ✅ Final sellers response
    const sellersWithCount = sellers.map((seller) => {
      const stats = ratingsByStore[seller._id.toString()] || {
        total: 0,
        count: 0,
      };

      const avg = stats.count ? stats.total / stats.count : 0;

      return {
        storeId: seller._id,
        storeName: seller.storeName,
        image: seller.image,
        isAssured: seller.fivliaAssured || false,
        averageRating: avg.toFixed(1),
        ratingCount: stats.count,
        totalOrders: storeCount[seller._id.toString()],
      };
    });

    return res.status(200).json({
      success: true,
      totalRepeatedSellers: sellersWithCount.length,
      sellers: sellersWithCount,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
