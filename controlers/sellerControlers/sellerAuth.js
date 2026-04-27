const driver = require("../../modals/driver");
const seller = require("../../modals/store");
const sendNotification = require("../../firebase/pushnotification");
const { SettingAdmin } = require("../../modals/setting");
const { ZoneData } = require("../../modals/cityZone");
const { sendVerificationEmail } = require("../../config/nodeMailer");
const OtpModel = require("../../modals/otp");
const crypto = require("crypto");
const { otpTemplate } = require("../../utils/emailTemplates");
const Products = require("../../modals/Product");
const CategoryModel = require("../../modals/category");
const Stock = require("../../modals/StoreStock");
const jwt = require("jsonwebtoken");
const sellerProduct = require("../../modals/sellerModals/sellerProduct");
const store_transaction = require("../../modals/storeTransaction");
const sellerCoupon = require("../../modals/sellerCoupon");
const { requestId } = require("../../config/counter");
const { whatsappOtp } = require("../../config/whatsappsender");
const { sendMessages } = require("../../utils/sendMessages");
const mongoose = require("mongoose");
const { notifyEntity } = require("../../utils/notifyStore");

exports.addSeller = async (req, res) => {
  try {
    const {
      storeName,
      firstName,
      lastName,
      PhoneNumber,
      email,
      city,
      zone,
      enrollmentId,
      gstNumber,
      fsiNumber,
      Latitude,
      Longitude,
      sellFood,
      businessType,
      fullAddress,
      referralCode,
    } = req.body;

    const sellerData = await seller.findOne({
      PhoneNumber,
    });
    const setting = await SettingAdmin.findOne();
    const authSettings = setting?.Auth?.[0] || {};
    const otp = crypto.randomInt(100000, 999999).toString();
    // const otpEmail = crypto.randomInt(100000, 999999).toString();

    if (sellerData) {
      // Check if email matches and is verified
      if (
        (sellerData.email === email && sellerData.emailVerified === true) ||
        (sellerData.PhoneNumber === PhoneNumber &&
          sellerData.phoneNumberVerified === true)
      ) {
        return res
          .status(409)
          .json({ message: "Email or Mobile number already exists" });
      }
      // If email or phone exists but not verified, send OTP
      try {
        const message = `Dear Customer Your Fivlia Registration OTP code is ${otp}. Valid for 5 minutes. Do not share with others Fivlia - Delivery in Minutes!`;

        await sendMessages(PhoneNumber, message, "1707176060659474352");
        await OtpModel.create({
          email,
          mobileNumber: PhoneNumber,
          otp,
          // otpEmail,
          expiresAt: Date.now() + 2 * 60 * 1000,
        });

        // await sendVerificationEmail(
        //   email,
        //   "Welcome to Fivlia – Your store is under verification",
        //   otpTemplate(otpEmail)
        // );
        return res
          .status(200)
          .json({ message: "OTP sent phone for verification" });
      } catch (err) {
        return res
          .status(500)
          .json({ message: "Failed to send OTP", error: err.message });
      }
    }

    //     const rawImagePath = req.files?.image?.[0]?.key || "";
    //     const image = rawImagePath ? `/${rawImagePath}` : "";
    const aadharCard =
      req.files?.aadharCard?.map((file) => `/${file.key}`) || [];
    const panCard = req.files?.panCard?.map((file) => `/${file.key}`) || [];
    const zones = await ZoneData.find({ "zones._id": { $in: zone } });
    const matchedZones = [];
    zones.forEach((doc) => {
      doc.zones.forEach((z) => {
        if (zone.includes(z._id.toString())) {
          matchedZones.push({
            _id: z._id,
            name: z.zoneTitle,
            title: z.zoneTitle,
            range: z.range,
            latitude: z.latitude,
            longitude: z.longitude,
          });
        }
      });
    });
    const cityObj = { _id: zones[0]._id, name: zones[0].city };

    let updatedReferralCode = referralCode;
    if (mongoose.Types.ObjectId.isValid(referralCode)) {
      const driverData = await driver.findById(referralCode);
      if (driverData) {
        updatedReferralCode = driverData.driverId;
      }
    }

    const newSeller = await seller.create({
      storeName,
      ownerName: `${firstName} ${lastName}`,
      Authorized_Store: false,
      PhoneNumber,
      email,
      aadharCard,
      panCard,
      fsiNumber,
      enrollmentId,
      city: cityObj,
      zone: matchedZones,
      gstNumber,
      approveStatus: "pending_verification",
      Latitude,
      Longitude,
      sellFood,
      businessType,
      fullAddress,
      referralCode: updatedReferralCode,
    });

    const message = `Dear Customer Your Fivlia Registration OTP code is ${otp}. Valid for 5 minutes. Do not share with others Fivlia - Delivery in Minutes!`;

    await sendMessages(PhoneNumber, message, "1707176060659474352");
    await OtpModel.create({
      email,
      mobileNumber: PhoneNumber,
      otp,
      // otpEmail,
      expiresAt: Date.now() + 2 * 60 * 1000,
    });

    // await sendVerificationEmail(
    //   email,
    //   "Welcome to Fivlia – Your store is under verification",
    //   otpTemplate(otpEmail)
    // );

    return res.status(200).json({ message: "OTP sent via WhatsApp And Email" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An Error Occured" });
  }
};

exports.sendOtp = async (req, res) => {
  try {
    const { PhoneNumber } = req.body;
    const otp = crypto.randomInt(100000, 999999).toString();

    const message = `Dear Customer Your Fivlia Login OTP code is ${otp}. Valid for 5 minutes. Do not share with others Fivlia - Delivery in Minutes!`;

    await sendMessages(PhoneNumber, message, "1707176060665820902");
    await OtpModel.create({
      email,
      mobileNumber: PhoneNumber,
      otp,
      expiresAt: Date.now() + 2 * 60 * 1000,
    });

    return res.status(200).json({ message: "OTP sent via WhatsApp" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ResponseMsg: "An Error Occured" });
  }
};

exports.getSellerRequest = async (req, res) => {
  try {
    const [
      requests,
      locationRequests,
      imageRequest,
      productRequest,
      brandRequest,
      sellerOfferRequest,
    ] = await Promise.all([
      seller
        .find({ approveStatus: "pending_admin_approval" })
        .sort({ createdAt: -1 }),
      seller
        .find({ "pendingAddressUpdate.status": "pending" })
        .sort({ createdAt: -1 }),
      seller
        .find({
          "pendingAdvertisementImages.status": "pending",
          "pendingAdvertisementImages.image.0": { $exists: true },
        })
        .select(
          "storeName email PhoneNumber ownerName zone pendingAdvertisementImages",
        )
        .sort({ createdAt: -1 }),
      Products.find({ sellerProductStatus: "pending_admin_approval" }).sort({
        createdAt: -1,
      }),
      Products.find({ sellerProductStatus: "submit_brand_approval" }).sort({
        createdAt: -1,
      }),
      sellerCoupon.find({ approvalStatus: "pending" }).sort({
        createdAt: -1,
      }),
    ]);

    return res.status(200).json({
      message: "Seller Approval Requests",
      requests,
      locationRequests,
      imageRequest,
      productRequest,
      brandRequest,
      sellerOfferRequest,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ResponseMsg: "An Error Occured" });
  }
};

exports.getSeller = async (req, res) => {
  try {
    const { id, includeBanned, page = 1, limit } = req.query;
    const skip = (page - 1) * limit;
    // 1️⃣ Return all approved sellers if no ID
    if (!id) {
      let query = { approveStatus: "approved", Authorized_Store: false };

      // If admin requested banned too
      if (includeBanned === "true") {
        query = {
          Authorized_Store: false,
          approveStatus: { $in: ["approved", "banned"] },
        };
      }

      // Aggregate sellers with wallet (store_transaction) data
      const sellers = await seller.aggregate([
        { $match: query },

        {
          $lookup: {
            from: "store_transactions",
            localField: "_id",
            foreignField: "storeId",
            as: "sellerWalletData",
          },
        },

        // Sort transactions inside sellerWalletData (optional)
        {
          $addFields: {
            sellerWalletData: {
              $sortArray: {
                input: "$sellerWalletData",
                sortBy: { createdAt: -1 },
              },
            },
          },
        },
      ]);
      return res.status(200).json({ message: "Sellers Approved", sellers });
    }

    // 2️⃣ Get store info
    const store = await seller.findById(id).lean();
    if (!store) {
      return res.status(404).json({ message: "Store not found" });
    }

    // 3️⃣ Collect all category IDs
    const categoryIds = Array.isArray(store.Category)
      ? store.Category
      : [store.Category];

    const allCategoryTrees = [];
    const allCategoryIds = [];

    for (const catId of categoryIds) {
      const category = await CategoryModel.findById(catId).lean();
      if (!category) continue;

      allCategoryTrees.push(category);
      allCategoryIds.push(category._id.toString());

      (category.subcat || []).forEach((sub) => {
        allCategoryIds.push(sub._id.toString());
        (sub.subsubcat || []).forEach((subsub) => {
          allCategoryIds.push(subsub._id.toString());
        });
      });
    }

    // 4️⃣ Fetch stock document for this store
    const storeStockDoc = await Stock.findOne({ storeId: id }).lean();
    const stockEntries = storeStockDoc?.stock || [];

    // Build a map for quick stock lookup
    const stockMap = {};
    for (const entry of stockEntries) {
      const key = `${entry.productId}_${entry.variantId}`;
      stockMap[key] = entry;
    }

    // 5️⃣ Fetch GLOBAL products and enrich with stock info
    const globalProducts = await Products.find({
      $or: [
        { "category._id": { $in: allCategoryIds } },
        { subCategoryId: { $in: allCategoryIds } },
        { subSubCategoryId: { $in: allCategoryIds } },
      ],
    })
      .skip(skip)
      .limit(limit)
      .lean();

    for (const product of globalProducts) {
      product.inventory = [];

      if (Array.isArray(product.variants)) {
        for (const variant of product.variants) {
          const key = `${product._id}_${variant._id}`;
          const stockData = stockMap[key];

          const quantity = stockData?.quantity || 0;

          if (stockData?.price != null) {
            variant.sell_price = stockData.price;
          }
          if (stockData?.mrp != null) {
            variant.mrp = stockData.mrp;
          }

          product.inventory.push({
            variantId: variant._id,
            quantity,
          });
        }
      }
    }

    // 6️⃣ Fetch SELLER products (use their own stock field)
    const sellerProducts = await sellerProduct
      .find({
        sellerId: id,
      })
      .lean();

    const enrichedSellerProducts = sellerProducts.map((prod) => ({
      ...prod,
      inventory: [
        {
          variantId: null, // sellerProduct has no variants
          quantity: prod.stock || 0,
        },
      ],
    }));

    // 7️⃣ Combine results
    const allProducts = globalProducts;

    return res.status(200).json({
      store,
      sellerAddedProducts: enrichedSellerProducts,
      products: allProducts,
    });
  } catch (err) {
    console.error("Error in getSeller:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

exports.acceptDeclineRequest = async (req, res) => {
  try {
    const {
      type,
      approval,
      id,
      couponId,
      productId,
      isImage,
      isLocation,
      description,
    } = req.body;

    // ---------- PRODUCT APPROVAL ----------
    if (productId) {
      const updateFields = {
        sellerProductStatus: approval,
        brandApprovelDescription: description || "",
        ...(approval === "approved" && { status: true }),
      };

      const productApplication = await Products.findByIdAndUpdate(
        productId,
        updateFields,
        { new: true },
      );
      if (approval === "approved") {
        let storeStock = await Stock.findOne({
          storeId: productApplication.addedBy,
        });
        if (!Array.isArray(storeStock.stock)) {
          storeStock.stock = [];
        }
        for (const variant of productApplication.variants) {
          const exists = storeStock.stock.find(
            (s) =>
              s.productId.toString() === productApplication._id.toString() &&
              s.variantId.toString() === variant._id.toString(),
          );

          if (!exists) {
            storeStock.stock.push({
              productId: productApplication._id,
              variantId: variant._id,
              quantity: 0,
              price: variant.sell_price || 0,
              mrp: variant.mrp || 0,
            });
          }
        }
        await storeStock.save();
      }

      const sellerDoc = await seller.findById(productApplication.sellerId);
      if (sellerDoc) {
        await notifyEntity(
          sellerDoc,
          `Product ${approval}`,
          `Your product application has been ${approval}.`,
        );
      }

      return res.status(200).json({
        message: `Product application ${approval}`,
        productApplication,
      });
    }

    if (couponId) {
      const updatedCoupon = await sellerCoupon.findByIdAndUpdate(
        couponId,
        { approvalStatus: approval },
        {
          new: true,
        },
      );
      return res
        .status(200)
        .json({ message: `Offer request ${approval}`, updatedCoupon });
    }
    // ---------- LOCATION UPDATE ----------
    if (isLocation) {
      const sellerDoc = await seller.findById(id);
      if (!sellerDoc)
        return res.status(404).json({ message: "Seller not found" });

      let updatedData;

      if (approval === "approved") {
        await seller.findByIdAndUpdate(id, {
          $set: {
            city: sellerDoc.pendingAddressUpdate.city,
            zone: sellerDoc.pendingAddressUpdate.zone,
            location: sellerDoc.pendingAddressUpdate.location,
          },
        });

        updatedData = await seller.findByIdAndUpdate(
          id,
          { $unset: { pendingAddressUpdate: "" } },
          { new: true },
        );

        await notifyEntity(
          sellerDoc,
          `Location Update Approved`,
          `Your location update request has been approved.`,
        );
      } else {
        updatedData = await seller.findByIdAndUpdate(
          id,
          { "pendingAddressUpdate.status": "rejected" },
          { new: true },
        );

        await notifyEntity(
          sellerDoc,
          `Location Update Rejected`,
          `Your location update request has been rejected.`,
        );
      }

      return res.status(200).json({
        success: true,
        type: "location",
        message: `Location update ${approval}`,
        data: updatedData,
      });
    }

    // ---------- IMAGE UPDATE ----------
    if (isImage) {
      const sellerDoc = await seller.findById(id);
      if (!sellerDoc)
        return res.status(404).json({ message: "Seller not found" });

      let updatedData;

      if (approval === "approved") {
        const pendingImages = sellerDoc.pendingAdvertisementImages?.image || [];

        await seller.findByIdAndUpdate(id, {
          $set: {
            advertisementImages: pendingImages.filter(
              (img) => img && img !== "",
            ),
          },
          $unset: { pendingAdvertisementImages: "" },
        });

        updatedData = await seller.findById(id); // Get latest version

        await notifyEntity(
          sellerDoc,
          `Advertisement Images Approved`,
          `Your advertisement images update has been approved.`,
        );
      } else {
        updatedData = await seller.findByIdAndUpdate(
          id,
          { "pendingAdvertisementImages.status": "rejected" },
          { new: true },
        );

        await notifyEntity(
          sellerDoc,
          `Advertisement Images Rejected`,
          `Your advertisement images update has been rejected.`,
          "/Profile",
        );
      }

      return res.status(200).json({
        success: true,
        type: "image",
        message: `Image update ${approval}`,
        data: updatedData,
      });
    }

    if (type === "driver") {
      const application = await driver.findByIdAndUpdate(
        id,
        { approveStatus: approval },
        { new: true },
      );

      const sellerDoc = await driver.findById(id);
      if (sellerDoc) {
        await notifyEntity(
          sellerDoc,
          `Driver Application ${approval}`,
          `Your Driver application has been ${approval}.`,
        );
      }

      return res
        .status(200)
        .json({ message: `Driver application ${approval}`, application });
    }
    // ---------- SELLER APPLICATION APPROVAL ----------
    const application = await seller.findByIdAndUpdate(
      id,
      { approveStatus: approval },
      { new: true },
    );

    const sellerDoc = await seller.findById(id);
    if (sellerDoc) {
      await notifyEntity(
        sellerDoc,
        `Seller Application ${approval}`,
        `Your seller application has been ${approval}.`,
      );
    }

    return res
      .status(200)
      .json({ message: `Seller application ${approval}`, application });
  } catch (error) {
    console.error("❌ Error in acceptDeclineRequest:", error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.verifyOtpSeller = async (req, res) => {
  try {
    const {
      email,
      PhoneNumber,
      otp,
      type,
      storeId,
      accessKey,
      token,
      deviceId,
      deviceName,
      platform,
      deviceType, // mobile | tablet | browser
    } = req.body;
    if (type === "admin") {
      const store = await seller.findById(storeId);

      if (!store) {
        return res.status(404).json({ message: "Store not found" });
      }

      // Check access key
      if (store.accessKey !== accessKey) {
        return res.status(403).json({ message: "Invalid Key" });
      }

      // Generate JWT for admin session
      const jwttoken = jwt.sign(
        { _id: store._id, role: "admin" },
        process.env.jwtSecretKey,
        { expiresIn: "1d" },
      );

      // Clear key after use
      store.accessKey = null;
      await store.save();
      return res.status(200).json({
        message: "✅ Admin login successful",
        sellerId: store._id,
        storeName: store.storeName,
        token: jwttoken,
        activeDevices:
          store.devices?.map((d) => ({
            deviceId: d.deviceId,
            deviceType: d.deviceType,
            createdAt: d.createdAt,
          })) || [],
      });
    }

    // if (!PhoneNumber) {
    //   return res.status(400).json({ message: "Mobile number is required" });
    // }
    // ======================= LOGIN FLOW =======================
    if (type === "login") {
      // if (!deviceId || !deviceType) {
      //   return res
      //     .status(400)
      //     .json({ message: "Device information is required" });
      // }

      const sellerDoc = await seller.findOne({
        $or: [{ PhoneNumber }, { email }],
      });

      if (!sellerDoc) {
        return res.status(404).json({ message: "Seller not found" });
      }

      const otpRecord = await OtpModel.findOne({
        $or: [{ mobileNumber: PhoneNumber }, { email }],
        otp,
      });

      if (!otpRecord) {
        return res.status(400).json({ message: "Invalid OTP" });
      }

      // Generate JWT
      const jwttoken = jwt.sign(
        { _id: sellerDoc._id },
        process.env.jwtSecretKey,
        { expiresIn: "1d" },
      );

      // Initialize devices array if not exist
      if (!sellerDoc.devices) sellerDoc.devices = [];

      // --- STEP 1: Check if this device already exists ---
      const existingDeviceIndex = sellerDoc.devices.findIndex(
        (d) => d.deviceId === deviceId,
      );

      if (existingDeviceIndex !== -1) {
        // Same device: update token and time
        if (token) {
          sellerDoc.devices[existingDeviceIndex].fcmToken = token;
        }
        sellerDoc.devices[existingDeviceIndex].jwtToken = jwttoken;
        sellerDoc.devices[existingDeviceIndex].lastActiveAt = new Date();
      } else {
        // --- STEP 2: Enforce device limits ---
        const mobileDevices = sellerDoc.devices.filter(
          (d) => d.deviceType === "mobile",
        );
        const browserDevices = sellerDoc.devices.filter(
          (d) => d.deviceType === "laptop",
        );

        // Limit: 2 mobiles
        if (deviceType === "mobile" && mobileDevices.length >= 2) {
          return res.status(403).json({
            message:
              "You can only log in from 2 mobile devices at a time. Please log out from another phone first.",
            sellerId: sellerDoc._id,
          });
        }

        if (deviceType === "laptop" && browserDevices.length >= 1) {
          return res.status(403).json({
            message:
              "You can only log in from 1 browser at a time. Please log out from your other browser session first.",
            sellerId: sellerDoc._id,
          });
        }

        if (sellerDoc.devices.length >= 3) {
          return res.status(403).json({
            message:
              "You have reached the maximum of 3 active devices. Please log out from one device before logging in again.",
            sellerId: sellerDoc._id,
          });
        }

        // --- STEP 3: Add new device ---
        const newDevice = {
          deviceId,
          deviceType,
          deviceName,
          platform,
          jwtToken: jwttoken,
          fcmToken: token,
          createdAt: new Date(),
          lastActiveAt: new Date(),
        };

        if (token) {
          newDevice.fcmToken = token; // only add if not null
        }

        sellerDoc.devices.push(newDevice);
      }

      // Save
      await sellerDoc.save();
      await OtpModel.deleteOne({ _id: otpRecord._id });

      return res.status(200).json({
        message: "Login successful",
        sellerId: sellerDoc._id,
        storeName: sellerDoc.storeName,
        token: jwttoken,
        activeDevices: sellerDoc.devices.map((d) => ({
          deviceId: d.deviceId,
          deviceType: d.deviceType,
          deviceName,
          platform,
          createdAt: d.createdAt,
        })),
      });
    }

    // ======================= VERIFICATION FLOW =======================
    const otpRecord = await OtpModel.findOne({
      mobileNumber: PhoneNumber,
      otp,
    });

    if (!otpRecord) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const sellerDoc = await seller.findOne({ PhoneNumber });
    if (!sellerDoc) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const updates = {};
    if (PhoneNumber) {
      if (otp !== otpRecord.otp) {
        return res.status(400).json({ message: "Invalid mobile OTP" });
      }
      updates.phoneNumberVerified = true;
      otpRecord.otp = null;
    }

    const isMobileVerified =
      updates.phoneNumberVerified === true ||
      sellerDoc.phoneNumberVerified === true;

    const isEmailVerified =
      updates.emailVerified === true || sellerDoc.emailVerified === true;

    if (isMobileVerified) {
      updates.approveStatus = "pending_admin_approval";
    }

    await seller.updateOne({ _id: sellerDoc._id }, { $set: updates });

    if (!otpRecord.otp || !otpRecord.otpEmail) {
      await OtpModel.deleteOne({ _id: otpRecord._id });
    } else {
      await otpRecord.save();
    }

    return res.status(200).json({
      message: "Verification successful",
      status: updates.approveStatus || sellerDoc.approveStatus,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.editSellerProfile = async (req, res) => {
  try {
    const {
      storeName,
      city,
      zone,
      Latitude,
      Longitude,
      ownerName,
      gstNumber,
      fsiNumber,
      enrollmentId,
      PhoneNumber,
      email,
      invoicePrefix,
      password,
      bankDetails,
      openTime,
      status,
      closeTime,
      // {bankName, accountHolder, accountNumber, ifsc, branch}
    } = req.body;

    const sellerId = req.params.id;

    const updateFields = {};

    if (storeName) updateFields.storeName = storeName;
    if (ownerName) updateFields.ownerName = ownerName;
    if (email) updateFields.email = email;
    if (invoicePrefix) {
      // Check if the prefix is already used by another seller
      const existingPrefix = await seller.findOne({
        invoicePrefix,
        _id: { $ne: sellerId }, // exclude current seller
      });
      if (existingPrefix) {
        return res.status(400).json({
          success: false,
          message:
            "Invoice prefix already in use. Please choose a unique prefix.",
        });
      }
      updateFields.invoicePrefix = invoicePrefix;
    }

    if (req.files?.image?.[0]) {
      updateFields.image = `/${req.files.image?.[0].key}`;
    }
    if (req.files?.file?.[0]) {
      updateFields.sellerSignature = `/${req.files.file?.[0].key}`;
    }
    if (req.files?.MultipleImage?.length > 0) {
      updateFields.pendingAdvertisementImages = {
        image: req.files.MultipleImage.map((file) => `/${file.key}`),
        status: "pending",
      };
    }

    if (PhoneNumber) updateFields.PhoneNumber = PhoneNumber;
    if (gstNumber) updateFields.gstNumber = gstNumber;
    if (fsiNumber) updateFields.fsiNumber = fsiNumber;
    if (enrollmentId) updateFields.enrollmentId = enrollmentId;
    if (password) updateFields.password = password;
    if (openTime) updateFields.openTime = openTime;
    if (closeTime) updateFields.closeTime = closeTime;
    if (status !== undefined) updateFields.status = status;
    if (bankDetails) {
      // Parse bankDetails if it comes as JSON string (from form-data)
      let parsedBankDetails = bankDetails;
      if (typeof bankDetails === "string") {
        try {
          parsedBankDetails = JSON.parse(bankDetails);
        } catch (err) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid bankDetails format" });
        }
      }

      // Validate fields before saving
      const { bankName, accountHolder, accountNumber, ifsc, branch } =
        parsedBankDetails;
      updateFields.bankDetails = {
        ...(bankName && { bankName }),
        ...(accountHolder && { accountHolder }),
        ...(accountNumber && { accountNumber }),
        ...(ifsc && { ifsc }),
        ...(branch && { branch }),
      };
    }
    // Do not overwrite live city/zone/lat/lng -> store in pendingAddressUpdate
    if (city || zone || Latitude || Longitude) {
      // Fetch city object
      let cityObj = null;
      if (city) {
        const cityDoc = await ZoneData.findById(city);
        if (cityDoc) {
          cityObj = { _id: cityDoc._id, name: cityDoc.city };
        }
      }

      let zoneArray = [];
      if (zone) {
        const cityDoc = await ZoneData.findOne({ "zones._id": zone });
        if (cityDoc) {
          const zoneDoc = cityDoc.zones.find(
            (z) => String(z._id) === String(zone),
          );
          if (zoneDoc) {
            zoneArray.push({
              _id: zoneDoc._id,
              name: cityDoc.city,
              title: zoneDoc.zoneTitle,
              latitude: zoneDoc.latitude,
              longitude: zoneDoc.longitude,
              range: zoneDoc.range,
            });
          }
        }
      }

      updateFields.pendingAddressUpdate = {
        ...(cityObj && { city: cityObj }),
        ...(zoneArray.length > 0 && { zone: zoneArray }),
        ...(Latitude && { Latitude }),
        ...(Longitude && { Longitude }),
        requestedAt: new Date(),
        status: "pending",
      };
    }

    const updatedSeller = await seller.findByIdAndUpdate(
      sellerId,
      { $set: updateFields },
      { new: true },
    );

    if (!updatedSeller) {
      return res
        .status(404)
        .json({ success: false, message: "Seller not updated or not found" });
    }

    return res.status(200).json({
      success: true,
      message:
        "Seller profile updated successfully (pending address approval if changed)",
      seller: updatedSeller,
    });
  } catch (error) {
    console.error("editSellerProfile error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

exports.sellerWithdrawalRequest = async (req, res) => {
  try {
    const { storeId, amount } = req.body;
    const storeData = await seller.findById(storeId);
    if (!storeData)
      return res.status(204).json({ message: "Seller not found" });

    // if (storeData.emailVerified === false) {
    //   return res.status(400).json({
    //     message: `Email verification required. Please verify your registered email address before making a withdrawal.`,
    //   });
    // }
    
    const settings = await SettingAdmin.findOne();
    const minWithdrawal = settings?.minWithdrawal || 0;
    if (amount < minWithdrawal) {
      return res
        .status(400)
        .json({ message: `Minimum withdrawal amount is ₹${minWithdrawal}` });
    }
    let request = await requestId(true);
    const pendingWithdrawals = await store_transaction.aggregate([
      { $match: { storeId: storeData._id, status: "Pending", type: "debit" } },
      { $group: { _id: null, totalPending: { $sum: "$amount" } } },
    ]);

    const totalPending = pendingWithdrawals[0]?.totalPending || 0;

    // Check if requested amount + pending exceeds wallet
    if (amount + totalPending > storeData.wallet) {
      return res.status(400).json({
        message: "Insufficient wallet balance considering pending withdrawals",
      });
    }

    // Check if a pending withdrawal already exists
    let withdrawal = await store_transaction.findOne({
      storeId: storeData._id,
      status: "Pending",
      type: "debit",
    });

    if (withdrawal) {
      // Update existing pending request
      withdrawal.amount += amount;
      withdrawal.description = `Withdrawal request of ₹${withdrawal.amount} by seller`;
      await withdrawal.save();
    } else {
      // Create new withdrawal request
      withdrawal = await store_transaction.create({
        requestId: request,
        storeId: storeData._id,
        amount,
        currentAmount: storeData.wallet,
        type: "debit",
        description: `Withdrawal request of ₹${amount} by seller`,
        status: "Pending",
      });
    }

    return res.status(200).json({
      message: "Withdrawal request submitted successfully",
      wallet: storeData.wallet,
      pendingWithdrawal: withdrawal,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.getAllStore = async (req, res) => {
  try {
    const stores = await seller.find().select("storeName _id city");

    // Return success response
    return res.status(200).json({
      success: true,
      count: stores.length,
      stores,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

exports.logoutSeller = async (req, res) => {
  try {
    const { sellerId, deviceId } = req.body;
    if (!sellerId) {
      return res.status(400).json({ message: "Seller ID is required" });
    }

    const sellerDoc = await seller.findById(sellerId);
    if (!sellerDoc) {
      return res.status(204).json({ message: "Seller not found" });
    }

    // ✅ Logout from one specific device
    if (!deviceId) {
      return res.status(400).json({
        message: "Device ID is required for single-device logout",
      });
    }

    const beforeCount = sellerDoc.devices.length;
    sellerDoc.devices = sellerDoc.devices.filter(
      (d) => d.deviceId !== deviceId,
    );
    const afterCount = sellerDoc.devices.length;
    if (beforeCount === afterCount) {
      return res.status(204).json({
        message: "No device found with the given deviceId",
      });
    }

    await sellerDoc.save();
    console.log(`id's`, sellerId, deviceId);
    console.log("succeed");
    return res.status(200).json({
      message: "Logout successful",
      remainingDevices: sellerDoc.devices.map((d) => ({
        deviceId: d.deviceId,
        deviceType: d.deviceType,
      })),
    });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({
      message: "Server error during logout",
      error: error.message,
    });
  }
};

exports.createSellerCoupon = async (req, res) => {
  try {
    const { storeId, offer, title, limit, fromTo, validDays } = req.body;

    const image = `/${req.files.image?.[0].key}`;

    const sliderImage = `/${req.files.file?.[0].key}`;

    const startDate = new Date(fromTo);

    const expireDate = new Date(startDate);
    expireDate.setDate(startDate.getDate() + Number(validDays));

    const newOffer = await sellerCoupon.create({
      storeId,
      offer,
      image,
      sliderImage,
      title,
      limit,
      fromTo,
      validDays,
      expireDate,
    });
    return res.status(200).json({ message: "New coupon created", newOffer });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getCoupons = async (req, res) => {
  try {
    const { storeId } = req.params;
    const coupons = await sellerCoupon
      .find({ storeId })
      .sort({ createdAt: -1 });
    return res.status(200).json({ message: "New coupon created", coupons });
  } catch (error) {
    cosnole.error(error);
    return res.status(200).json({ message: "Server error" });
  }
};

exports.editSellerCoupon = async (req, res) => {
  try {
    const { couponId } = req.params;
    const { title, offer, limit, fromTo, validDays, status } = req.body;

    if (!couponId) {
      return res.status(400).json({ message: "Coupon ID is required" });
    }

    const existingCoupon = await sellerCoupon.findById(couponId);
    if (!existingCoupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }

    const updateData = {};
    let needsReApproval = false;

    if (title !== undefined) {
      updateData.title = title;
      needsReApproval = true;
    }

    if (offer !== undefined) {
      if (Number(offer) <= 0 || Number(offer) > 100) {
        return res.status(400).json({ message: "Offer must be 1–100%" });
      }
      updateData.offer = Number(offer);
      needsReApproval = true;
    }

    if (limit !== undefined) {
      if (Number(limit) <= 0) {
        return res
          .status(400)
          .json({ message: "Limit must be greater than zero" });
      }
      updateData.limit = Number(limit);
      needsReApproval = true;
    }

    let newFromDate = existingCoupon.fromTo;
    let newValidDays = existingCoupon.validDays;

    if (fromTo !== undefined) {
      const parsed = new Date(fromTo);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "Invalid from date" });
      }
      newFromDate = parsed;
      updateData.fromTo = parsed;
      needsReApproval = true;
    }

    if (validDays !== undefined) {
      if (Number(validDays) <= 0) {
        return res.status(400).json({ message: "Valid days must be positive" });
      }
      newValidDays = Number(validDays);
      updateData.validDays = Number(validDays);
      needsReApproval = true;
    }

    // 🔥 recalc expiry exactly like create API
    if (fromTo !== undefined || validDays !== undefined) {
      const newExpire = new Date(newFromDate);
      newExpire.setDate(newExpire.getDate() + Number(newValidDays));
      updateData.expireDate = newExpire;
    }

    // status toggle doesn't trigger approval
    if (status !== undefined) {
      if (typeof status !== "boolean") {
        return res.status(400).json({ message: "Status must be boolean" });
      }
      updateData.status = status;
    }

    if (req.files?.image?.[0]) {
      updateData.images = `/${req.files.image[0].key}`;
      needsReApproval = true;
    }

    if (needsReApproval) {
      updateData.approvalStatus = "pending";
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const updatedCoupon = await sellerCoupon.findByIdAndUpdate(
      couponId,
      updateData,
      { new: true, runValidators: true },
    );

    res.status(200).json({
      message: "Coupon updated successfully",
      coupon: updatedCoupon,
    });
  } catch (error) {
    console.error("Edit Coupon Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    await sellerCoupon.findByIdAndDelete(id);
    return res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    console.error("Edit Coupon Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateToken = async (req, res) => {
  try {
    const {sellerId} = req.params;
    const { deviceId, token } = req.body;

    console.log("req.body of update token", req.body);
    const tokenUpdate = await seller.findOneAndUpdate(
      { _id: sellerId, "devices.deviceId": deviceId },
      {
        $set: {
          "devices.$.fcmToken": token,
        },
      },
      { new: true },
    );
    return res.status(200).json({
      success: true,
      message: "Token updated successfully",
      data: tokenUpdate,
    });
  } catch (error) {
    console.error("Update Token Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
// https://api.fivlia.in/getSellerProducts?categories=683eeb6ff6f5264ba0295760%683ed131f6f5264ba0295759&subCategories=683ef865f6f5264ba0295774%683ed131f6f5264ba0295755&subsubCategories=683ef865f6f5264ba0295724%683ed131f6f5264ba0295715
