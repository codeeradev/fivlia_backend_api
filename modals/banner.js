const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
    image:String,
    title:{type:String,required:true},
    city: [{
          _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Locations' },
          name:String
      }],
  zones: [
    {
      address: { type: String, required: true },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
      range:Number
    }
  ],
    mainCategory: {name:{type:String}, _id:{type:mongoose.Schema.Types.ObjectId,ref:'Categories'},slug:String},
    subCategory:  { name:{type:String}, _id:{type:mongoose.Schema.Types.ObjectId},slug: String},
    subSubCategory: { name:{type:String}, _id:{type:mongoose.Schema.Types.ObjectId},slug: String},
    brand: {name:{type:String}, _id:{type:mongoose.Schema.Types.ObjectId, ref:'brands'},slug: String},
    storeId:{type:mongoose.Schema.Types.ObjectId, ref:'stores'},
    status:{type:Boolean,default:true},
    type:{type:String,enum:['offer','normal'],default:'normal'},
    type2:String,
    typeId:{ type: mongoose.Schema.Types.ObjectId, ref: "type", required: true },
},{timestamps:true})
module.exports=mongoose.model('Banner',bannerSchema)




//   zones: [{type: {type: String,enum: ['Point'],required: true},coordinates: {type: [Number],required: true},    address: {type: String,required: true}}],
