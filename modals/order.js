const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, default: "OID001" },
    addressId: { type: mongoose.Schema.ObjectId, ref: "Address" },
    paymentStatus: String,
    userId: { type: mongoose.Schema.ObjectId, ref: "Login" },
    cashOnDelivery: { type: Boolean },
    items: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        varientId: { type: mongoose.Schema.Types.ObjectId },
        name: String,
        quantity: Number,
        price: Number,
        commision: Number,
        image: String,
        gst: String,
        typeId: { type: mongoose.Schema.Types.ObjectId, ref: "type" },
        typeName: String,
      },
    ],
    totalPrice: Number,
    deliveryCharges: Number,
    deliveryDistanceKm: Number,
    storeId: { type: mongoose.Schema.ObjectId, ref: "Store" },
    orderStatus: { type: String, default: "Pending" },
    preparationTime: Number,
    instantTime: String,
    platformFee: Number,
    invoiceUrl: { type: String },
    storeInvoiceId: { type: String },
    feeInvoiceId: { type: String },
    thermalInvoice: { type: String },
    deliveryPayout: Number,
    transactionId: String,
    deliverBy: String,
    note: String,
    driver: { driverId: String, name: String, mobileNumber: String },
    deliverStatus: { type: Boolean, default: false },
    foodSellerTaxPercent: { type: Number, default: 0 },
    foodSellerTaxAmount: { type: Number, default: 0 },
    notifyAttempts: {
      type: Number,
      default: 0,
    },

    lastNotifyAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// models/TempOrder.js

const TempOrderSchema = new mongoose.Schema(
  {
    items: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        varientId: { type: mongoose.Schema.Types.ObjectId },
        name: String,
        quantity: Number,
        price: Number,
        commision: Number,
        image: String,
        gst: String,
        typeId: { type: mongoose.Schema.Types.ObjectId, ref: "type" },
        typeName: String,
      },
    ],
    orderId: { type: String, default: "OID001" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    addressId: { type: mongoose.Schema.Types.ObjectId, ref: "Address" },
    paymentStatus: String,
    cashOnDelivery: Boolean,
    storeId: { type: mongoose.Schema.ObjectId, ref: "Store" },
    totalPrice: Number,
    deliveryPayout: Number,
    transactionId: { type: String },
    razorpayStatus: { type: String },
    razorpayResponse: { type: Object },
    razorpayOrderId: String,
    deliveryCharges: Number,
    deliveryDistanceKm: Number,
    platformFee: Number,
    foodSellerTaxPercent: { type: Number, default: 0 },
    foodSellerTaxAmount: { type: Number, default: 0 },
    instructions: String,
    cartIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "carts" }],
  },
  { timestamps: true },
);

module.exports = {
  Order: mongoose.model("Order", orderSchema),
  TempOrder: mongoose.model("TempOrder", TempOrderSchema),
};
