const mongoose = require("mongoose");

const storeScheema = new mongoose.Schema(
  {
    storeName: String,
    city: {
      _id: { type: mongoose.Schema.ObjectId, ref: "Locations" },
      name: String,
    },
    ownerName: String,
    PhoneNumber: String,
    email: String,
    password: String,
    zone: [
      {
        _id: { type: mongoose.Schema.ObjectId, ref: "Locations" },
        name: String,
        title: String,
        latitude: Number,
        longitude: Number,
        range: Number,
      },
    ],
    Latitude: String,
    Longitude: String,
    status: { type: Boolean, default: false },
    Description: String,
    wallet: Number,
    Authorized_Store: { type: Boolean, default: true },
    Category: [{ type: mongoose.Schema.ObjectId, ref: "Category" }],
    image: String,
    aadharCard: [String],
    panCard: [String],
    sellFood: { type: Boolean },
    // typeId:{type: mongoose.Schema.Types.ObjectId, ref: "type", required: true},
    businessType: { type: String },
    fsiNumber: String,
    gstNumber: String,
    enrollmentId: String,
    invoicePrefix: { type: String },
    fullAddress: String,
    emailVerified: { type: Boolean, default: false },
    phoneNumberVerified: { type: Boolean, default: false },
    approveStatus: {
      type: String,
      enum: [
        "pending_verification",
        "pending_admin_approval",
        "approved",
        "banned",
        "rejected",
      ],
      default: "pending_verification",
    },
    verificationToken: String,
    accessKey:String,
    pendingAddressUpdate: {
      city: {
        _id: { type: mongoose.Schema.ObjectId, ref: "Locations" },
        name: String,
      },
      zone: [
        {
          _id: { type: mongoose.Schema.ObjectId, ref: "Locations" },
          name: String,
          title: String,
          latitude: Number,
          longitude: Number,
          range: Number,
        },
      ],
      Latitude: String,
      Longitude: String,
      requestedAt: { type: Date, default: Date.now },
      status: { type: String, enum: ["pending", "approved", "rejected"] },
    },
    openTime: { type: String },
    closeTime: { type: String },
    bankDetails: {
      bankName: String,
      accountHolder: String,
      accountNumber: Number,
      ifsc: String,
      branch: String,
    },
    advertisementImages: [{ type: String }],
    sellerSignature: { type: String },
    devices: [
      {
        deviceId: { type: String }, // unique device UUID from client
        deviceType: {
          type: String,
          enum: ["mobile", "tablet", "laptop"]
        },
        platform:String,
        deviceName: { type: String }, 
        fcmToken: { type: String },
        jwtToken: { type: String },
        createdAt: { type: Date, default: Date.now },
        lastActiveAt: { type: Date, default: Date.now },
      },
    ],
    fivliaAssured: { type: Boolean, default: false },
    pendingAdvertisementImages: {
      image: [{ type: String }],
      status: { type: String, enum: ["pending", "approved", "rejected"] },
    },
    sellerCategories: [
      {
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
        subCategories: [
          {
            subCategoryId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "SubCategory",
              default: null,
              required: false,
            },
            subSubCategories: [
              {
                subSubCategoryId: {
                  type: mongoose.Schema.Types.ObjectId,
                  ref: "SubSubCategory",
                  default: null,
                  required: false,
                },
              },
            ],
          },
        ],
      },
    ],
    referralCode: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Store", storeScheema);
