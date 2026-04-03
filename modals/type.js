const mongoose = require("mongoose");

const typeSchema = new mongoose.Schema({
  name: { type: String, enum: ["food", "grocery", "mall"] },
});
module.exports = mongoose.model("type", typeSchema);
