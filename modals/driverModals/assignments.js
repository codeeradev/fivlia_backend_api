const mongoose = require('mongoose');

const assignSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.ObjectId, ref: 'drivers' },
  orderId: { type: String },
  orderStatus:{type:String},
  currentStatus:{type:String,default:null},
  expireAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // expires in 30 days
  }
}, { timestamps: true });

// TTL index for automatic deletion
assignSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
assignSchema.index({ orderId: 1, driverId: 1 });

module.exports = mongoose.model('assignments', assignSchema);
