const mongoose = require("mongoose");

const cashfreeRefundSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    orderId: { type: String, required: true, index: true },
    cashfreeOrderId: { type: String, required: true, index: true },
    refundId: { type: String, required: true },
    requestKey: { type: String, required: true },
    cashfreeRefundId: { type: String, default: null },
    amountMinor: { type: Number, required: true, min: 1 },
    vendorAmountMinor: { type: Number, default: 0, min: 0 },
    note: { type: String, required: true },
    status: {
      type: String,
      enum: ["REQUESTED", "PENDING", "SUCCESS", "FAILED", "UNKNOWN"],
      default: "REQUESTED",
    },
    gatewayStatus: { type: String, default: null },
    arn: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminStaff", default: null },
  },
  { timestamps: true },
);

cashfreeRefundSchema.index({ orderId: 1, refundId: 1 }, { unique: true });
cashfreeRefundSchema.index({ orderId: 1, requestKey: 1 }, { unique: true });

module.exports = mongoose.model("CashfreeRefund", cashfreeRefundSchema);
