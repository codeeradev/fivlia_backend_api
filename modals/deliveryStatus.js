const mongoose = require('mongoose');

const deliveryStatusSchema = new mongoose.Schema({
   statusCode:{type:String,default:'100'},
   image:String,
   statusTitle:String,
   status:Boolean,
   serviceScope:{type:String,enum:['both','city','global'],default:'both'},
},{timestamps:true})
module.exports=mongoose.model('deliveryStatus',deliveryStatusSchema)