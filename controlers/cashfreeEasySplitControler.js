const crypto = require("crypto");
const mongoose = require("mongoose");
const Store = require("../modals/store");
const { Order } = require("../modals/order");
const { SettingAdmin } = require("../modals/setting");
const CashfreeRefund = require("../modals/cashfreeRefund");
const CashfreeTransfer = require("../modals/cashfreeTransfer");
const {
  createCashfreeOnDemandTransfer,
  createCashfreeRefund,
  createCashfreeVendor,
  fetchCashfreeSplitDetails,
  fetchCashfreeVendor,
  fetchCashfreeVendorReconciliation,
  getCashfreeCredentials,
  stableIdempotencyKey,
  updateCashfreeVendor,
} = require("../utils/cashfreeService");
const { minorToMajor, toMinorUnits } = require("../utils/cashfreeEasySplit");

const getSettingsAndCredentials = async () => {
  const settings = await SettingAdmin.findOne().lean();
  if (!settings?.PaymentGateways?.Cashfree?.status) {
    throw new Error("Cashfree is not enabled in payment settings.");
  }
  const mode = settings.PaymentGateways.Cashfree.activeMode === "test" ? "test" : "live";
  const credentials = getCashfreeCredentials(settings.PaymentGateways, mode);
  return { settings, credentials, mode };
};

const requireEasySplit = (settings) => {
  if (settings?.PaymentGateways?.Cashfree?.easySplitEnabled !== true) {
    const error = new Error("Cashfree Easy Split is disabled in settings.");
    error.statusCode = 409;
    throw error;
  }
};

const safeMessage = (error) => {
  const status = Number(error?.response?.status);
  const message = String(error?.response?.data?.message || "");
  if (status >= 400 && status < 500 && message.length <= 200) return message;
  return "Cashfree request failed. Check Cashfree configuration and merchant account access.";
};

const sanitizeSplitDetails = (details) => ({
  settlement: details?.settlement
    ? {
        cfSettlementId: details.settlement.cf_settlement_id ?? null,
        cfPaymentId: details.settlement.cf_payment_id ?? null,
        orderId: details.settlement.order_id ?? null,
        orderAmount: details.settlement.order_amount ?? null,
        serviceCharge: details.settlement.service_charge ?? null,
        serviceTax: details.settlement.service_tax ?? null,
        settlementAmount: details.settlement.settlement_amount ?? null,
        settlementCurrency: details.settlement.settlement_currency ?? null,
        transferId: details.settlement.transfer_id ?? null,
        transferUtr: details.settlement.transfer_utr ?? null,
        transferTime: details.settlement.transfer_time ?? null,
        paymentTime: details.settlement.payment_time ?? null,
      }
    : null,
  vendors: (Array.isArray(details?.vendors) ? details.vendors : []).map((vendor) => ({
    vendorId: vendor.vendor_id ?? null,
    settlementId: vendor.settlement_id ?? null,
    settlementAmount: vendor.settlement_amount ?? null,
    settlementEligibilityDate: vendor.settlement_eligibility_date ?? null,
  })),
  refunds: (Array.isArray(details?.refunds) ? details.refunds : []).map((refund) => ({
    refundId: refund.refund_id ?? null,
    cashfreeRefundId: refund.cf_refund_id ?? null,
    amount: refund.refund_amount ?? null,
    status: refund.refund_status ?? null,
    arn: refund.refund_arn ?? null,
    createdAt: refund.created_at ?? null,
  })),
});

const publicRefund = (refund) => ({
  refundId: refund.refundId,
  cashfreeRefundId: refund.cashfreeRefundId,
  orderId: refund.orderId,
  amount: minorToMajor(refund.amountMinor),
  vendorAmount: minorToMajor(refund.vendorAmountMinor),
  status: refund.status,
  gatewayStatus: refund.gatewayStatus,
  note: refund.note,
  arn: refund.arn,
  createdAt: refund.createdAt,
  updatedAt: refund.updatedAt,
});

const toRefundStatus = (status) => {
  const normalized = String(status || "PENDING").toUpperCase();
  if (normalized === "SUCCESS") return "SUCCESS";
  if (["FAILED", "REJECTED", "CANCELLED"].includes(normalized)) return "FAILED";
  return "PENDING";
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const reconcileOrderRefunds = async (order, providerRefunds = []) => {
  for (const providerRefund of providerRefunds) {
    if (!providerRefund?.refund_id || !providerRefund?.refund_status) continue;
    const status = toRefundStatus(providerRefund.refund_status);
    const refundRecord = await CashfreeRefund.findOneAndUpdate(
      { order: order._id, refundId: String(providerRefund.refund_id), status: { $in: ["REQUESTED", "PENDING", "UNKNOWN"] } },
      { $set: {
        status,
        gatewayStatus: String(providerRefund.refund_status),
        cashfreeRefundId: providerRefund.cf_refund_id ? String(providerRefund.cf_refund_id) : null,
        arn: providerRefund.refund_arn || null,
      } },
      { new: true },
    );
    if (refundRecord && status === "FAILED") {
      await Order.updateOne({ _id: order._id }, {
        $inc: {
          cashfreeRefundReservedMinor: -refundRecord.amountMinor,
          cashfreeRefundVendorReservedMinor: -refundRecord.vendorAmountMinor,
        },
      });
    }
  }
};

const orderLookup = (value) => mongoose.isValidObjectId(value)
  ? { $or: [{ _id: value }, { orderId: value }] }
  : { orderId: value };

const validateVendorInput = (body = {}) => {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  let phone = String(body.phone || "").replace(/\D/g, "");
  if (phone.startsWith("91") && phone.length === 12) phone = phone.slice(2);
  const payoutMethod = body.payoutMethod === "upi" ? "upi" : "bank";
  const kycDetails = body.kycDetails || {};
  if (!name || !/^[A-Za-z0-9 .\-/&]{2,100}$/.test(name)) {
    throw new Error("Enter a valid vendor name (letters, numbers, spaces, and . / - & only).");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid vendor email.");
  if (phone.length < 8 || phone.length > 12) throw new Error("Enter a valid vendor phone number.");
  if (!kycDetails.account_type) throw new Error("Cashfree KYC account type is required.");

  const payload = {
    name,
    email,
    phone,
    status: "ACTIVE",
    verify_account: body.verifyAccount !== false,
    dashboard_access: false,
    schedule_option: Number(body.scheduleOption || 1),
    kyc_details: Object.fromEntries(
      ["account_type", "business_type", "uidai", "gst", "cin", "pan", "passport_number", "driving_license", "voter_id"]
        .map((key) => [key, kycDetails[key]])
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ""),
    ),
  };
  if (payoutMethod === "upi") {
    const vpa = String(body.upiVpa || "").trim();
    const accountHolder = String(body.accountHolder || name).trim();
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]{2,}$/.test(vpa) || vpa.length > 100) {
      throw new Error("Enter a valid UPI ID.");
    }
    payload.upi = { vpa, account_holder: accountHolder };
  } else {
    const accountNumber = String(body.accountNumber || "").replace(/\s/g, "");
    const ifsc = String(body.ifsc || "").trim().toUpperCase();
    const accountHolder = String(body.accountHolder || name).trim();
    if (!/^\d{6,18}$/.test(accountNumber)) throw new Error("Enter a valid bank account number.");
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new Error("Enter a valid IFSC code.");
    payload.bank = { account_number: accountNumber, account_holder: accountHolder, ifsc };
  }
  return { payload, payoutMethod };
};

exports.listAdminCashfreeVendors = async (req, res) => {
  try {
    const { page = 1, limit = 50, search = "" } = req.query;
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * safeLimit;
    const query = search
      ? { $or: [
          { storeName: { $regex: String(search).slice(0, 60), $options: "i" } },
          { ownerName: { $regex: String(search).slice(0, 60), $options: "i" } },
          { "cashfreeEasySplit.vendorId": { $regex: String(search).slice(0, 60), $options: "i" } },
        ] }
      : {};
    const [vendors, count] = await Promise.all([
      Store.find(query)
        .select("storeName ownerName email PhoneNumber approveStatus cashfreeEasySplit")
        .sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
      Store.countDocuments(query),
    ]);
    res.json({ status: true, vendors, page: Number(page) || 1, limit: safeLimit, count });
  } catch (error) {
    res.status(500).json({ status: false, message: "Unable to load Cashfree vendor records." });
  }
};

exports.listAdminCashfreeVendorOptions = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 500);
    const stores = await Store.find({})
      .select("storeName")
      .sort({ storeName: 1 })
      .limit(limit)
      .lean();
    return res.json({
      status: true,
      stores: stores.map((store) => ({ _id: String(store._id), storeName: store.storeName || "" })),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: "Unable to load store filter options." });
  }
};

exports.registerCashfreeVendor = async (req, res) => {
  try {
    const { settings, credentials } = await getSettingsAndCredentials();
    requireEasySplit(settings);
    const store = await Store.findById(req.params.storeId).select("_id storeName ownerName email PhoneNumber cashfreeEasySplit");
    if (!store) return res.status(404).json({ status: false, message: "Store not found." });
    if (store.cashfreeEasySplit?.vendorId) {
      return res.status(409).json({ status: false, message: "This store already has a Cashfree vendor ID. Use vendor update instead." });
    }
    const { payload, payoutMethod } = validateVendorInput(req.body);
    const vendorId = `FV_${store._id.toString()}`;
    const provider = await createCashfreeVendor(
      credentials,
      { vendor_id: vendorId, ...payload },
      stableIdempotencyKey(`cashfree-vendor-create:${vendorId}`),
    );
    const status = String(provider?.status || "IN_BENE_CREATION").toUpperCase();
    store.cashfreeEasySplit = {
      vendorId,
      status,
      accountType: payload.kyc_details.account_type,
      payoutMethod,
      lastSyncedAt: new Date(),
      registeredAt: new Date(),
    };
    await store.save();
    return res.status(201).json({
      status: true,
      vendor: { storeId: String(store._id), vendorId, status, payoutMethod },
      message: "Cashfree vendor registration submitted. Vendor activation is controlled by Cashfree verification.",
    });
  } catch (error) {
    console.error("Cashfree vendor registration failed:", safeMessage(error));
    return res.status(error.statusCode || 400).json({ status: false, message: safeMessage(error) });
  }
};

exports.updateCashfreeVendorDetails = async (req, res) => {
  try {
    const { settings, credentials } = await getSettingsAndCredentials();
    requireEasySplit(settings);
    const store = await Store.findById(req.params.storeId);
    if (!store?.cashfreeEasySplit?.vendorId) {
      return res.status(404).json({ status: false, message: "Cashfree vendor is not registered for this store." });
    }
    const { payload, payoutMethod } = validateVendorInput(req.body);
    const currentStatus = String(store.cashfreeEasySplit.status || "").toUpperCase();
    payload.status = ["ACTIVE", "BLOCKED"].includes(currentStatus) ? currentStatus : "ACTIVE";
    const requestKey = String(req.body.idempotencyKey || "");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) {
      return res.status(400).json({ status: false, message: "Provide a stable idempotencyKey for the vendor update." });
    }
    const provider = await updateCashfreeVendor(
      credentials,
      store.cashfreeEasySplit.vendorId,
      payload,
      stableIdempotencyKey(`cashfree-vendor-update:${store._id}:${requestKey}`),
    );
    store.cashfreeEasySplit.status = String(provider?.status || payload.status).toUpperCase();
    store.cashfreeEasySplit.accountType = payload.kyc_details.account_type;
    store.cashfreeEasySplit.payoutMethod = payoutMethod;
    store.cashfreeEasySplit.lastSyncedAt = new Date();
    await store.save();
    return res.json({
      status: true,
      vendor: {
        storeId: String(store._id),
        vendorId: store.cashfreeEasySplit.vendorId,
        status: store.cashfreeEasySplit.status,
        payoutMethod,
      },
      message: "Cashfree vendor details updated. Vendor verification and activation remain controlled by Cashfree.",
    });
  } catch (error) {
    console.error("Cashfree vendor detail update failed:", safeMessage(error));
    return res.status(error.statusCode || 400).json({ status: false, message: safeMessage(error) });
  }
};

exports.syncCashfreeVendorStatus = async (req, res) => {
  try {
    const { settings, credentials } = await getSettingsAndCredentials();
    const store = await Store.findById(req.params.storeId);
    if (!store?.cashfreeEasySplit?.vendorId) {
      return res.status(404).json({ status: false, message: "Cashfree vendor is not registered for this store." });
    }
    const provider = await fetchCashfreeVendor(credentials, store.cashfreeEasySplit.vendorId);
    store.cashfreeEasySplit.status = String(provider?.status || store.cashfreeEasySplit.status).toUpperCase();
    store.cashfreeEasySplit.lastSyncedAt = new Date();
    await store.save();
    return res.json({ status: true, vendor: {
      storeId: String(store._id), vendorId: store.cashfreeEasySplit.vendorId,
      status: store.cashfreeEasySplit.status, lastSyncedAt: store.cashfreeEasySplit.lastSyncedAt,
    } });
  } catch (error) {
    console.error("Cashfree vendor status sync failed:", safeMessage(error));
    return res.status(error.statusCode || 502).json({ status: false, message: safeMessage(error) });
  }
};

exports.updateCashfreeVendorStatus = async (req, res) => {
  try {
    const nextStatus = String(req.body.status || "").toUpperCase();
    if (!["ACTIVE", "BLOCKED"].includes(nextStatus)) {
      return res.status(400).json({ status: false, message: "Status must be ACTIVE or BLOCKED." });
    }
    const { settings, credentials } = await getSettingsAndCredentials();
    const store = await Store.findById(req.params.storeId);
    if (!store?.cashfreeEasySplit?.vendorId) return res.status(404).json({ status: false, message: "Cashfree vendor is not registered." });
    const current = await fetchCashfreeVendor(credentials, store.cashfreeEasySplit.vendorId);
    const patch = {
      status: nextStatus,
      name: current.name,
      email: current.email,
      phone: current.phone,
      kyc_details: current.kyc_details,
      verify_account: false,
      dashboard_access: Boolean(current.dashboard_access),
    };
    const provider = await updateCashfreeVendor(
      credentials, store.cashfreeEasySplit.vendorId, patch,
      stableIdempotencyKey(`cashfree-vendor-status:${store.cashfreeEasySplit.vendorId}:${nextStatus}`),
    );
    store.cashfreeEasySplit.status = String(provider?.status || nextStatus).toUpperCase();
    store.cashfreeEasySplit.lastSyncedAt = new Date();
    await store.save();
    return res.json({ status: true, vendor: {
      storeId: String(store._id), vendorId: store.cashfreeEasySplit.vendorId,
      status: store.cashfreeEasySplit.status, lastSyncedAt: store.cashfreeEasySplit.lastSyncedAt,
    } });
  } catch (error) {
    console.error("Cashfree vendor update failed:", safeMessage(error));
    return res.status(error.statusCode || 502).json({ status: false, message: safeMessage(error) });
  }
};

exports.listAdminCashfreePayments = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const query = { paymentGateway: "cashfree" };
    if (req.query.storeId) {
      if (!mongoose.isValidObjectId(req.query.storeId)) {
        return res.status(400).json({ status: false, message: "Invalid store ID." });
      }
      query.storeId = new mongoose.Types.ObjectId(req.query.storeId);
    }
    if (req.query.orderId) query.orderId = { $regex: escapeRegex(String(req.query.orderId).slice(0, 60)), $options: "i" };
    if (req.query.from || req.query.to) {
      query.createdAt = {};
      if (req.query.from && !Number.isNaN(Date.parse(req.query.from))) {
        query.createdAt.$gte = new Date(req.query.from);
      }
      if (req.query.to && !Number.isNaN(Date.parse(req.query.to))) {
        const endDate = new Date(req.query.to);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) {
          endDate.setUTCHours(23, 59, 59, 999);
        }
        query.createdAt.$lte = endDate;
      }
    }
    const paymentProjection = (recordType, priority) => ({
      orderId: 1,
      storeId: 1,
      totalPrice: 1,
      paymentStatus: 1,
      orderStatus: 1,
      transactionId: 1,
      cashfreeOrderId: 1,
      cashfreeStatus: 1,
      cashfreePaymentId: 1,
      cashfreeEasySplit: 1,
      createdAt: 1,
      recordType: { $literal: recordType },
      _recordPriority: { $literal: priority },
    });
    const statusFilter = req.query.status
      ? {
          $match: {
            $or: [
              { paymentStatus: { $regex: `^${escapeRegex(String(req.query.status).slice(0, 40))}$`, $options: "i" } },
              { cashfreeStatus: { $regex: `^${escapeRegex(String(req.query.status).slice(0, 40))}$`, $options: "i" } },
            ],
          },
        }
      : null;
    const pipeline = [
      { $match: query },
      { $project: paymentProjection("order", 1) },
      {
        $unionWith: {
          coll: TempOrder.collection.name,
          pipeline: [
            { $match: query },
            { $project: paymentProjection("paymentAttempt", 0) },
          ],
        },
      },
      { $sort: { _recordPriority: -1, createdAt: -1 } },
      {
        $group: {
          _id: { $ifNull: ["$cashfreeOrderId", { $toString: "$_id" }] },
          record: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$record" } },
      ...(statusFilter ? [statusFilter] : []),
      {
        $facet: {
          metadata: [{ $count: "total" }],
          orders: [
            { $sort: { createdAt: -1, _recordPriority: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            { $project: { _recordPriority: 0 } },
          ],
        },
      },
    ];
    const [result] = await Order.aggregate(pipeline);
    const orders = result?.orders || [];
    const count = result?.metadata?.[0]?.total || 0;
    const storeIds = [...new Set(orders.map((order) => String(order.storeId)).filter(Boolean))]
      .filter(mongoose.isValidObjectId)
      .map((id) => new mongoose.Types.ObjectId(id));
    const [stores, refunds] = await Promise.all([
      storeIds.length ? Store.find({ _id: { $in: storeIds } }).select("storeName").lean() : [],
      orders.some((order) => order.recordType === "order")
        ? CashfreeRefund.find({ order: { $in: orders.filter((order) => order.recordType === "order").map((order) => order._id) } }).sort({ createdAt: -1 }).lean()
        : [],
    ]);
    const storesById = new Map(stores.map((store) => [String(store._id), store]));
    const refundsByOrder = new Map();
    for (const refund of refunds) {
      const key = String(refund.order);
      refundsByOrder.set(key, [...(refundsByOrder.get(key) || []), publicRefund(refund)]);
    }
    return res.json({
      status: true,
      page,
      limit,
      count,
      orders: orders.map((order) => ({
        ...order,
        storeId: storesById.get(String(order.storeId)) || order.storeId,
        refunds: refundsByOrder.get(String(order._id)) || [],
      })),
    });
  } catch (error) {
    console.error("Cashfree payment list failed:", error.message || error);
    res.status(500).json({ status: false, message: "Unable to load Cashfree payment records." });
  }
};

exports.syncCashfreeOrderSplit = async (req, res) => {
  try {
    const { settings, credentials } = await getSettingsAndCredentials();
    const order = await Order.findOne({ ...orderLookup(req.params.orderId), paymentGateway: "cashfree" });
    if (!order?.cashfreeOrderId) return res.status(404).json({ status: false, message: "Cashfree order not found." });
    const providerDetails = await fetchCashfreeSplitDetails(credentials, order.cashfreeOrderId);
    await reconcileOrderRefunds(order, providerDetails?.refunds || []);
    const safeDetails = sanitizeSplitDetails(providerDetails);
    order.cashfreeEasySplit = {
      ...(order.cashfreeEasySplit || {}),
      settlementDetails: safeDetails,
      lastSyncedAt: new Date(),
      providerSyncStatus: "SYNCED",
    };
    await order.save();
    return res.json({ status: true, orderId: order.orderId, split: order.cashfreeEasySplit });
  } catch (error) {
    console.error("Cashfree split sync failed:", safeMessage(error));
    res.status(error.statusCode || 502).json({ status: false, message: safeMessage(error) });
  }
};

exports.createCashfreeOrderRefund = async (req, res) => {
  let reserved = false;
  let reservedAmountMinor = 0;
  let reservedVendorMinor = 0;
  let refundRecord;
  let order;
  try {
    const { settings, credentials } = await getSettingsAndCredentials();
    order = await Order.findOne({ ...orderLookup(req.params.orderId), paymentGateway: "cashfree" });
    if (!order?.cashfreeOrderId || order.paymentStatus !== "Successful") {
      return res.status(409).json({ status: false, message: "Only successful Cashfree payments can be refunded." });
    }
    const requestKey = String(req.body.idempotencyKey || "");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) {
      return res.status(400).json({ status: false, message: "Provide a stable idempotencyKey for the refund request." });
    }
    const existing = await CashfreeRefund.findOne({ orderId: order.orderId, requestKey }).lean();
    if (existing) return res.json({ status: true, refund: publicRefund(existing), repeated: true });

    const amountMinor = toMinorUnits(req.body.refundAmount);
    if (amountMinor <= 0) return res.status(400).json({ status: false, message: "Refund amount must be greater than zero." });
    const capMinor = toMinorUnits(order.totalPrice || 0);
    const isSplit = order.cashfreeEasySplit?.enabled === true;
    const vendorAmountMinor = isSplit ? toMinorUnits(req.body.vendorRefundAmount ?? 0) : 0;
    reservedAmountMinor = amountMinor;
    reservedVendorMinor = vendorAmountMinor;
    const splitVendorAmountMinor = Number(order.cashfreeEasySplit?.vendorAmountMinor || 0);
    if (amountMinor > capMinor) return res.status(400).json({ status: false, message: "Refund amount exceeds the order payment." });
    if (isSplit && (vendorAmountMinor < 0 || vendorAmountMinor > amountMinor)) {
      return res.status(400).json({ status: false, message: "Vendor refund must be between zero and the customer refund amount." });
    }
    if (isSplit && !order.cashfreeEasySplit?.vendorId) return res.status(409).json({ status: false, message: "The order does not have a Cashfree vendor allocation." });

    const filter = {
      _id: order._id,
      $expr: { $and: [
        { $lte: [
          { $add: [{ $ifNull: ["$cashfreeRefundReservedMinor", 0] }, amountMinor] }, capMinor,
        ] },
      ] },
    };
    if (isSplit) {
      filter.$expr.$and.push({ $lte: [
        { $add: [{ $ifNull: ["$cashfreeRefundVendorReservedMinor", 0] }, vendorAmountMinor] },
        splitVendorAmountMinor,
      ] });
    }
    const reservedOrder = await Order.findOneAndUpdate(filter, {
      $inc: {
        cashfreeRefundReservedMinor: amountMinor,
        ...(isSplit ? { cashfreeRefundVendorReservedMinor: vendorAmountMinor } : {}),
      },
    }, { new: true });
    if (!reservedOrder) return res.status(409).json({ status: false, message: "This refund would exceed the remaining refundable order or vendor balance." });
    reserved = true;

    const refundId = `rf${stableIdempotencyKey(`cashfree-refund:${order.orderId}:${requestKey}`).replace(/-/g, "")}`;
    const note = String(req.body.note || `Refund for order ${order.orderId}`).trim().slice(0, 100);
    if (note.length < 3) throw new Error("Refund note must contain at least 3 characters.");
    refundRecord = await CashfreeRefund.create({
      order: order._id,
      orderId: order.orderId,
      cashfreeOrderId: order.cashfreeOrderId,
      refundId,
      requestKey,
      amountMinor,
      vendorAmountMinor,
      note,
      status: "REQUESTED",
      createdBy: req.staff?._id || null,
    });

    const refundPayload = {
      refund_amount: minorToMajor(amountMinor),
      refund_id: refundId,
      refund_note: note,
      refund_speed: req.body.refundSpeed === "INSTANT" ? "INSTANT" : "STANDARD",
      ...(isSplit && vendorAmountMinor > 0 ? {
        refund_splits: [{ vendor: order.cashfreeEasySplit.vendorId, amount: minorToMajor(vendorAmountMinor) }],
      } : {}),
    };
    const provider = await createCashfreeRefund(
      credentials, order.cashfreeOrderId, refundPayload,
      stableIdempotencyKey(`cashfree-refund-request:${order.orderId}:${requestKey}`),
    );
    const status = toRefundStatus(provider?.refund_status);
    refundRecord.cashfreeRefundId = provider?.cf_refund_id ? String(provider.cf_refund_id) : null;
    refundRecord.gatewayStatus = String(provider?.refund_status || "PENDING");
    refundRecord.status = status;
    refundRecord.arn = provider?.refund_arn || null;
    await refundRecord.save();
    if (status === "FAILED") {
      await Order.updateOne({ _id: order._id }, {
        $inc: {
          cashfreeRefundReservedMinor: -amountMinor,
          cashfreeRefundVendorReservedMinor: -vendorAmountMinor,
        },
      });
      reserved = false;
    }
    return res.status(201).json({ status: true, refund: publicRefund(refundRecord) });
  } catch (error) {
    if (refundRecord && error?.response?.status >= 400 && error?.response?.status < 500) {
      await CashfreeRefund.findByIdAndUpdate(refundRecord._id, { status: "FAILED", gatewayStatus: "REJECTED" });
      await Order.updateOne({ _id: order._id }, {
        $inc: {
          cashfreeRefundReservedMinor: -refundRecord.amountMinor,
          cashfreeRefundVendorReservedMinor: -refundRecord.vendorAmountMinor,
        },
      });
      reserved = false;
    } else if (refundRecord) {
      // A timeout can happen after Cashfree accepted the operation. Keep the reserve
      // until reconciliation proves failure, preventing an accidental duplicate refund.
      await CashfreeRefund.findByIdAndUpdate(refundRecord._id, { status: "UNKNOWN", gatewayStatus: "UNKNOWN" });
    } else if (reserved && order) {
      // Failures before a provider request are safe to release.
      if (reservedAmountMinor > 0) await Order.updateOne({ _id: order._id }, { $inc: { cashfreeRefundReservedMinor: -reservedAmountMinor, cashfreeRefundVendorReservedMinor: -reservedVendorMinor } });
    }
    console.error("Cashfree refund request failed:", safeMessage(error));
    return res.status(error.statusCode || 502).json({ status: false, message: safeMessage(error) });
  }
};

exports.getCashfreeVendorReconciliation = async (req, res) => {
  try {
    const { settings, credentials } = await getSettingsAndCredentials();
    const limit = Math.min(Math.max(Number(req.body.limit) || 100, 1), 100);
    const filters = {};
    const vendorId = String(req.body.vendorId || "").trim();
    const startDate = req.body.startDate ? new Date(req.body.startDate) : null;
    const endDate = req.body.endDate ? new Date(req.body.endDate) : null;
    if (vendorId) filters.merchant_vendor_id = vendorId;
    if (startDate && !Number.isNaN(startDate.getTime())) filters.start_date = startDate.toISOString();
    if (endDate && !Number.isNaN(endDate.getTime())) filters.end_date = endDate.toISOString();
    const report = await fetchCashfreeVendorReconciliation(credentials, {
      pagination: { limit, cursor: req.body.cursor || null },
      filters,
    });
    return res.json({ status: true, report });
  } catch (error) {
    console.error("Cashfree reconciliation failed:", safeMessage(error));
    res.status(error.statusCode || 502).json({ status: false, message: safeMessage(error) });
  }
};

const publicTransfer = (transfer) => ({
  storeId: String(transfer.storeId),
  vendorId: transfer.vendorId,
  settlementId: transfer.settlementId,
  amount: minorToMajor(transfer.amountMinor),
  remark: transfer.remark,
  status: transfer.status,
  merchantUnsettled: transfer.merchantUnsettled,
  vendorUnsettled: transfer.vendorUnsettled,
  serviceCharge: transfer.serviceCharge,
  serviceTax: transfer.serviceTax,
  createdAt: transfer.createdAt,
});

exports.listAdminCashfreeTransfers = async (req, res) => {
  try {
    const query = {};
    if (req.query.storeId) query.storeId = req.query.storeId;
    const transfers = await CashfreeTransfer.find(query).populate("storeId", "storeName")
      .sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)).lean();
    return res.json({ status: true, transfers: transfers.map((transfer) => ({
      ...publicTransfer(transfer),
      storeName: transfer.storeId?.storeName || "",
    })) });
  } catch (error) {
    res.status(500).json({ status: false, message: "Unable to load Cashfree vendor transfer records." });
  }
};

exports.createCashfreeVendorTransfer = async (req, res) => {
  let transferRecord;
  try {
    if (req.body.confirmVendorSettlement !== true) {
      return res.status(400).json({ status: false, message: "Confirm the vendor on-demand settlement request." });
    }
    const requestKey = String(req.body.idempotencyKey || "");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) {
      return res.status(400).json({ status: false, message: "Provide a stable idempotencyKey for the transfer request." });
    }
    const { settings, credentials } = await getSettingsAndCredentials();
    requireEasySplit(settings);
    const store = await Store.findById(req.params.storeId).select("cashfreeEasySplit").lean();
    if (!store?.cashfreeEasySplit?.vendorId || String(store.cashfreeEasySplit.status).toUpperCase() !== "ACTIVE") {
      return res.status(409).json({ status: false, message: "Only an active Cashfree vendor can receive an on-demand settlement." });
    }
    const existing = await CashfreeTransfer.findOne({ storeId: req.params.storeId, requestKey });
    if (existing?.status === "FAILED") {
      return res.status(409).json({ status: false, message: "This idempotency key was already rejected. Use a new request key after reviewing the failure." });
    }
    const amountMinor = toMinorUnits(req.body.transferAmount);
    if (amountMinor <= 0) return res.status(400).json({ status: false, message: "Transfer amount must be greater than zero." });
    const remark = String(req.body.remark || "Vendor settlement").trim().slice(0, 100);
    if (remark.length < 3) return res.status(400).json({ status: false, message: "Remark must contain at least 3 characters." });

    transferRecord = existing || await CashfreeTransfer.create({
      storeId: req.params.storeId,
      vendorId: store.cashfreeEasySplit.vendorId,
      requestKey,
      amountMinor,
      remark,
      status: "REQUESTED",
      createdBy: req.staff?._id || null,
    });
    if (transferRecord.amountMinor !== amountMinor || transferRecord.vendorId !== store.cashfreeEasySplit.vendorId) {
      return res.status(409).json({ status: false, message: "This idempotency key is already associated with a different transfer." });
    }
    if (existing?.settlementId) return res.json({ status: true, transfer: publicTransfer(existing), repeated: true });

    const provider = await createCashfreeOnDemandTransfer(
      credentials,
      transferRecord.vendorId,
      {
        transfer_from: "VENDOR",
        transfer_type: "ON_DEMAND",
        transfer_amount: minorToMajor(amountMinor),
        remark,
      },
      stableIdempotencyKey(`cashfree-on-demand-transfer:${req.params.storeId}:${requestKey}`),
    );
    transferRecord.status = "REQUESTED";
    transferRecord.settlementId = provider?.settlement_id ? String(provider.settlement_id) : null;
    transferRecord.merchantUnsettled = provider?.balances?.merchant_unsettled ?? null;
    transferRecord.vendorUnsettled = provider?.balances?.vendor_unsettled ?? null;
    transferRecord.serviceCharge = provider?.charges?.service_charges ?? null;
    transferRecord.serviceTax = provider?.charges?.service_tax ?? null;
    await transferRecord.save();
    return res.status(201).json({
      status: true,
      message: "Cashfree accepted the on-demand settlement request. Final transfer status must be checked in reconciliation.",
      transfer: publicTransfer(transferRecord),
    });
  } catch (error) {
    if (transferRecord && error?.response?.status >= 400 && error?.response?.status < 500) {
      transferRecord.status = "FAILED";
      await transferRecord.save().catch(() => {});
    } else if (transferRecord) {
      transferRecord.status = "UNKNOWN";
      await transferRecord.save().catch(() => {});
    }
    console.error("Cashfree vendor transfer failed:", safeMessage(error));
    return res.status(error.statusCode || 502).json({ status: false, message: safeMessage(error) });
  }
};

exports.getSellerCashfreeFinancials = async (req, res) => {
  try {
    const storeId = req.auth?.storeId;
    if (req.auth?.role !== "seller" || !mongoose.isValidObjectId(storeId)) {
      return res.status(403).json({ status: false, message: "Seller account required." });
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const query = { storeId: new mongoose.Types.ObjectId(storeId), paymentGateway: "cashfree", "cashfreeEasySplit.enabled": true };
    const [orders, count, totals] = await Promise.all([
      Order.find(query).select("orderId totalPrice paymentStatus cashfreeStatus cashfreeEasySplit createdAt orderStatus")
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Order.countDocuments(query),
      Order.aggregate([
        { $match: query },
        { $lookup: {
          from: CashfreeRefund.collection.name,
          localField: "_id",
          foreignField: "order",
          as: "refundRows",
        } },
        { $unwind: { path: "$refundRows", preserveNullAndEmptyArrays: true } },
        { $group: {
          _id: "$_id",
          vendorEarningsMinor: { $first: { $ifNull: ["$cashfreeEasySplit.vendorAmountMinor", 0] } },
          orderCount: { $first: 1 },
          refundedMinor: { $sum: { $cond: [
            { $eq: ["$refundRows.status", "SUCCESS"] },
            { $ifNull: ["$refundRows.vendorAmountMinor", 0] },
            0,
          ] } },
          pendingRefundMinor: { $sum: { $cond: [
            { $in: ["$refundRows.status", ["REQUESTED", "PENDING", "UNKNOWN"]] },
            { $ifNull: ["$refundRows.vendorAmountMinor", 0] },
            0,
          ] } },
        } },
        { $group: {
          _id: null,
          vendorEarningsMinor: { $sum: "$vendorEarningsMinor" },
          refundedMinor: { $sum: "$refundedMinor" },
          pendingRefundMinor: { $sum: "$pendingRefundMinor" },
          orderCount: { $sum: "$orderCount" },
        } },
      ]),
    ]);
    const orderRefunds = orders.length
      ? await CashfreeRefund.find({ order: { $in: orders.map((order) => order._id) } }).sort({ createdAt: -1 }).lean()
      : [];
    const refundsByOrder = new Map();
    for (const refund of orderRefunds) {
      const key = String(refund.order);
      refundsByOrder.set(key, [...(refundsByOrder.get(key) || []), publicRefund(refund)]);
    }
    const totalsRow = totals[0] || {};
    const earningsMinor = Number(totalsRow.vendorEarningsMinor || 0);
    const refundedMinor = Number(totalsRow.refundedMinor || 0);
    return res.json({
      status: true,
      summary: {
        allocatedEarnings: minorToMajor(earningsMinor),
        refundedVendorAmount: minorToMajor(refundedMinor),
        pendingVendorRefundAmount: minorToMajor(totalsRow.pendingRefundMinor || 0),
        netAfterSuccessfulRefunds: minorToMajor(earningsMinor - refundedMinor),
        paidOrders: totalsRow.orderCount || 0,
      },
      page,
      limit,
      count,
      orders: orders.map((order) => ({
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        paymentGatewayStatus: order.cashfreeStatus,
        vendorAmount: minorToMajor(order.cashfreeEasySplit?.vendorAmountMinor || 0),
        platformAmount: minorToMajor(order.cashfreeEasySplit?.platformAmountMinor || 0),
        splitStatus: order.cashfreeEasySplit?.providerSyncStatus || order.cashfreeEasySplit?.status || "PENDING",
        settlementDetails: order.cashfreeEasySplit?.settlementDetails || null,
        refunds: refundsByOrder.get(String(order._id)) || [],
        createdAt: order.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ status: false, message: "Unable to load your Cashfree earnings." });
  }
};

exports.applyCashfreeRefundWebhook = async (body) => {
  const data = body?.data || {};
  const refund = data.refund || data.refund_details || data;
  const refundId = refund?.refund_id || refund?.refundId;
  const gatewayStatus = refund?.refund_status || refund?.status;
  if (!refundId || !gatewayStatus) return false;
  const status = toRefundStatus(gatewayStatus);
  const refundRecord = await CashfreeRefund.findOneAndUpdate(
    { refundId: String(refundId), status: { $in: ["REQUESTED", "PENDING", "UNKNOWN"] } },
    { $set: { status, gatewayStatus: String(gatewayStatus), arn: refund?.refund_arn || null } },
    { new: true },
  );
  if (refundRecord && status === "FAILED") {
    await Order.updateOne({ _id: refundRecord.order }, {
      $inc: {
        cashfreeRefundReservedMinor: -refundRecord.amountMinor,
        cashfreeRefundVendorReservedMinor: -refundRecord.vendorAmountMinor,
      },
    });
  }
  return Boolean(refundRecord);
};

exports.cashfreeWebhookEventKey = (timestamp, rawBody) => crypto
  .createHash("sha256")
  .update(Buffer.concat([Buffer.from(String(timestamp || "")), Buffer.from(rawBody)]))
  .digest("hex");
