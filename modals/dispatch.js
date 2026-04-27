const mongoose = require("mongoose");

const dispatchSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, index: true },

    assigned: { type: Boolean, default: false },

    retryCount: { type: Number, default: 0 },

    rejectedDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: "driver" }],
    respondedDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: "driver" }],

    status: {
      type: String,
      enum: ["pending", "assigned", "cancelled"],
      default: "pending",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("dispatch", dispatchSchema);
