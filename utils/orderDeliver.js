// services/deliverOrder.service.js
const {
  buildPlatformPushConfig,
  CUSTOM_PUSH_SOUND,
  DEFAULT_PUSH_SOUND,
} = require("./pushSoundConfig");

module.exports.deliverOrderCommon = async ({
  orderId,
  deliveredBy = "Driver", // "Driver" | "admin"
  otp = null,
  validateOtp = false,
}) => {
  // Prevent double delivery
  const alreadyDelivered = await Order.exists({
    orderId,
    deliverStatus: true,
  });
  if (alreadyDelivered) {
    return { alreadyDelivered: true };
  }

  // OTP validation (only for driver flow)
  if (validateOtp) {
    const otpRecord = await OtpModel.findOne({ orderId, otp });
    if (!otpRecord) throw new Error("Invalid OTP");
    if (otpRecord.expiresAt < Date.now()) throw new Error("OTP expired");
    await OtpModel.deleteOne({ _id: otpRecord._id });
  }

  const order = await Order.findOne({ orderId }).populate("userId").lean();
  if (!order) throw new Error("Order not found");

  const user = order.userId;
  const storeBefore = await Store.findById(order.storeId).lean();
  const store = storeBefore;

  // 🧮 Commission calculation
  const totalCommission = order.items.reduce((sum, item) => {
    const itemTotal = item.price * item.quantity;
    const commissionAmount = ((item.commision || 0) / 100) * itemTotal;
    return sum + commissionAmount;
  }, 0);

  // 🏦 Store wallet credit
  let creditToStore = order.itemTotal;
  if (!store.Authorized_Store) {
    creditToStore -= totalCommission;
  }

  const storeData = await Store.findByIdAndUpdate(
    order.storeId,
    { $inc: { wallet: creditToStore } },
    { new: true }
  );

  await store_transaction.create({
    currentAmount: storeData.wallet,
    lastAmount: storeBefore.wallet,
    type: "Credit",
    amount: creditToStore,
    orderId: order.orderId,
    storeId: order.storeId,
    description: store.Authorized_Store
      ? "Full amount credited (Authorized Store)"
      : `Credited after commission cut (${totalCommission} deducted)`,
  });

  // 🏛️ Admin wallet commission
  if (!store.Authorized_Store && totalCommission > 0) {
    const lastAmount = await admin_transaction
      .findById("68ea20d2c05a14a96c12788d")
      .lean();

    const updatedWallet = await admin_transaction.findByIdAndUpdate(
      "68ea20d2c05a14a96c12788d",
      { $inc: { wallet: totalCommission } },
      { new: true }
    );

    await admin_transaction.create({
      currentAmount: updatedWallet.wallet,
      lastAmount: lastAmount.wallet,
      type: "Credit",
      amount: totalCommission,
      orderId: order.orderId,
      description: "Commission credited to Admin wallet",
    });
  }

  // 🧾 Invoice IDs
  let storeInvoiceId;
  let feeInvoiceId;

  if (store.Authorized_Store) {
    storeInvoiceId = await FeeInvoiceId(true);
    feeInvoiceId = await FeeInvoiceId(true);
  } else {
    storeInvoiceId = await generateStoreInvoiceId(order.storeId);
    feeInvoiceId = await FeeInvoiceId(true);
  }

  // ✅ Final Order Update
  const updatedOrder = await Order.findOneAndUpdate(
    { orderId },
    {
      orderStatus: "Delivered",
      deliverBy: deliveredBy,
      storeInvoiceId,
      feeInvoiceId,
      deliverStatus: true,
    },
    { new: true }
  );

  // 🧹 Cleanup
  await Assign.deleteMany({ orderId });

  // 🧾 Thermal Invoice
  try {
    await generateAndSendThermalInvoice(orderId);
  } catch (err) {
    console.error("Thermal invoice error:", err.message);
  }

  // 🔔 Notifications
  if (user?.fcmToken) {
    await admin.messaging().send({
      token: user.fcmToken,
      notification: {
        title: "Order Delivered",
        body: `Your order #${orderId} has been delivered successfully.`,
      },
      ...buildPlatformPushConfig(
        "Order Delivered",
        `Your order #${orderId} has been delivered successfully.`,
        DEFAULT_PUSH_SOUND,
      ),
      data: { orderId: orderId.toString(), type: "delivered" },
    });
  }

  if (store?.fcmToken) {
    await admin.messaging().send({
      token: store.fcmToken,
      notification: {
        title: "Order Delivered",
        body: `Order #${orderId} delivered successfully.`,
      },
      ...buildPlatformPushConfig(
        "Order Delivered",
        `Order #${orderId} delivered successfully.`,
        CUSTOM_PUSH_SOUND,
      ),
      data: { orderId: orderId.toString(), type: "delivered" },
    });
  }

  return { updatedOrder };
};
