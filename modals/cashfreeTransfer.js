const mongoose = require("mongoose");

const cashfreeTransferSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    vendorId: { type: String, required: true, index: true },
    requestKey: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    remark: { type: String, default: "" },
    settlementId: { type: String, default: null },
    status: {
      type: String,
      enum: ["REQUESTED", "UNKNOWN", "FAILED"],
      default: "REQUESTED",
    },
    merchantUnsettled: { type: Number, default: null },
    vendorUnsettled: { type: Number, default: null },
    serviceCharge: { type: Number, default: null },
    serviceTax: { type: Number, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminStaff", default: null },
  },
  { timestamps: true },
);

cashfreeTransferSchema.index({ storeId: 1, requestKey: 1 }, { unique: true });

module.exports = mongoose.model("CashfreeTransfer", cashfreeTransferSchema);
