const mongoose = require("mongoose");
const couponSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.ObjectId, ref: "stores" },
    image: String,
    sliderImage: String,
    offerType: {
      type: String,
      enum: ["free_product", "cart_discount"],
      default: "cart_discount",
    },
    discountScope: {
      type: String,
      enum: ["entire_cart", "selected_products"],
      default: "entire_cart",
    },
    offer: String,
    title: String,
    minimumOrderAmount: Number,
    // Legacy field kept while older clients/records migrate to minimumOrderAmount.
    limit: Number,
    productId: [{ type: mongoose.Schema.ObjectId, ref: "Product" }],
    freeProductId: { type: mongoose.Schema.ObjectId, ref: "Product" },
    freeProductQuantity: { type: Number, default: 1 },
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
