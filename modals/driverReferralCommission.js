const mongoose = require("mongoose");

const driverReferralCommissionSchema = new mongoose.Schema(
  {
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "driver",
      required: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    orderId: {
      type: String,
      required: true,
      unique: true, // Ensure each order is counted only once
    },
    orderObjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    sellerProfit: {
      type: Number,
      required: true,
    },
    commissionAmount: {
      type: Number,
      required: true,
    },
    commissionPercentage: {
      type: Number,
      default: 1, // 1% commission
    },
    status: {
      type: String,
      enum: ["pending", "claimed"],
      default: "pending",
    },
    claimedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Index for faster queries
driverReferralCommissionSchema.index({ driverId: 1, status: 1 });
driverReferralCommissionSchema.index({ storeId: 1, orderId: 1 });

module.exports = mongoose.model(
  "DriverReferralCommission",
  driverReferralCommissionSchema
);
