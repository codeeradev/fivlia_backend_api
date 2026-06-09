const mongoose = require("mongoose");

const foodTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  image: { type: String },
  orderCount: { type: Number, default: 0 },
  filter: [{ type: String }],
  status: { type: Boolean, default: true },
  commission: { type: Number, default: 0 },
}, { timestamps: true });

const FoodType = mongoose.model("FoodType", foodTypeSchema);

module.exports = FoodType;