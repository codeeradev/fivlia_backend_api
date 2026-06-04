// controllers/adminController.js
const Store = require("../modals/store");
const mongoose = require("mongoose");
const { Order } = require("../modals/order");
const Category = require("../modals/category");
const Product = require("../modals/Product");
const User = require("../modals/User");
const Driver = require("../modals/driver");
const admin_transaction = require("../modals/adminTranaction");
const store_transaction = require("../modals/storeTransaction");
const Transaction = require("../modals/driverModals/transaction");
const Stock = require("../modals/StoreStock");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const crypto = require("crypto");
const ExpenseType = require("../modals/expenseType"); // correct import
const Expenses = require("../modals/Expenses");
const Roles = require("../modals/roleBase/roles");
const AdminStaff = require("../modals/roleBase/adminStaff");

exports.getDashboardStats = async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date(startOfMonth);
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);

    // Total Stores
    const totalStores = await Store.countDocuments();

    // Total Users
    const totalUsers = await User.countDocuments();

    // Total Drivers
    const totalDrivers = await Driver.countDocuments();

    // Total Categories
    const totalCategories = await Category.countDocuments();

    // Total Products
    const totalProducts = await Product.countDocuments();

    // Orders this month
    const monthlyOrders = await Order.find({
      createdAt: { $gte: startOfMonth, $lt: endOfMonth },
    });

    const totalOrdersMonthly = monthlyOrders.length;

    const completedOrdersMonthly = monthlyOrders.filter(
      (order) =>
        order.orderStatus === "Delivered" || order.orderStatus === "Completed",
    ).length;

    const pendingOrdersMonthly = monthlyOrders.filter(
      (order) =>
        order.orderStatus === "Pending" || order.orderStatus === "Processing",
    ).length;

    // Total Earning
    const adminWallet = await admin_transaction.findById(
      "68ea20d2c05a14a96c12788d",
    );
    const totalRevenue = adminWallet?.wallet || 0;

    const recentOrders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("userId storeId")
      .lean();

    return res.status(200).json({
      totalStores,
      totalUsers,
      totalDrivers,
      totalCategories,
      totalProducts,
      totalOrdersMonthly,
      completedOrdersMonthly,
      pendingOrdersMonthly,
      totalRevenue,
      recentOrders,
    });
  } catch (error) {
    console.error("Dashboard Stats Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getStoreDashboardStats = async (req, res) => {
  try {
    const storeId = req.params.storeId;
    if (!storeId) return res.status(400).json({ message: "Store ID required" });

    // Current Month Date Range
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    // Total Orders (Monthly)
    const totalMonthlyOrders = await Order.countDocuments({
      storeId: storeId,
      createdAt: { $gte: firstDay, $lte: lastDay },
    });

    // Completed Orders (Monthly)
    const completedMonthlyOrders = await Order.countDocuments({
      storeId: storeId,
      orderStatus: { $in: ["Delivered", "Completed"] },
      createdAt: { $gte: firstDay, $lte: lastDay },
    });

    // Pending Orders (Monthly)
    const pendingMonthlyOrders = await Order.countDocuments({
      storeId: storeId,
      orderStatus: { $in: ["Pending", "Processing", "Confirmed"] },
      createdAt: { $gte: firstDay, $lte: lastDay },
    });

    const store = await Store.findById(storeId).lean();
    if (!store) return res.status(404).json({ message: "Store not found" });

    const totalEarning = Number(store.wallet) + 0.01;

    const categoryIds = store.Category || [];

    const storeStatus = store.status;

    let totalCategories = 0;
    let totalProducts = 0;

    if (store.Authorized_Store === true) {
      // ✅ Authorized Store: Use `Category` field
      const categoryIds = store.Category || [];
      totalCategories = categoryIds.length;

      totalProducts = await Product.countDocuments({
        "category._id": { $in: categoryIds },
      });
    } else {
      const sellerCats = store.sellerCategories || [];

      // count all categories
      totalCategories = sellerCats.length;

      // find products from stock
      const stockData = await Stock.findOne({ storeId }).lean();

      if (stockData?.stock?.length) {
        totalProducts = stockData.stock.length;
      } else {
        totalProducts = 0;
      }
    }

    // Recent Orders (20)
    const recentOrders = await Order.find({ storeId: storeId })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("userId storeId")
      .lean();

    return res.status(200).json({
      totalEarning,
      totalMonthlyOrders,
      completedMonthlyOrders,
      pendingMonthlyOrders,
      totalCategories,
      totalProducts,
      storeStatus,
      recentOrders,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res
      .status(500)
      .json({ message: "Something went wrong", error: err.message });
  }
};

exports.walletAdmin = async (req, res) => {
  try {
    const stores = await Store.find({}, { _id: 1, name: 1 });

    const orders = await Order.find({}, { storeId: 1, totalPrice: 1 });

    const adminWallet = await admin_transaction.findById(
      "68ea20d2c05a14a96c12788d",
    );
    const totalCash = adminWallet?.wallet || 0;

    const storeTotals = {};
    stores.forEach((store) => {
      storeTotals[store._id.toString()] = 0;
    });

    orders.forEach((order) => {
      const store = order.storeId?.toString();
      if (storeTotals[store] !== undefined) {
        storeTotals[store] += order.totalPrice || 0;
      }
    });

    res.status(200).json({
      message: "Wallet",
      totalCash,
      storeTotals,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      message: "Something went wrong",
      error: error.message,
    });
  }
};

exports.adminTranaction = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchStage = {};

    if (startDate || endDate) {
      matchStage.createdAt = {};

      if (startDate) {
        matchStage.createdAt.$gte = new Date(startDate);
      }

      if (endDate) {
        matchStage.createdAt.$lte = new Date(endDate);
      }
    }

    const transactions = await admin_transaction.aggregate(
      [
        // Sort latest first
        Object.keys(matchStage).length ? { $match: matchStage } : null,

        { $sort: { createdAt: -1 } },

        // Join with orders collection
        {
          $lookup: {
            from: "orders", // collection name in MongoDB (lowercase, plural)
            localField: "orderId",
            foreignField: "orderId",
            as: "orderData",
          },
        },

        // Unwind to convert orderData array → object
        { $unwind: { path: "$orderData", preserveNullAndEmptyArrays: true } },

        // Join with store collection using storeId from orderData
        {
          $lookup: {
            from: "stores",
            localField: "orderData.storeId",
            foreignField: "_id",
            as: "storeData",
          },
        },

        { $unwind: { path: "$storeData", preserveNullAndEmptyArrays: true } },

        // Add projected fields for cleaner response
        {
          $project: {
            _id: 1,
            currentAmount: 1,
            lastAmount: 1,
            type: 1,
            amount: 1,
            orderId: 1,
            description: 1,
            createdAt: 1,
            updatedAt: 1,
            storeName: "$storeData.storeName",
            city: "$storeData.city.name",
          },
        },
      ].filter(Boolean),
    );

    return res.status(200).json({
      message: "Transaction history with store info",
      transactions,
    });
  } catch (error) {
    console.error("Admin Transaction error:", error);
    res.status(500).json({
      message: "Something went wrong",
      error: error.message,
    });
  }
};

exports.getWithdrawalRequest = async (req, res) => {
  try {
    const { type } = req.query;

    if (type === "seller") {
      // Fetch all seller withdrawal requests
      const requests = await store_transaction
        .find({ type: "debit", status: "Pending" })
        .sort({ createdAt: -1 });

      // Enrich each request with seller details
      const enrichedRequests = await Promise.all(
        requests.map(async (reqItem) => {
          const storeData = await Store.findById(reqItem.storeId).select(
            "storeName ownerName PhoneNumber email city fullAddress gstNumber wallet bankDetails sellerSignature invoicePrefix openTime closeTime",
          );

          return {
            _id: reqItem._id,
            type: reqItem.type,
            amount: reqItem.amount,
            storeId: reqItem.storeId,
            description: reqItem.description,
            status: reqItem.status,
            createdAt: reqItem.createdAt,
            updatedAt: reqItem.updatedAt,
            sellerDetails: storeData
              ? {
                  storeName: storeData.storeName,
                  ownerName: storeData.ownerName,
                  phoneNumber: storeData.PhoneNumber,
                  email: storeData.email,
                  city: storeData.city,
                  fullAddress: storeData.fullAddress,
                  gstNumber: storeData.gstNumber,
                  wallet: storeData.wallet,
                  bankDetails: storeData.bankDetails,
                  sellerSignature: storeData.sellerSignature,
                  invoicePrefix: storeData.invoicePrefix,
                  openTime: storeData.openTime,
                  closeTime: storeData.closeTime,
                }
              : null,
          };
        }),
      );

      return res.status(200).json({
        message: "Withdrawal requests",
        requests: enrichedRequests,
      });
    }

    // For non-seller type (general transaction withdrawal requests)
    const requests = await Transaction.find({ type: "debit",  status: "Pending" }).sort({
      createdAt: -1,
    });

        const enrichedRequests = await Promise.all(
        requests.map(async (reqItem) => {
          const driverData = await Driver.findById(reqItem.driverId).select(
            "driverName address email image wallet driverId bankDetails upiId",
          );

          return {
            _id: reqItem._id,
            type: reqItem.type,
            amount: reqItem.amount,
            driverId: reqItem.driverId,
            description: reqItem.description,
            status: reqItem.status,
            createdAt: reqItem.createdAt,
            updatedAt: reqItem.updatedAt,
            driverDetails: driverData
              ? {
                  driverName: driverData.driverName,
                  phoneNumber: driverData.address.mobileNo,
                  email: driverData.email,
                  city: driverData.address.city,
                  locality: driverData.address.locality,
                  wallet: driverData.wallet,
                  image: driverData.image,
                  bankDetails: driverData.bankDetails,
                  upiId: driverData.upiId,
                  driverId: driverData.driverId,
                }
              : null,
          };
        }),
      );

    return res.status(200).json({ message: "Withdrawal requests", requests:enrichedRequests });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.withdrawal = async (req, res) => {
  try {
    const { id, action } = req.params;
    const { type } = req.query;
    const { note, image } = req.body || {};

    const defaultNotes = {
      accept: "The withdrawal request has been accepted successfully.",
      decline: "The withdrawal request has been declined.",
    };

    if (type === "seller") {
      const request = await store_transaction.findOne({
        storeId: id,
        type: "debit",
        status: "Pending",
      });

      request.status = action === "accept" ? "Accepted" : "Declined";
      request.Note = note || defaultNotes[action];
      if (req.files?.image?.[0]) request.image = `/${req.files.image?.[0].key}`;

      if (action === "accept") {
        request.lastAmount = request.currentAmount;

        // deduct withdrawal amount from currentAmount
        request.currentAmount = Math.max(
          0,
          request.currentAmount - request.amount,
        );

        const store = await Store.findById(request.storeId);
        if (!store) return res.status(404).json({ message: "Store not found" });

        // Reduce wallet amount
        store.wallet = Math.max(0, store.wallet - request.amount);
        await store.save();
      }

      await request.save();

      return res.status(200).json({
        message: `Withdrawal request ${request.status.toLowerCase()} successfully`,
        request,
      });
    }

    const request = await Transaction.findOne({
      driverId: id,
      type: "debit",
      status: "Pending",
    });

    request.status = action === "accept" ? "Accepted" : "Declined";
    request.description = note || defaultNotes[action];
    if (req.files?.image?.[0]) request.image = `/${req.files.image?.[0].key}`;

    if (action === "accept") {
      const driver = await Driver.findById(request.driverId);
      if (!driver) return res.status(404).json({ message: "Driver not found" });

      // Reduce wallet amount
      driver.wallet = Math.max(0, driver.wallet - request.amount);
      await driver.save();
    }

    await request.save();

    return res.status(200).json({
      message: `Withdrawal request ${request.status.toLowerCase()} successfully`,
      request,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

// exports.adminLogin = async (req, res) => {
//   try {
//     const { username, password, otp } = req.body;

//     // 1️⃣ Validate username/password
//     if (
//       username !== process.env.ADMIN_USERNAME ||
//       password !== process.env.ADMIN_PASSWORD
//     ) {
//       return res.status(401).json({ message: "Invalid username or password" });
//     }

//     // 2️⃣ Verify OTP (Google Authenticator code)
//     const verified = speakeasy.totp.verify({
//       secret: process.env.ADMIN_2FA_SECRET,
//       encoding: "base32",
//       token: otp,
//       window: 1, // allow small 30s drift
//     });

//     if (!verified) {
//       return res.status(400).json({ message: "Invalid or expired OTP" });
//     }

//     // 3️⃣ Success (you can also generate JWT here if needed)
//     return res.status(200).json({ message: "Login successful" });
//   } catch (error) {
//     console.error("Error verifying login:", error);
//     return res.status(500).json({
//       message: "Server error during login",
//       error: error.message,
//     });
//   }
// };

exports.adminLogin = async (req, res) => {
  try {
    const { username, password, otp, step, fcmToken } = req.body;

    const user = await AdminStaff.findOne({ email: username }).populate(
      "roleId",
    );

    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    const jwttoken = jwt.sign({ _id: user._id }, process.env.jwtSecretKey, {
      expiresIn: "1d",
    });

    // Step 1: Validate password
    if (!step || step === 1) {
      if (user.password !== password) {
        return res.status(401).json({ message: "Invalid password" });
      }

      const userRole = user.roleId?.roles?.toLowerCase() || "";

      // If user is admin → return requiresOTP = true
      if (userRole === "admin") {
        return res.status(200).json({
          message: "Password correct. OTP required.",
          requiresOTP: true,
        });
      }

      // Non-admin → login successful immediately
      return res.status(200).json({
        message: "Login successful",
        requiresOTP: false,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          jwttoken,
          role: user.roleId?.roles,
          permissions: user.roleId?.permissions || [],
        },
      });
    }

    // Step 2 → OTP verification (only for admin)
    if (step === 2) {
      const verified = speakeasy.totp.verify({
        secret: process.env.ADMIN_2FA_SECRET,
        encoding: "base32",
        token: otp,
        window: 1,
      });

      if (!verified) {
        return res.status(400).json({ message: "Invalid or expired OTP" });
      }

      const isValidFcmToken =
        typeof fcmToken === "string" &&
        fcmToken.trim().length > 0 &&
        fcmToken !== "null" &&
        fcmToken !== "undefined";

      if (isValidFcmToken) {
        user.fcmToken = fcmToken.trim();
        await user.save();
      }

      return res.status(200).json({
        message: "Admin login successful",
        requiresOTP: false,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          jwttoken,
          role: user.roleId?.roles,
          permissions: user.roleId?.permissions || [],
        },
      });
    }
  } catch (error) {
    console.error("Login error:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.genrateKey = async (req, res) => {
  try {
    const { storeId, type } = req.body;
    if (type !== "admin") {
      return res.status(403).json({ message: "❌ Access Denied" });
    }
    // ✅ Find store by ID
    const store = await Store.findById(storeId);
    if (!store) {
      return res.status(404).json({ message: "❌ Store not found" });
    }

    const generatedKey = crypto.randomBytes(16).toString("hex");
    store.accessKey = generatedKey;
    await store.save();
    return res.status(200).json({
      message: "✅ Access key generated successfully",
      accessKey: generatedKey,
    });
  } catch (error) {
    console.error("Error generating access key:", error);
    return res.status(500).json({
      message: "❌ Server error ",
      error: error.message,
    });
  }
};

exports.addExpenseType = async (req, res) => {
  try {
    const { id } = req.query;
    const { title } = req.body;

    let newExpense;

    if (id) {
      newExpense = await ExpenseType.findByIdAndUpdate(
        id,
        { title },
        { new: true },
      );

      // if nothing found → create new
      if (!newExpense) {
        newExpense = await ExpenseType.create({ title });
        return res.status(200).json({
          message: "New Expense Added",
          newExpense,
        });
      }

      return res.status(200).json({
        message: "Expense Updated",
        newExpense,
      });
    }

    // no id → simple create
    newExpense = await ExpenseType.create({ title });

    return res.status(200).json({
      message: "New Expense Added",
      newExpense,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.getExpenseType = async (req, res) => {
  try {
    const expenseType = await ExpenseType.find();
    return res.status(200).json({ message: "Expenses", expenseType });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.addExpenses = async (req, res) => {
  try {
    const { title, type, amount, date } = req.body;
    const newExpense = await Expenses.create({ title, type, amount, date });
    return res.status(200).json({ message: "New Expense Added", newExpense });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.editExpenses = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, type, amount, date } = req.body;
    const newExpense = await Expenses.findByIdAndUpdate(id, {
      title,
      type,
      amount,
      date,
    });
    return res.status(200).json({ message: "Expense Edited", newExpense });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.getExpenses = async (req, res) => {
  try {
    const expenses = await Expenses.find().populate("type", "title");
    return res.status(200).json({ message: "Expenses", expenses });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.addRoles = async (req, res) => {
  try {
    const { id } = req.query;
    const { roles, permissions } = req.body;
    let newRole;

    if (id) {
      newRole = await Roles.findByIdAndUpdate(
        id,
        { roles, permissions },
        { new: true },
      );

      // if nothing found → create new
      if (!newRole) {
        newRole = await Roles.create({ roles, permissions });
        return res.status(200).json({
          message: "New Role Added",
          newRole,
        });
      }

      return res.status(200).json({
        message: "Role Updated",
        newRole,
      });
    }
    newRole = await Roles.create({ roles, permissions });
    return res.status(200).json({ message: "New Role Created", newRole });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.getRoles = async (req, res) => {
  try {
    const roles = await Roles.find();
    return res.status(200).json({ message: "roles", roles });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.addStaff = async (req, res) => {
  try {
    const { name, email, password, roleId } = req.body;
    const newAdminStaff = await AdminStaff.create({
      name,
      email,
      password,
      roleId,
    });
    return res
      .status(200)
      .json({ message: "New Staff Member Created", newAdminStaff });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.editStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, roleId } = req.body;
    const staff = await AdminStaff.findById(id);

    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    const staffRole = await Roles.findById(staff.roleId); //eg->admin
    const editRole = await Roles.findById(roleId);

    // Block editing of admin user
    if (staffRole.roles !== "Admin" && editRole.roles === "Admin") {
      return res.status(403).json({ message: "Admin user cannot be edited" });
    }

    const newAdminStaff = await AdminStaff.findByIdAndUpdate(
      id,
      { name, email, password, roleId },
      { new: true },
    );
    return res
      .status(200)
      .json({ message: "Staff Updated Successfully", newAdminStaff });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.getStaff = async (req, res) => {
  try {
    const staff = await AdminStaff.find().populate("roleId");
    res.json(staff);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};
