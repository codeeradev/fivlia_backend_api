const Store = require("../modals/store");
const seller = require("../modals/sellerModals/seller");
const Stock = require("../modals/StoreStock");
const Products = require("../modals/Product");
const OtpModel = require("../modals/otp");
const { sendVerificationEmail } = require("../config/nodeMailer");
const { otpTemplate } = require("../utils/emailTemplates");
const CategoryModel = require("../modals/category");
const { ZoneData } = require("../modals/cityZone"); // your Locations model
const crypto = require("crypto");
const store_transaction = require("../modals/storeTransaction");
const { SettingAdmin } = require("../modals/setting");
const { sendMessages } = require("../utils/sendMessages");
// const sendVerificationEmail = require("../config/nodeMailer");

exports.storeLogin = async (req, res) => {
  try {
    const { email, PhoneNumber, password, type } = req.body;

    if (type === "seller") {
      const store = await Store.findOne({ $or: [{ email }, { PhoneNumber }] });
      const setting = await SettingAdmin.findOne();
      const authSettings = setting?.Auth?.[0] || {};
      if (!store) {
        return res.status(404).json({ message: "Store not found" });
      }

      if (store.approveStatus === "banned") {
        return res.status(403).json({
          message:
            "Your store is permanently disabled by admin. Please contact admin.",
        });
      }

      if (store.approveStatus !== "approved") {
        return res.status(403).json({
          message:
            "Your store is not approved yet. Please wait for admin approval.",
        });
      }

      let otp = crypto.randomInt(100000, 999999).toString();

      if (email == "demoseller@fivlia.com" || PhoneNumber == "+919888888888") {
        otp = "616161";
      }

      await OtpModel.create({
        email,
        mobileNumber: PhoneNumber,
        otp,
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      if (email) {
        await sendVerificationEmail(
          email,
          "Welcome to Fivlia verify otp for login",
          otpTemplate(otp),
        );
        return res.status(200).json({ message: "OTP sent via to Email" });
      }

      if (PhoneNumber) {
        const message = `Dear Customer Your Fivlia Login OTP code is ${otp}. Valid for 5 minutes. Do not share with others Fivlia - Delivery in Minutes!`;
        await sendMessages(PhoneNumber, message, "1707176060665820902");
      }
      return res.status(200).json({ message: "OTP sent via WhatsApp" });
    }
    const store = await Store.findOne({ email });
    if (!store) {
      return res.status(404).json({ message: "Store not found" });
    }

    if (store.password !== password) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    return res.status(200).json({
      message: "Login successful",
      storeId: store._id,
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.createStore = async (req, res) => {
  try {
    console.log("Incoming body:", req.body);

    let {
      storeName,
      city, // <-- e.g. "683eb89e207e54373548fa4f"
      zone, // <-- e.g. '["683ec5b9bda160427cb853ba","683ec601bda160427cb853bb"]'
      Latitude,
      Longitude,
      ownerName,
      PhoneNumber,
      email,
      password,
      status,
      Description,
      isAssured,
      Category: categoryInput,
    } = req.body;

    //
    // 1️⃣ Parse `Category` string → array
    //
    if (typeof categoryInput === "string") {
      try {
        const parsed = JSON.parse(categoryInput);
        categoryInput = Array.isArray(parsed) ? parsed : [categoryInput];
      } catch {
        categoryInput = [categoryInput];
      }
    }

    //
    // 2️⃣ Parse `zone` string → array
    //
    if (typeof zone === "string") {
      try {
        const parsedZone = JSON.parse(zone);
        zone = Array.isArray(parsedZone) ? parsedZone : [zone];
      } catch {
        zone = [zone];
      }
    }

    //
    // 3️⃣ Resolve `city` → { _id, name }
    //
    const cityDoc = await ZoneData.findById(city).lean();
    if (!cityDoc) {
      return res.status(400).json({ message: `City not found: ${city}` });
    }
    const cityObj = { _id: cityDoc._id, name: cityDoc.city };

    //
    // 4️⃣ Resolve each `zone` ID → { _id, name }
    //
    const zoneObjs = [];
    for (let zones of zone) {
      zones = zones.toString().trim();
      const zdoc = cityDoc.zones.find((z) => z._id.toString() === zones);
      if (zdoc)
        zoneObjs.push({
          _id: zdoc._id,
          name: zdoc.address,
          title: zdoc.zoneTitle,
          latitude: zdoc.latitude,
          longitude: zdoc.longitude,
          range: zdoc.range,
          status: zdoc.status,
        });
    }
    console.log("city", cityObj);
    console.log("zone", zoneObjs);

    //
    // 5️⃣ Category → full list + sub/subsub for product lookup
    //
    categoryInput = categoryInput.map((id) => id.trim());
    const finalCategoryIds = [];
    const allProductCategoryIds = [];

    for (const cid of categoryInput) {
      const cat = await CategoryModel.findById(cid).lean();
      if (!cat) continue;
      finalCategoryIds.push(cat._id);
      allProductCategoryIds.push(cat._id);
      if (cat.subcat?.length) {
        cat.subcat.forEach((sub) => {
          allProductCategoryIds.push(sub._id);
          sub.subsubcat?.forEach((ss) => allProductCategoryIds.push(ss._id));
        });
      }
    }

    //
    // 6️⃣ Image upload
    //
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";

    //
    // 7️⃣ Find matching products
    //
    const products = await Products.find({
      $or: [
        { "category._id": { $in: allProductCategoryIds } },
        { subCategoryId: { $in: allProductCategoryIds } },
        { subSubCategoryId: { $in: allProductCategoryIds } },
      ],
    });
    //
    // 8️⃣ Create store
    //
    const newStore = await Store.create({
      storeName,
      city: cityObj,
      zone: zoneObjs,
      Latitude: parseFloat(Latitude),
      Longitude: parseFloat(Longitude),
      ownerName,
      PhoneNumber,
      email,
      password,
      emailVerified: false, // ⬅️ Add this line
      verificationToken: null,
      status,
      Description,
      Category: finalCategoryIds,
      image,
      products: products.map((p) => p._id),
      fivliaAssured: isAssured,
    });

    return res.status(201).json({
      message: "Store created successfully",
      store: newStore,
      products,
    });
  } catch (err) {
    console.error("Error creating store:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

exports.storeEdit = async (req, res) => {
  try {
    const { storeId } = req.params;
    let updateObj = {};

    const {
      storeName,
      city,
      zone,
      Latitude,
      Longitude,
      gstNumber,
      fsiNumber,
      enrollmentId,
      invoicePrefix,
      ownerName,
      PhoneNumber,
      email,
      password,
      approveStatus,
      status,
      Description,
      openTime,
      closeTime,
      isAssured,
      Category: categoryInput,
    } = req.body;

    // ✅ Store name
    if (storeName) updateObj.storeName = storeName;

    // ✅ City & zone logic only if city is passed
    if (city) {
      const cityDoc = await ZoneData.findById(city).lean();
      if (!cityDoc) return res.status(400).json({ message: "City not found" });

      updateObj.city = { _id: cityDoc._id, name: cityDoc.city };

      if (zone) {
        let zoneArray = typeof zone === "string" ? JSON.parse(zone) : zone;
        const zoneObjs = [];

        for (let z of zoneArray) {
          z = z.toString().trim();
          const zdoc = cityDoc.zones.find(
            (zoneObj) => zoneObj._id.toString() === z,
          );
          if (zdoc) {
            zoneObjs.push({
              _id: zdoc._id,
              name: zdoc.address,
              title: zdoc.zoneTitle,
              latitude: zdoc.latitude,
              longitude: zdoc.longitude,
              range: zdoc.range,
              status: zdoc.status,
            });
          }
        }

        updateObj.zone = zoneObjs;
      }
    }

    // ✅ Latitude & Longitude
    if (Latitude) updateObj.Latitude = parseFloat(Latitude);
    if (Longitude) updateObj.Longitude = parseFloat(Longitude);
    // ✅ Owner info
    if (ownerName) updateObj.ownerName = ownerName;

    // 🛑 Validate duplicate phone number when editing store
    if (
      PhoneNumber !== undefined &&
      PhoneNumber !== "" &&
      PhoneNumber !== "undefined"
    ) {
      let newPhone = PhoneNumber.toString().trim();

      if (!newPhone.startsWith("+91")) {
        newPhone = "+91" + newPhone;
      }

      // 1️⃣ Get current store
      const currentStore = await Store.findById(storeId).lean();
      if (!currentStore) {
        return res.status(404).json({ message: "Store not found" });
      }

      // 2️⃣ If phone is unchanged → allow
      if (currentStore.PhoneNumber === newPhone) {
        updateObj.PhoneNumber = newPhone;
      } else {
        // 3️⃣ If admin is trying to use another store's number → block
        const existingStore = await Store.findOne({
          PhoneNumber: newPhone,
          _id: { $ne: storeId }, // exclude current store
        });

        if (existingStore) {
          return res.status(409).json({
            message: `Phone number ${newPhone} is already used by another store`,
          });
        }

        // 4️⃣ Safe to update
        updateObj.PhoneNumber = newPhone;
      }
    }

    if (email) updateObj.email = email;
    if (password) updateObj.password = password;
    if (openTime) updateObj.openTime = openTime;
    if (closeTime) updateObj.closeTime = closeTime;
    if (status !== undefined) updateObj.status = status;
    if (Description) updateObj.Description = Description;

    updateObj.gstNumber = gstNumber;
    updateObj.fsiNumber = fsiNumber;
    updateObj.enrollmentId = enrollmentId;
    if (invoicePrefix) updateObj.invoicePrefix = invoicePrefix;

    if (approveStatus) updateObj.approveStatus = approveStatus;
    if (isAssured !== undefined) {
      updateObj.fivliaAssured =
        isAssured === true ||
        isAssured === "true" ||
        isAssured === 1 ||
        isAssured === "1";
    }

    // ✅ Category
    if (categoryInput) {
      let catArray =
        typeof categoryInput === "string"
          ? JSON.parse(categoryInput)
          : categoryInput;
      catArray = catArray.map((id) => id.trim());
      const finalCategoryIds = [];

      for (const cid of catArray) {
        const cat = await CategoryModel.findById(cid).lean();
        if (cat) finalCategoryIds.push(cat._id);
      }

      updateObj.Category = finalCategoryIds;
    }

    // ✅ Image
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";

    if (image) updateObj.image = image;

    // ✅ Perform update
    const updatedStore = await Store.findByIdAndUpdate(storeId, updateObj, {
      new: true,
    });

    if (!updatedStore) {
      return res.status(404).json({ message: "Store not found" });
    }

    return res
      .status(200)
      .json({ message: "Store updated", store: updatedStore });
  } catch (error) {
    console.error("Error editing store:", error);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};

exports.getStore = async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      const allStores = await Store.find({ Authorized_Store: true }).lean();
      return res.status(200).json({ stores: allStores });
    }

    const store = await Store.findById(id).lean();
    if (!store) {
      return res.status(404).json({ message: "Store not found" });
    }

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

    const products = await Products.find({
      $or: [
        { "category._id": { $in: allCategoryIds } },
        { subCategoryId: { $in: allCategoryIds } },
        { subSubCategoryId: { $in: allCategoryIds } },
      ],
    }).lean();

    // ✅ Fetch stock doc for this store
    const storeStockDoc = await Stock.findOne({ storeId: id }).lean();
    const stockEntries = storeStockDoc?.stock || [];

    // 🔁 Build a quick lookup map
    const stockMap = {};
    for (const item of stockEntries) {
      const key = `${item.productId}_${item.variantId}`;
      stockMap[key] = item.quantity;
    }

    for (const product of products) {
      product.inventory = [];

      if (Array.isArray(product.variants)) {
        for (const variant of product.variants) {
          const key = `${product._id}_${variant._id}`;

          const stockData = stockEntries.find(
            (item) =>
              item.productId.toString() === product._id.toString() &&
              item.variantId.toString() === variant._id.toString(),
          );

          const quantity = stockData?.quantity || 0;

          if (stockData?.price != null) {
            variant.sell_price = stockData.price;
          }

          if (stockData?.mrp != null) {
            variant.mrp = stockData.mrp;
          }

          // Still add quantity info to inventory
          product.inventory.push({
            variantId: variant._id,
            quantity,
          });
        }
      }
    }

    return res.status(200).json({
      store,
      categories: allCategoryTrees,
      products,
    });
  } catch (err) {
    console.error("Error in getStore:", err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

exports.addCategoryInStore = async (req, res) => {
  try {
    const { id } = req.params;
    const { Category } = req.body;
    const CategoryId = await Store.findByIdAndUpdate(
      id,
      { $addToSet: { Category: Category } },
      { new: true },
    );

    return res.status(200).json({ message: "Category Updated", CategoryId });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occured" });
  }
};

exports.removeCategoryInStore = async (req, res) => {
  try {
    const { id } = req.params;
    const { Category } = req.body;
    const deleted = await Store.findOneAndUpdate(
      { _id: id },
      { $pull: { Category: Category } },
      { new: true },
    );
    res.status(200).json({ message: "Category removed successfuly", deleted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error", error });
  }
};

exports.getStoreTransaction = async (req, res) => {
  try {
    const storeId = req.params;
    const storeData = await store_transaction.find(storeId);
    return res.status(200).json({ message: "Store transactions", storeData });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.getStoreCategory = async (req, res) => {
  try {
    const { storeId, page = 1, limit = 20, type } = req.query;
    const skip = (page - 1) * limit;

    if (type === "seller") {
      const Seller = await seller.findById(storeId);
      console.log("Seller", Seller);
      const category = await CategoryModel.find({
        _id: { $in: Seller.productCategory },
      })
        .skip(skip)
        .limit(Number(limit))
        .lean();
      const count = Seller.productCategory.length;
      return res
        .status(200)
        .json({ message: "Store Category", category, page, limit, count });
    }

    const store = await Store.findById(storeId);

    const category = await CategoryModel.find({ _id: { $in: store.Category } })
      .skip(skip)
      .limit(Number(limit))
      .lean();
    const count = store.Category.length;
    return res
      .status(200)
      .json({ message: "Store Category", category, page, limit, count });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};
