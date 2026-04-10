const driver = require("../modals/driver");
const Store = require("../modals/store");
const User = require("../modals/User");
const Assign = require("../modals/driverModals/assignments");
const { Order } = require("../modals/order");
const { SettingAdmin } = require("../modals/setting");
const request = require("request");
const { getAgenda } = require("../config/agenda");
const Address = require("../modals/Address");
const mongoose = require("mongoose");
const { whatsappOtp } = require("../config/whatsappsender");
const OtpModel = require("../modals/otp");
const admin = require("../firebase/firebase");
const admin_transaction = require("../modals/adminTranaction");
const store_transaction = require("../modals/storeTransaction");
const { FeeInvoiceId } = require("../config/counter");
const { sendMessages } = require("../utils/sendMessages");
// sendDriverLocationToUser intentionally ignored for now
// const sendDriverLocationToUser = require("../utils/sendLatLongToUser");
// new socket code of user order status
const {
  emitUserOrderStatusUpdate,
} = require("../utils/emitUserOrderStatusUpdate");
const DriverRating = require("../modals/DriverRating");
const {
  generateAndSendThermalInvoice,
  generateStoreInvoiceId,
} = require("../config/invoice");
const Transaction = require("../modals/driverModals/transaction");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const order = require("../modals/order");

exports.driverLogin = async (req, res) => {
  try {
    const { mobileNumber, driverDeviceId, password, fcmToken } = req.body;

    const exist = await driver.findOne({
      "address.mobileNo": mobileNumber,
      approveStatus: { $nin: ["rejected", "pending_admin_approval"] },
    });

    // console.log(exist)
    if (!exist) {
      return res.status(400).json({ message: "User Not Found" });
    }

    if (exist.status !== true) {
      return res.status(400).json({
        message:
          "Your account is currently disabled. Please contact support for assistance",
      });
    }

    // console.log(exist.password)
    if (exist.password !== password) {
      return res.status(400).json({ message: "Invalid Credentials" });
    }
    if (fcmToken) {
      await driver.findByIdAndUpdate(exist._id, { fcmToken });
    }

    if (driverDeviceId) {
      await driver.findByIdAndUpdate(exist._id, { driverDeviceId });
    }

    const token = jwt.sign({ _id: exist._id }, process.env.jwtSecretKey);
    return res.status(200).json({
      message: "Login Successful",
      DriverDetails: {
        id: exist._id,
        name: exist.driverName,
        riderId: exist.driverId,
        mobile: exist.address.mobileNo,
        email: exist.email,
        image: exist.image,
      },
      token,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occured" });
  }
};

exports.checkDriverDeviceLogin = async (req, res) => {
  try {
    const { mobileNumber, driverDeviceId } = req.body;

    // Validation checks — always return isValid: false
    if (!mobileNumber) {
      return res.status(400).json({
        message: "Mobile number is required",
        isValid: false,
      });
    }

    if (!driverDeviceId) {
      return res.status(400).json({
        message: "Driver device ID is required",
        isValid: false,
      });
    }

    // Find driver by mobile number
    const driverData = await driver.findOne({
      "address.mobileNo": mobileNumber,
    });

    if (!driverData) {
      return res.status(400).json({
        message: "Driver not found",
        isValid: false,
      });
    }

    // Compare device ID
    if (driverData.driverDeviceId === driverDeviceId) {
      return res.status(200).json({
        message: "Device match — valid driver login",
        isValid: true,
      });
    } else {
      return res.status(400).json({
        message: "Device mismatch — login from different device",
        isValid: false,
      });
    }
  } catch (error) {
    //console.error("Check Driver Device Login Error:", error);
    return res.status(500).json({
      message: "Internal server error",
      isValid: false,
    });
  }
};

exports.acceptOrder = async (req, res) => {
  try {
    const { orderId, status, driverId } = req.body;

    const driverData = await driver.findOne({ _id: driverId });
    let updatedOrder = null;
    if (status === true) {
      updatedOrder = await Order.findOneAndUpdate(
        { orderId },
        {
          driver: {
            driverId: driverData.driverId,
            name: driverData.driverName,
            mobileNumber: driverData.address.mobileNo,
          },
          orderStatus: "Going to Pickup",
        },
        { new: true },
      );

      // new socket code of user order status
      await emitUserOrderStatusUpdate(
        updatedOrder,
        "driverControler.acceptOrder",
      );
    }
    if (status === false) {
      await Assign.create({ driverId, orderId });
      return res.status(200).json({ message: "Order Canceled" });
    }
    return res.status(200).json({ message: "Order Accepted" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occured" });
  }
};
const activeIntervals = new Map();

exports.driverOrderStatus = async (req, res) => {
  try {
    const { orderStatus, orderId, otp } = req.body;

    // ===> On The Way block
    if (orderStatus === "On Way") {
      //On Way
      const setting = await SettingAdmin.findOne();
      const authSettings = setting?.Auth?.[0] || {};

      const order = await Order.findOne({ orderId }).populate({
        path: "addressId",
        select: "mobileNumber",
      });
      if (!order) return res.status(404).json({ message: "Order not found" });

      const user = await User.findOne({ _id: order.userId });
      if (!user) return res.status(404).json({ message: "User not found" });

      const generatedOtp = Math.floor(100000 + Math.random() * 900000);
      const mobileNumber = order.addressId?.mobileNumber || user.mobileNumber;

      const message = `Dear Customer. Your Fivlia Delivery OTP code is ${generatedOtp}. Valid for 5 minutes. Do not share with others Fivlia - Delivery in Minutes!`;

      await sendMessages(mobileNumber, message, "1707176060670565835");

      await OtpModel.findOneAndUpdate(
        { mobileNumber, orderId },
        { otp: generatedOtp, expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000 },
        { upsert: true, new: true },
      );

      const statusUpdate = await Order.findOneAndUpdate(
        { orderId },
        { orderStatus },
        { new: true },
      );

      // new socket code of user order status
      await emitUserOrderStatusUpdate(
        statusUpdate,
        "driverControler.driverOrderStatus:On Way",
      );

      // if (activeIntervals.has(orderId)) {
      //   clearInterval(activeIntervals.get(orderId));
      //   activeIntervals.delete(orderId);
      // }
      // await sendDriverLocationToUser(order.driver.driverId, orderId);
      // const intervalId = setInterval(() => {
      //   sendDriverLocationToUser(order.driver.driverId, orderId);
      // }, 5 * 60 * 1000);

      // activeIntervals.set(orderId, intervalId);

      return res.status(200).json({
        message: `OTP sent to ${mobileNumber}`,
        otp: generatedOtp,
        statusUpdate,
      });
    }

    if (orderStatus === "Delivered") {
      const alreadyDelivered = await Order.exists({
        orderId,
        deliverStatus: true,
      });
      if (alreadyDelivered) {
        console.log(`Order ${orderId} already processed for delivery.`);
      } else {
        console.log(`Processing delivery logic for order ${orderId}...`);
        let feeInvoiceId = await FeeInvoiceId(true);
        const otpRecord = await OtpModel.findOne({ orderId, otp });
        if (!otpRecord) {
          return res.status(400).json({ message: "Invalid OTP" });
        }
        if (otpRecord.expiresAt < Date.now()) {
          return res.status(400).json({ message: "OTP expired" });
        }

        const order = await Order.findOne({ orderId })
          .populate("userId")
          .lean();
        const user = order.userId;

        if (!order) return res.status(404).json({ message: "Order not found" });

        const storeBefore = await Store.findById(order.storeId).lean();
        const store = storeBefore; // just renaming for clarity

        const totalCommission = order.items.reduce((sum, item) => {
          const itemTotal = item.price * item.quantity;
          const commissionAmount = ((item.commision || 0) / 100) * itemTotal;
          return sum + commissionAmount;
        }, 0);

        const itemTotal = order.items.reduce((sum, item) => {
          return sum + item.price * item.quantity;
        }, 0);
        let creditToStore = itemTotal;
        if (!store.Authorized_Store) {
          creditToStore = itemTotal - totalCommission; // deduct commission
        }

        // ===> Update Store Wallet
        const storeData = await Store.findByIdAndUpdate(
          order.storeId,
          { $inc: { wallet: creditToStore } },
          { new: true },
        );
        // ===> Update Store Transaction
        const data = await store_transaction.create({
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
        // console.log(data)
        // ===> Update Admin Wallet only if commission > 0
        if (!store.Authorized_Store && totalCommission > 0) {
          const lastAmount = await admin_transaction
            .findById("68ea20d2c05a14a96c12788d")
            .lean();
          const updatedWallet = await admin_transaction.findByIdAndUpdate(
            "68ea20d2c05a14a96c12788d",
            { $inc: { wallet: totalCommission } },
            { new: true },
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

        // ===> Generate Store Invoice ID
        const storeInvoiceId = await generateStoreInvoiceId(order.storeId);

        const statusUpdate = await Order.findOneAndUpdate(
          { orderId },
          {
            orderStatus,
            deliverBy: "Driver",
            storeInvoiceId,
            feeInvoiceId,
            deliverStatus: true,
          },
          { new: true },
        );

        // new socket code of user order status
        await emitUserOrderStatusUpdate(
          statusUpdate,
          "driverControler.driverOrderStatus:Delivered",
        );

        // ✅ Clean up OTP and Assignments
        await OtpModel.deleteOne({ _id: otpRecord._id });
        await Assign.deleteOne({ orderId: orderId, orderStatus: "Accepted" });

        // if (activeIntervals.has(orderId)) {
        //   clearInterval(activeIntervals.get(orderId));
        //   activeIntervals.delete(orderId);
        //   console.log(`🛑 Stopped location interval for order ${orderId}`);
        // }
        // ✅ Generate Thermal Invoice
        try {
          await generateAndSendThermalInvoice(orderId);
        } catch (error) {
          console.error("Error generating thermal invoice:", error);
        }

        if (user?.fcmToken) {
          try {
            await admin.messaging().send({
              token: user.fcmToken,
              notification: {
                title: "Order Delivered 🎉",
                body: `Your order #${orderId} has been delivered successfully.`,
              },
              android: {
                notification: {
                  channelId: "default_channel",
                  sound: "default",
                },
              },
              data: {
                type: "delivered",
                orderId: orderId.toString(),
              },
            });
            console.log("✅ Notification sent to user");
          } catch (err) {
            console.warn("⚠️ User FCM send failed:", err.message);
          }
        }

        if (store?.fcmToken) {
          try {
            await admin.messaging().send({
              token: store.fcmToken,
              notification: {
                title: "Order Delivered 🎉",
                body: `Driver delivered order #${orderId}.`,
              },
              android: {
                notification: {
                  channelId: "default_channel",
                  sound: "default",
                },
              },
              data: {
                type: "delivered",
                orderId: orderId.toString(),
              },
            });
            console.log("✅ Notification sent to store");
          } catch (err) {
            console.warn("⚠️ Store FCM send failed:", err.message);
          }
        }

        return res.status(200).json({
          message: "Order Delivered Successfully",
          statusUpdate,
        });
      }
    }

    // ===> Other status update (fallback)
    const statusUpdate = await Order.findOneAndUpdate(
      { orderId },
      { orderStatus },
      { new: true },
    );

    // new socket code of user order status
    await emitUserOrderStatusUpdate(
      statusUpdate,
      "driverControler.driverOrderStatus:fallback",
    );

    return res.status(200).json({
      message: "Status Updated Successfully",
      statusUpdate,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.acceptedOrder = async (req, res) => {
  try {
    const { mobileNumber } = req.params;
    const AcceptedOrders = await Order.find({
      "driver.mobileNumber": mobileNumber,
      orderStatus: { $in: ["On The Way", "Going to Pickup", "On Way"] },
    });
    const enrichedOrders = await Promise.all(
      AcceptedOrders.map(async (order) => {
        const address1 = await Address.findById(order.addressId);
        const storeAddress = await Store.findById(order.storeId);

        return {
          ...order.toObject(),
          name: address1?.fullName,
          address: address1?.address,
          contact: address1?.mobileNumber,
          storeAddress: storeAddress?.fullAddress,
          storeName: storeAddress.storeName,
          storeLat: storeAddress?.Latitude,
          storeLng: storeAddress?.Longitude,
          storeContact: storeAddress?.PhoneNumber,
          userLat: address1?.latitude,
          userLng: address1?.longitude,
        };
      }),
    );

    return res.status(200).json({ message: "Orders", enrichedOrders });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occured" });
  }
};

exports.updateDriverStatus = async (driverId, status) => {
  try {
    const drivers = await driver.findById(driverId);
    if (!drivers) return { success: false, message: "Driver not found" };

    drivers.activeStatus = status;
    await drivers.save();

    return { success: true };
  } catch (error) {
    console.error("Update failed", error);
    return { success: false, message: "Internal error" };
  }
};

exports.activeStatus = async (req, res) => {
  try {
    const { driverId, status } = req.body;
    const result = await exports.updateDriverStatus(driverId, status);

    if (result.success) {
      return res.status(200).json({ message: "Status Changed" });
    } else {
      return res
        .status(500)
        .json({ message: result.message || "Failed to update status" });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.driverWallet = async (req, res) => {
  try {
    const { orderId } = req.params;
    // If orderId is MongoDB _id, use: { _id: orderId }
    const order = await Order.findOne({ orderId });
    if (!order || order.orderStatus !== "Delivered") {
      return res
        .status(400)
        .json({ message: "Invalid order or not delivered" });
    }

    const driverObjectId = mongoose.Types.ObjectId.isValid(
      order.driver.driverId,
    )
      ? new mongoose.Types.ObjectId(order.driver.driverId)
      : null;

    const checkTransaction = await Transaction.findOne({
      orderId: order._id,
      driverId: driverObjectId,
    });

    if (checkTransaction) {
      return res
        .status(200)
        .json({ message: "Payout already processed for this order" });
    }

    // OLD: flat charge payout calculation
    // const chargesData = await SettingAdmin.findOne();
    // let deliveryChargeRaw = chargesData.Delivery_Charges || 0;
    // let deliveryGstPercent = chargesData.Delivery_Charges_Gst || 0;
    // let totalDeliveryCharge =
    //   deliveryChargeRaw / (1 + deliveryGstPercent / 100);
    // const taxedAmount = deliveryChargeRaw - totalDeliveryCharge;
    // const payout = order.deliveryPayout || totalDeliveryCharge;

    const payout = order.deliveryPayout || 0;
    const deliveryChargeRaw = order.deliveryCharges || 0;
    const taxedAmount = Math.max(0, deliveryChargeRaw - payout);

    if (!payout) {
      return res.status(404).json({ message: "Driver not found" });
    }

    // If you have order.driver.driverId, use that for more reliability
    const updatedDriver = await driver.findOneAndUpdate(
      { "address.mobileNo": order.driver.mobileNumber },
      { $inc: { wallet: payout } },
      { new: true },
    );
    if (!updatedDriver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    await Transaction.create({
      driverId: updatedDriver._id,
      type: "credit",
      amount: payout,
      orderId: order._id,
      description: `Payout for Order #${orderId}`,
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
      orderId: order.orderId,
      description: "Delivery Charge GST credited to Admin wallet",
    });

    return res
      .status(200)
      .json({ message: "Wallet updated and transaction logged" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.transactionList = async (req, res) => {
  try {
    const { driverId } = req.params;

    const transactionListRaw = await Transaction.find({ driverId }).sort({
      createdAt: -1,
    });

    const transactionList = transactionListRaw.map((t) => ({
      ...t.toObject(),
      amount: Number(t.amount.toFixed(2)),
    }));

    const driverWallet = await driver.findById(driverId);

    const totalAmount = Number((driverWallet?.wallet || 0).toFixed(2));

    return res.status(200).json({
      message: "Transaction List",
      transactionList,
      totalAmount,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.cancelOrders = async (req, res) => {
  try {
    const { driverId } = req.params;
    const canceledAssignments = await Assign.find({
      driverId,
      orderStatus: "Rejected",
    })
      .sort({ createdAt: -1 })
      .lean();

    const orderIds = canceledAssignments
      .map((assignment) => assignment.orderId)
      .filter(Boolean);

    const orders = orderIds.length
      ? await Order.find({ orderId: { $in: orderIds } })
          .select(
            "orderId items totalPrice deliveryCharges orderStatus createdAt",
          )
          .lean()
      : [];

    const orderMap = new Map(
      orders.map((orderData) => [orderData.orderId, orderData]),
    );

    const Canceled = canceledAssignments.map((assignment) => {
      const orderData = orderMap.get(assignment.orderId);

      return {
        ...assignment,
        orderDetails: orderData
          ? {
              orderId: orderData.orderId,
              createdAt: orderData.createdAt,
              orderStatus: orderData.orderStatus,
              totalPrice: orderData.totalPrice,
              deliveryCharges: orderData.deliveryCharges,
              items: (orderData.items || []).map((item) => ({
                productId: item.productId,
                varientId: item.varientId,
                name: item.name,
                quantity: item.quantity,
                price: item.price,
                image: item.image,
                gst: item.gst,
              })),
            }
          : null,
      };
    });

    return res.status(200).json({ message: "Canceled Orders", Canceled });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.completedOrders = async (req, res) => {
  try {
    const { mobileNumber } = req.params;
    const order = await Order.find({
      "driver.mobileNumber": mobileNumber,
      orderStatus: "Delivered",
    });

    const driverId = order[0]?.driver?.driverId;

    const ratings = driverId
      ? await DriverRating.find({ driverId }).select("rating")
      : [];

    console.log("Ratings for driver", driverId, ratings);
    const totalRatings = ratings.length;

    const averageRating =
      totalRatings > 0
        ? ratings.reduce((acc, r) => acc + (r.rating || 0), 0) / totalRatings
        : 5;

    return res
      .status(200)
      .json({ message: "Completed Orders", order, rating: averageRating });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.getDriverDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const Driver = await driver.findById(id);
    return res.status(200).json({ message: "Drivers", Driver });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.editProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const { password, bankDetails, upiId } = req.body;
    const image = req.files?.image?.[0]?.location;

    const updateData = {};

    if (password) {
      updateData.password = password;
    }

    if (upiId) {
      updateData.upiId = upiId;
    }

    if (bankDetails) {
      // Parse bankDetails if it comes as JSON string (from form-data)
      let parsedBankDetails = bankDetails;
      if (typeof bankDetails === "string") {
        try {
          parsedBankDetails = JSON.parse(bankDetails);
        } catch (err) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid bankDetails format" });
        }
      }

      // Validate fields before saving
      const { bankName, accountHolder, accountNumber, ifsc, branch } =
        parsedBankDetails;
      updateData.bankDetails = {
        ...(bankName && { bankName }),
        ...(accountHolder && { accountHolder }),
        ...(accountNumber && { accountNumber }),
        ...(ifsc && { ifsc }),
        ...(branch && { branch }),
      };
    }
    if (image) {
      const pathOnly = new URL(image).pathname;
      updateData.image = pathOnly;
    }
    const Profile = await driver.findByIdAndUpdate(id, updateData, {
      new: true,
    });
    // console.log(Profile)
    return res.status(200).json({ message: "Profile Updated" });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.deleteDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const deleteDriver = await driver.findByIdAndDelete(id);
    return res.status(200).json({ message: "Driver Deleted" });
  } catch {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.withdrawalRequest = async (req, res) => {
  try {
    const { driverId, amount } = req.body;

    const driverData = await driver.findById(driverId);
    if (!driverData)
      return res.status(404).json({ message: "Driver not found" });

    const isNonEmpty = (value) =>
      value !== undefined && value !== null && String(value).trim() !== "";
    const hasUpiId = isNonEmpty(driverData.upiId);
    const bankDetails = driverData.bankDetails || {};
    const hasBankDetails =
      isNonEmpty(bankDetails.bankName) &&
      isNonEmpty(bankDetails.accountHolder) &&
      isNonEmpty(bankDetails.accountNumber) &&
      isNonEmpty(bankDetails.ifsc);

    if (!hasUpiId && !hasBankDetails) {
      return res.status(400).json({
        message:
          "Please add bank details or UPI ID before requesting withdrawal.",
      });
    }

    const settings = await SettingAdmin.findOne();
    const minWithdrawal = settings?.minWithdrawal || 0;
    if (amount < minWithdrawal) {
      return res
        .status(400)
        .json({ message: `Minimum withdrawal amount is ₹${minWithdrawal}` });
    }
    // Calculate total pending withdrawals
    const pendingWithdrawals = await Transaction.aggregate([
      {
        $match: { driverId: driverData._id, status: "Pending", type: "debit" },
      },
      { $group: { _id: null, totalPending: { $sum: "$amount" } } },
    ]);

    const totalPending = pendingWithdrawals[0]?.totalPending || 0;

    // Check if requested amount + pending exceeds wallet
    if (amount + totalPending > driverData.wallet) {
      return res.status(400).json({
        message: "Insufficient wallet balance considering pending withdrawals",
      });
    }

    // Check if a pending withdrawal already exists
    let withdrawal = await Transaction.findOne({
      driverId: driverData._id,
      status: "Pending",
      type: "debit",
    });

    if (withdrawal) {
      // Update existing pending request
      withdrawal.amount += amount;
      withdrawal.description = `Withdrawal request of ₹${withdrawal.amount} by driver`;
      await withdrawal.save();
    } else {
      // Create new withdrawal request
      withdrawal = await Transaction.create({
        driverId: driverData._id,
        amount,
        type: "debit",
        description: `Withdrawal request of ₹${amount} by driver`,
        status: "Pending",
      });
    }

    return res.status(200).json({
      message: "Withdrawal request submitted successfully",
      wallet: driverData.wallet,
      pendingWithdrawal: withdrawal,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.getDriverRequest = async (req, res) => {
  try {
    const requests = await driver
      .find({ approveStatus: "pending_admin_approval" })
      .sort({ createdAt: -1 });
    return res
      .status(200)
      .json({ message: "Driver Approval Requests", requests });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ResponseMsg: "An Error Occured" });
  }
};

exports.getDriverReferralSeller = async (req, res) => {
  try {
    const { driverId } = req.body;
    let driverData = null;

    if (mongoose.Types.ObjectId.isValid(driverId)) {
      driverData = await driver.findById(driverId);
    } else {
      driverData = await driver.findOne({ driverId: driverId });
    }

    if (!driverData) {
      return res.status(404).json({ message: "Driver not found" });
    }
    const stores = await Store.find({ referralCode: driverData.driverId })
      .select("storeName email PhoneNumber city approveStatus status")
      .lean();
    if (!stores.length) {
      return res
        .status(204)
        .json({ message: "No users found with this referral code." });
    }
    // Add a commission field to each store
    const storesWithCommission = stores.map((store) => ({
      ...store,
      city: store.city?.name || null,
      commission: 0,
    }));

    res.status(200).json({
      message: `Found ${storesWithCommission.length} store(s) with this referral code.`,
      stores: storesWithCommission,
    });
  } catch (error) {
    console.error("Error fetching stores:", error);
    res.status(500).json({
      message: "Server error while fetching stores",
      error: error.message,
    });
  }
};

exports.saveDriverRating = async (req, res) => {
  try {
    const { userId, driverId, orderId, rating, message } = req.body;
    if (!driverId || !orderId || !rating) {
      return res.status(400).json({
        message: "driverId, orderId, and rating are required fields.",
      });
    }

    const driverData = await driver.findById(driverId);
    if (!driverData) {
      return res.status(400).json({ message: "Driver not found" });
    }

    const orderData = await Order.findOne({
      _id: orderId,
      userId: userId,
      orderStatus: "Delivered",
    });
    if (!orderData) {
      return res.status(400).json({ message: "Order not found" });
    }

    const existingRating = await DriverRating.findOne({
      driverId,
      orderId,
      userId,
    });

    if (existingRating) {
      return res.status(400).json({
        message: "You have already rated this driver for this order.",
      });
    }

    await DriverRating.create({
      driverId,
      orderId,
      userId,
      rating,
      message: message || "",
    });

    return res.status(201).json({
      message: "Driver rated successfully.",
    });
  } catch (error) {
    console.error("Error rating driver:", error);
    res.status(500).json({
      message: "Server error while fetching stores",
      error: error.message,
    });
  }
};

exports.tipDriver = async (req, res) => {
  try {
    const { driverId, orderId, note, tip, userId, type } = req.body;

    if (type === "instruction") {
      const order = await Order.findOneAndUpdate(
        { orderId: orderId },
        { note },
        { new: true },
      );
      return res.status(200).json({ message: "Instruction Given" });
    }
    const order = await Order.findOne({ orderId });

    const razorpayFee = (tip * 2.5) / 100; // 2.5%
    const netAmount = tip - razorpayFee;
    const gstOnFee = (netAmount * 18) / 100; // 18% GST
    const totalDeduction = razorpayFee + gstOnFee;
    const netTip = tip - totalDeduction;

    const updatedDriver = await driver.findByIdAndUpdate(
      driverId,
      { $inc: { wallet: netTip } },
      { new: true },
    );
    if (!updatedDriver) {
      return res.status(404).json({ message: "Driver not found" });
    }
    const description = note || `Tip added by customer for Order #${orderId}`;

    const Tip = await Transaction.create({
      driverId,
      orderId: order._id,
      description,
      amount: netTip,
      userId,
      type: "credit",
    });
    const lastAmount = await admin_transaction
      .findById("68ea20d2c05a14a96c12788d")
      .lean();
    const updatedWallet = await admin_transaction.findByIdAndUpdate(
      "68ea20d2c05a14a96c12788d",
      { $inc: { wallet: totalDeduction } },
      { new: true },
    );

    await admin_transaction.create({
      currentAmount: updatedWallet.wallet,
      lastAmount: lastAmount.wallet,
      type: "Credit",
      amount: totalDeduction,
      orderId: order.orderId,
      description: "Tip Tax (2.5% = 18%) credited to Admin wallet",
    });

    return res.status(200).json({ message: "Tip Given", Tip });
  } catch (error) {
    console.error("Error Tipping Driver:", error);
    return res.status(500).json({
      message: "Server error while Tipping Driver",
      error: error.message,
    });
  }
};

exports.getDriverRating = async (req, res) => {
  try {
    const { driverId } = req.params;

    // 1) Fetch all ratings for this driver, populate user & order data
    const ratings = await DriverRating.find({ driverId })
      .populate({
        path: "userId",
        select: "name mobileNumber email profileImage",
        model: "Login",
      })
      .populate({
        path: "orderId",
        select: "orderId items totalPrice deliveryCharges createdAt storeId",
        model: "Order",
        // populate: {
        //   path: "items.productId", // deep populate products inside items
        //   select: "name price image",
        //   model: "Product",
        // },
      })
      .lean(); // lean() gives plain JS objects for speed

    // 2) If no ratings found
    if (!ratings || ratings.length === 0) {
      return res.status(200).json({
        averageRating: "0.00",
        totalRatings: 0,
        reviews: [],
      });
    }

    // 3) Calculate average rating and total count
    const totalRatings = ratings.length;
    const averageRating =
      ratings.reduce((acc, r) => acc + (r.rating || 0), 0) / totalRatings;

    // 4) Shape the reviews nicely
    const reviews = ratings.map((r) => ({
      _id: r._id,
      rating: r.rating,
      message: r.message,
      createdAt: r.createdAt,
      user: r.userId
        ? {
            _id: r.userId._id,
            name: r.userId.name,
            mobileNumber: r.userId.mobileNumber,
            email: r.userId.email,
            profileImage: r.userId.profileImage,
          }
        : null,
      order: r.orderId
        ? {
            _id: r.orderId._id,
            orderId: r.orderId.orderId,
            createdAt: r.orderId.createdAt,
            totalPrice: r.orderId.totalPrice,
            deliveryCharges: r.orderId.deliveryCharges,
            items: (r.orderId.items || []).map((it) => ({
              _id: it._id,
              name: it.name,
              quantity: it.quantity,
              price: it.price,
              image: it.image,
              gst: it.gst,
              product: it.productId
                ? {
                    _id: it.productId._id,
                    name: it.productId.name,
                    price: it.productId.price,
                    image: it.productId.image,
                  }
                : null,
            })),
          }
        : null,
    }));

    // 5) Send final response
    return res.status(200).json({
      averageRating: averageRating.toFixed(2),
      totalRatings,
      reviews,
    });
  } catch (error) {
    console.error("Error getting driver rating:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};
