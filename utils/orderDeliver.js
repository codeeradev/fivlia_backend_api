// services/deliverOrder.service.js
const {
  buildPlatformPushConfig,
  CUSTOM_PUSH_SOUND,
  DEFAULT_PUSH_SOUND,
} = require("./pushSoundConfig");
const { calculateOrderSettlement } = require("./orderSettlement");

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

  const setting = await SettingAdmin.findOne().lean();
  const foodSellerTaxPercent = Number(setting?.foodSellerTaxPercent || 5);
  const {
    totalCommission,
    itemTotal,
    foodSellerTaxAmount,
    totalAdminDeduction,
  } = calculateOrderSettlement({
    order,
    store,
    foodSellerTaxPercent,
  });

  // ===> Handle seller-sponsored free delivery payout
  const sellerSponsoredPayout = order.sellerSponsoredDeliveryPayout || 0;

  // 🏦 Store wallet credit
  let creditToStore = itemTotal;
  if (!store.Authorized_Store) {
    creditToStore -= totalAdminDeduction;
  }
  
  // Deduct seller-sponsored delivery payout if applicable
  if (sellerSponsoredPayout > 0) {
    creditToStore = creditToStore - sellerSponsoredPayout;
  }

  const storeData = await Store.findByIdAndUpdate(
    order.storeId,
    { $inc: { wallet: creditToStore } },
    { new: true }
  );

  // ===> Build transaction description
  let transactionDescription = "";
  if (store.Authorized_Store) {
    transactionDescription = sellerSponsoredPayout > 0
      ? `Full amount credited minus seller-sponsored delivery (₹${sellerSponsoredPayout.toFixed(2)} deducted for free delivery offer)`
      : "Full amount credited (Authorized Store)";
  } else {
    const deductions = [];
    if (totalCommission > 0) {
      deductions.push(`₹${totalCommission.toFixed(2)} commission`);
    }
    if (foodSellerTaxAmount > 0) {
      deductions.push(`₹${foodSellerTaxAmount.toFixed(2)} food seller tax`);
    }
    if (sellerSponsoredPayout > 0) {
      deductions.push(`₹${sellerSponsoredPayout.toFixed(2)} free delivery payout`);
    }
    
    transactionDescription = deductions.length > 0
      ? `Credited after deductions (${deductions.join(", ")} deducted)`
      : "Amount credited";
  }

  await store_transaction.create({
    currentAmount: storeData.wallet,
    lastAmount: storeBefore.wallet,
    type: "Credit",
    amount: creditToStore,
    orderId: order.orderId,
    storeId: order.storeId,
    description: transactionDescription,
  });

  // 🏛️ Admin wallet commission
  if (!store.Authorized_Store && totalAdminDeduction > 0) {
    const lastAmount = await admin_transaction
      .findById("68ea20d2c05a14a96c12788d")
      .lean();

    const updatedWallet = await admin_transaction.findByIdAndUpdate(
      "68ea20d2c05a14a96c12788d",
      { $inc: { wallet: totalAdminDeduction } },
      { new: true }
    );

    await admin_transaction.create({
      currentAmount: updatedWallet.wallet,
      lastAmount: lastAmount.wallet,
      type: "Credit",
      amount: totalAdminDeduction,
      orderId: order.orderId,
      description:
        foodSellerTaxAmount > 0
          ? "Commission and food seller tax credited to Admin wallet"
          : "Commission credited to Admin wallet",
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
      foodSellerTaxPercent,
      foodSellerTaxAmount,
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
