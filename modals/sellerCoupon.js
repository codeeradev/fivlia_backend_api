const mongoose = require("mongoose");
const couponSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.ObjectId, ref: "stores" },
    image: String,
    sliderImage: String,
    offer: String,
    title: String,
    limit: Number,
    productId: [{ type: mongoose.Schema.ObjectId, ref: "products" }],
    status: { type: Boolean, default: true },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default:'pending'
    },
    fromTo:Date,
    validDays:Number,
    expireDate: Date,
  },
  { timestamps: true }
);
module.exports = mongoose.model("coupon", couponSchema);
