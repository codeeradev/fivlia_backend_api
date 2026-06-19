const mongoose = require("mongoose");

const cartSchema = new mongoose.Schema(
  {
    image: String,
    price: { type: Number },
    mrp: Number,
    tax: String,
    name: String,
    quantity: Number,
    productId: { type: mongoose.Schema.ObjectId, ref: "products" },
    storeId: { type: mongoose.Schema.ObjectId, ref: "stores" },
    varientId: { type: mongoose.Schema.ObjectId },
    userId: { type: mongoose.Schema.ObjectId, ref: "Login" },
    paymentOption: { type: Boolean },
    isFreeProduct: { type: Boolean, default: false },
    //new keys for coupon
    couponId: { type: mongoose.Schema.ObjectId, ref: "coupon" },
    discountAmount: Number,
    finalPrice: Number,
    originalPrice: Number,
    isCouponApplied: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const discountSchema = new mongoose.Schema({
  head: String,
  value: Number,
  description: String,
});

module.exports = {
  Cart: mongoose.model("Cart", cartSchema),
  Discount: mongoose.model("Discount", discountSchema),
};
