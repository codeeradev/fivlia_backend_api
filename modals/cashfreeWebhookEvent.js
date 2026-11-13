const mongoose = require("mongoose");

const cashfreeWebhookEventSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, default: "UNKNOWN" },
    cashfreeOrderId: { type: String, default: null, index: true },
    processingStatus: {
      type: String,
      enum: ["PROCESSING", "PROCESSED", "FAILED", "IGNORED"],
      default: "PROCESSING",
    },
    attempts: { type: Number, default: 1 },
    lastError: { type: String, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CashfreeWebhookEvent", cashfreeWebhookEventSchema);
