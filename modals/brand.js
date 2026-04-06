const mongoose = require('mongoose');

const brandSchema = new mongoose.Schema({
   brandName:String,
   brandLogo:String,
   brandId:String,
   description:String,
   featured:Boolean,
   typeId:{ type: mongoose.Schema.Types.ObjectId, ref: "type", required: true },
},{timestamps:true})
module.exports=mongoose.model('brand',brandSchema)