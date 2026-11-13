const { firebase } = require("googleapis/build/src/apis/firebase");
const mongoose = require("mongoose");

const settingAdminSchema = new mongoose.Schema({
  Owner_Name: { type: String },
  Owner_Email: String,
  Owner_Number: { type: Number },
  links: {
    about_us: { type: String },
    privacy_Policy: String,
    termAndCondition: String,
    seller: String,
  },
  Password: String,
  Platform_Fee: Number,
  Platform_Fee_Fixed: { type: Number, default: 0, min: 0 },
  codLimit: Number,
  GST_Number: String,
  Description: String,
  Delivery_Charges: Number,
  Delivery_Charges_Gst: Number,
  adminSignature: String,
  DeliveryStatus: String,
  foodSellerTaxPercent: String,
  Auth: [
    {
      firebase: { status: Boolean },
      whatsApp: { appKey: String, authKey: String, status: Boolean },
      whatsAppBulk: { apiKey: String, instanceKey: String, status: Boolean },
      bulksms: { api_id: String, api_password: String, status: Boolean },
    },
  ],
  PaymentGateways: {
    RazorPayKey: {
      test: String,
      live: String,
      secretKey: String,
      status: Boolean,
      activeMode: { type: String, enum: ["test", "live"] },
    },
    PhonePe: {
      test: String,
      live: String,
      secretKey: String,
      status: Boolean,
      activeMode: { type: String, enum: ["test", "live"] },
    },
    Cashfree: {
      test: { clientId: String, clientSecret: String },
      live: { clientId: String, clientSecret: String },
      status: { type: Boolean, default: false },
      activeMode: { type: String, enum: ["test", "live"] },
      easySplitEnabled: { type: Boolean, default: false },
    },
  },
  PaymentGatewayStatus: Boolean,
  Map_Api: [
    {
      google: { api_key: String, status: Boolean },
      apple: { api_key: String, status: Boolean },
      ola: { api_key: String, status: Boolean },
    },
  ],
  minPrice: Number,
  maxPrice: Number,
  maxQuantity: Number,
  minWithdrawal: Number,
  freeDeliveryLimit: Number,
  minimumOrderCancelTime: Number,
  extraTime: Number,
  dayStartTime: String,
  dayEndTime: String,
  nightStartTime: String,
  nightEndTime: String,
  zoneTimeZone: String,
  imageLink: String,
  fixDeliveryCharges: Number,
  perKmCharges: Number,
  fixNightDeliveryCharges: Number,
  perKmNightCharges: Number,
  foodGlobalCommission: Number,
  ready_in_min: Number,
  globalDeliveryRules: [{
    _id: false,
    pincode: { type: String, required: true, match: /^[1-9][0-9]{5}$/ },
    shippingCharge: { type: Number, required: true, min: 0 },
    daysMin: { type: Number, required: true, min: 0 },
    daysMax: { type: Number, required: true, min: 0 },
    codAllowed: { type: Boolean, default: false },
  }],
  globalDeliveryDefaults: {
    shippingCharge: { type: Number, min: 0 },
    daysMin: { type: Number, min: 0 },
    daysMax: { type: Number, min: 0 },
    codAllowed: { type: Boolean, default: false },
  },
  // Third party courier platforms used for global order tracking
  shippingPlatforms: [
    {
      name: { type: String, trim: true },
      trackingUrlTemplate: { type: String, trim: true, default: "" },
      status: { type: Boolean, default: true },
    },
  ],
  homeScreen: {
    food: {
      primary_color: String,
      secondary_color: String,
    },
    grocery: {
      primary_color: String,
      secondary_color: String,
    },
    mall: {
      primary_color: String,
      secondary_color: String,
    },
    allCategoryImage: String,
  },
});

module.exports = {
  SettingAdmin: mongoose.model("SettingAdmin", settingAdminSchema),
};
