const mongoose = require("mongoose");
const {
  getNextCategoryId,
  getNextSubCategoryId,
  getNextSubbCategoryId,
  getNextBrandId,
} = require("../config/counter");
const Category = require("../modals/category");
const Banner = require("../modals/banner");
const Store = require("../modals/store");
const Filter = require("../modals/filter");
const brand = require("../modals/brand");
const {
  getBannersWithinRadius,
  getStoresWithinRadius,
} = require("../config/google");
const Attribute = require("../modals/attribute");
const Products = require("../modals/Product");
const User = require("../modals/User");
const Stock = require("../modals/StoreStock");
const Filters = require("../modals/filter");
const slugify = require("slugify");
const { CityData, ZoneData } = require("../modals/cityZone");
const Coupon = require("../modals/sellerCoupon");

exports.update = async (req, res) => {
  try {
    const { name, description, subcat } = req.body;

    let updateData = {};

    if (name) updateData.name = nameJ;
    if (description) updateData.description = description;
    if (subcat) updateData.subcat = JSON.parse(subcat);

    if (req.files?.file?.[0]?.path) {
      updateData.file = req.files.file[0].path;
    }
    // console.log("req.files:", req.files);
    const updatedCategory = await Category.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true },
    );

    if (!updatedCategory) {
      return res.status(404).json({ message: "Category not found" });
    }
    // console.log("updateData:", updatedCategory);

    return res.json(updatedCategory);
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred while updating the category" });
  }
};

exports.banner = async (req, res) => {
  try {
    let {
      title,
      type,
      city,
      zones,
      mainCategory,
      subCategory,
      subSubCategory,
      brand: brandId,
      status,
      type2,
      storeId,
    } = req.body;
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";

    if (typeof zones === "string") {
      try {
        zones = JSON.parse(zones);
      } catch (err) {
        console.error(err);
        return res.status(400).json({ message: "Invalid zones format" });
      }
    }

    const validTypes = ["normal", "offer"];
    const bannerType = validTypes.includes(type) ? type : "normal";
    if (!bannerType) {
      return res
        .status(402)
        .json({ message: 'Invalid banner type. Must be "normal" or "offer".' });
    }

    if (typeof city === "string") {
      try {
        city = JSON.parse(city);
      } catch (err) {
        return res.status(400).json({ message: "Invalid city format" });
      }
    }

    let cityIds = Array.isArray(city) ? city : [city];

    const cityDoc = await ZoneData.find({ _id: { $in: cityIds } });
    // console.log(cityDoc);

    let foundCategory = null;
    let foundSubCategory = null;
    let foundSubSubCategory = null;
    let foundBrand = null;
    let foundStore = null;

    if (type2 === "Brand") {
      foundBrand = await brand.findOne({ _id: brandId });
      if (!foundBrand)
        return res.status(204).json({ message: "Brand not found" });
    } else if (type2 === "Store") {
      foundStore = await Store.findOne({ _id: storeId });
      if (!foundStore)
        return res.status(204).json({ message: "Store not found" });
    } else if (type2 === "NO") {
      // No category, no brand, no store
      foundCategory = null;
      foundSubCategory = null;
      foundSubSubCategory = null;
      foundBrand = null;
      foundStore = null;
    } else {
      if (!mainCategory)
        return res.status(400).json({ message: "Main category is required" });

      foundCategory = await Category.findOne({ _id: mainCategory });
      if (!foundCategory)
        return res
          .status(204)
          .json({ message: `Category ${mainCategory} not found` });

      if (subCategory) {
        foundSubCategory = foundCategory.subcat.find(
          (sub) => sub._id.toString() === subCategory,
        );
        if (!foundSubCategory)
          return res
            .status(204)
            .json({ message: `SubCategory ${subCategory} not found` });

        if (subSubCategory) {
          foundSubSubCategory = foundSubCategory.subsubcat.find(
            (subsub) => subsub._id.toString() === subSubCategory,
          );
          if (!foundSubSubCategory)
            return res
              .status(204)
              .json({ message: `SubSubCategory ${subSubCategory} not found` });
        }
      } else if (subSubCategory) {
        return res.status(400).json({
          message: "Cannot provide subSubCategory without subCategory",
        });
      }
    }

    let slug = "";
    if (foundCategory) {
      slug = `/category/${foundCategory._id}`;
      if (foundSubCategory) slug += `/${foundSubCategory._id}`;
      if (foundSubSubCategory) slug += `/${foundSubSubCategory._id}`;
    }
    const cities = cityDoc.map((c) => ({ _id: c._id, name: c.city }));

    const newBanner = await Banner.create({
      image,
      type2,
      city: cities,
      title,
      type: bannerType,

      mainCategory: foundCategory
        ? {
            _id: foundCategory._id,
            name: foundCategory.name,
            slug: slugify(foundCategory.name, { lower: true }),
          }
        : null,

      subCategory: foundSubCategory
        ? {
            _id: foundSubCategory._id,
            name: foundSubCategory.name,
            slug: slugify(foundSubCategory.name, { lower: true }),
          }
        : null,

      subSubCategory: foundSubSubCategory
        ? {
            _id: foundSubSubCategory._id,
            name: foundSubSubCategory.name,
            slug: slugify(foundSubSubCategory.name, { lower: true }),
          }
        : null,

      brand: foundBrand
        ? {
            _id: foundBrand._id,
            name: foundBrand.brandName,
            slug: slugify(foundBrand.brandName, { lower: true }),
          }
        : null,

      status,
      storeId,
      zones,
    });
    return res
      .status(200)
      .json({ message: "Banner Added Successfully", newBanner });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An Error Occured", error: error.message });
  }
};

exports.getBanner = async (req, res) => {
  try {
    const { type } = req.query;
    const userId = req.user;

    const user = await User.findById(userId).lean();
    if (!user || !user.location?.latitude || !user.location?.longitude) {
      // console.log("❌ User location missing or incomplete");
      return res.status(400).json({ message: "User location not found" });
    }

    const userLat = user.location.latitude;
    const userLng = user.location.longitude;

    // 🟢 Get active city names
    const activeCities = await CityData.find({ status: true }, "city").lean();
    const activeCityNames = activeCities.map((c) => c.city?.toLowerCase());

    // 🟢 Get active zone IDs
    const zoneDocs = await ZoneData.find({ status: true }, "zones").lean();
    const activeZoneIds = [];
    zoneDocs.forEach((doc) => {
      (doc.zones || []).forEach((zone) => {
        if (zone.status && zone._id) {
          activeZoneIds.push(zone._id.toString());
        }
      });
    });
    // console.log("📍 Active Zone IDs:", activeZoneIds);

    // 🔎 Apply base filters
    const filters = { status: true };
    if (type) {
      const validTypes = ["offer", "normal"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({
          message: 'Invalid banner type. Must be "offer" or "normal".',
        });
      }
      filters.type = type;
    }

    if (req.categoryIds?.length) {
      filters["mainCategory._id"] = {
        $in: req.categoryIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    const allBanners = await Banner.find(filters)
      .lean()
      .sort({ createdAt: -1 });
    const matchedBanners = await getBannersWithinRadius(
      userLat,
      userLng,
      allBanners,
    );
    // console.log(matchedBanners)
    // console.log("🎯 All banners fetched:", allBanners.length);

    let finalBanners = [...matchedBanners];

    // 🔥 ADD SELLER OFFERS ONLY FOR OFFER TYPE

    const now = new Date();

    // 1️⃣ Get nearby & open stores
    const storeResult = await getStoresWithinRadius(userLat, userLng);
    if (storeResult?.matchedStores?.length) {
      const nearbyStoreIds = storeResult.matchedStores.map((s) => s._id);

      // 2️⃣ Get valid seller coupons
      const sellerCoupons = await Coupon.aggregate([
        {
          $match: {
            storeId: { $in: nearbyStoreIds },
            status: true,
            approvalStatus: "approved",
            fromTo: { $lte: now },
            expireDate: { $gte: now },
          },
        },
        { $sort: { createdAt: -1 } }, // 🔑 latest first
        {
          $group: {
            _id: "$storeId", // one per seller
            coupon: { $first: "$$ROOT" },
          },
        },
        { $replaceRoot: { newRoot: "$coupon" } },
      ]);

      // 3️⃣ Normalize seller coupons → banner shape
      const sellerOfferBanners = sellerCoupons.map((c) => ({
        _id: c._id,
        image: c.image,
        title: c.title,
        storeId: c.storeId,
        offer: Number(c.offer),
        type: "offer",
        type2: "Store",
        source: "seller", // 🔑 important for frontend
        createdAt: c.createdAt,
      }));

      // 4️⃣ Tag admin banners
      finalBanners = finalBanners.map((b) => ({
        ...b,
        source: "admin",
      }));

      // 5️⃣ Merge seller + admin
      finalBanners = [...sellerOfferBanners, ...finalBanners];
    }

    if (!finalBanners.length) {
      return res.status(200).json({
        message: "No banners found for your location.",
        count: 0,
        data: [],
      });
    }

    return res.status(200).json({
      message: "Banners fetched successfully.",
      count: finalBanners.length,
      data: finalBanners,
    });
  } catch (error) {
    console.error("❌ Error fetching banners:", error);
    return res.status(500).json({
      message: "An error occurred while fetching banners.",
      error: error.message,
      count: 0,
      data: [],
    });
  }
};

exports.updateBannerStatus = async (req, res) => {
  try {
    let { id } = req.params;
    let {
      status,
      title,
      city,
      zones,
      type2,
      address,
      latitude,
      longitude,
      mainCategory,
      subCategory,
      subSubCategory,
      range,
      brand: brandId,
      storeId,
    } = req.body;

    const rawImagePath = req.files?.image?.[0]?.key;
    const image = rawImagePath ? `/${rawImagePath}` : "";

    const updateData = { status, title, type2 };

    if (rawImagePath) updateData.image = image;

    // Handle city
    if (typeof city === "string") {
      try {
        city = JSON.parse(city);
      } catch (err) {
        console.log(err);
        return res.status(400).json({ message: "Invalid city format" });
      }
    }

    let cityIds = Array.isArray(city) ? city : [city];

    const cityDoc = await ZoneData.find({ _id: { $in: cityIds } });
    if (cityDoc) {
      updateData.city = cityDoc.map((c) => ({ _id: c._id, name: c.city }));
    }

    if (type2 === "NO") {
      updateData.mainCategory = null;
      updateData.subCategory = null;
      updateData.subSubCategory = null;
      updateData.brand = null;
      updateData.storeId = null;
    }

    if (brandId) {
      const foundBrand = await brand.findById(brandId).lean();
      if (!foundBrand)
        return res.status(204).json({ message: `Brand ${brandId} not found` });
      updateData.brand = {
        _id: foundBrand._id,
        name: foundBrand.brandName,
        slug: slugify(foundBrand.brandName, { lower: true }),
      };
    }

    if (storeId) {
      const foundStore = await Store.findById(storeId).lean();
      if (!foundStore)
        return res.status(204).json({ message: `Store ${storeId} not found` });
      updateData.storeId = foundStore._id;
    }

    if (mainCategory) {
      const foundCategory = await Category.findById(mainCategory).lean();
      if (!foundCategory) {
        return res
          .status(404)
          .json({ message: `Category ${mainCategory} not found` });
      }
      updateData.mainCategory = {
        _id: foundCategory._id,
        name: foundCategory.name,
        slug: slugify(foundCategory.name, { lower: true }),
      };

      if (subCategory) {
        const foundSubCategory = foundCategory.subcat.find(
          (sub) => sub._id.toString() === subCategory,
        );
        if (!foundSubCategory) {
          return res
            .status(404)
            .json({ message: `SubCategory ${subCategory} not found` });
        }
        updateData.subCategory = {
          _id: foundSubCategory._id,
          name: foundSubCategory.name,
          slug: slugify(foundSubCategory.name, { lower: true }),
        };

        if (subSubCategory) {
          const foundSubSubCategory = foundSubCategory.subsubcat.find(
            (subsub) => subsub._id.toString() === subSubCategory,
          );
          if (!foundSubSubCategory) {
            return res
              .status(404)
              .json({ message: `SubSubCategory ${subSubCategory} not found` });
          }
          updateData.subSubCategory = {
            _id: foundSubSubCategory._id,
            name: foundSubSubCategory.name,
            slug: slugify(foundSubSubCategory.name, { lower: true }),
          };
        }
      }
    }

    // Handle zones
    if (zones) updateData.zones = zones;

    // Update document
    const updatedBanner = await Banner.updateOne(
      { _id: id },
      { $set: updateData },
    );

    if (updatedBanner.modifiedCount === 0) {
      return res
        .status(404)
        .json({ message: "No matching banner or data unchanged." });
    }

    return res
      .status(200)
      .json({ message: "Banner updated successfully.", banner: updatedBanner });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Error updating banner.", error: err.message });
  }
};

exports.getAllBanner = async (req, res) => {
  const allBanner = await Banner.find().sort({ createdAt: -1 });
  res.json(allBanner);
};

exports.addCategory = async (req, res) => {
  try {
    const {
      id,
      CategoryHeading,
      Selection,
      ItemsNo,
      MainCategory,
      SubCategory,
      Products = [],
    } = req.body;

    const image = req.files.image?.[0].path;
    if (!image) return res.status(400).json({ error: "Image is required" });

    const categoryData = {
      id: Number(id),
      CategoryHeading,
      Selection,
      image,
      ItemsNo: Number(ItemsNo),
      Products: [],
    };

    if (Selection === "Main") {
      const newMain = new Category({
        ...categoryData,
        subCategory: new Map(),
      });
      await newMain.save();

      return res
        .status(201)
        .json({ message: "Main category saved", data: newMain });
    }

    if (Selection === "Sub") {
      const mainCategory = await Category.findOne({
        CategoryHeading: MainCategory,
        Selection: "Main",
      });
      if (!mainCategory)
        return res.status(404).json({ error: "Main Category not found" });

      mainCategory.subCategory.set(CategoryHeading, {
        ...categoryData,
        subSubCategory: new Map(),
      });

      await mainCategory.save();
      return res.status(201).json({
        message: "Sub category added",
        data: mainCategory.subCategory.get(CategoryHeading),
      });
    }

    if (Selection === "Sub-Sub") {
      const allMainCats = await Category.find({ Selection: "Main" });

      let subInserted = false;

      for (const mainCat of allMainCats) {
        if (mainCat.subCategory && mainCat.subCategory.has(SubCategory)) {
          const subCat = mainCat.subCategory.get(SubCategory);
          if (!subCat.subSubCategory) subCat.subSubCategory = new Map();

          subCat.subSubCategory.set(CategoryHeading, categoryData);
          mainCat.subCategory.set(SubCategory, subCat);

          await mainCat.save();
          subInserted = true;

          return res.status(201).json({
            message: "Sub-Sub category added",
            data: subCat.subSubCategory.get(CategoryHeading),
          });
        }
      }

      if (!subInserted) {
        return res
          .status(404)
          .json({ error: "Sub category not found under any Main Category" });
      }
    }

    return res.status(400).json({ error: "Invalid Selection value" });
  } catch (err) {
    console.error("Add Category Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.editMainCategory = async (req, res) => {
  try {
    const { id, name, description, attribute, filter } = req.body;
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";

    if (!id)
      return res.status(400).json({ message: "Category ID is required" });

    const category = await Category.findById(id);
    if (!category)
      return res.status(404).json({ message: "Category not found" });

    // Parse attributes
    let parsedAttributes = [];
    if (attribute) {
      try {
        const attrIds = JSON.parse(attribute); // expects array of _id
        const attrDocs = await Attribute.find({ _id: { $in: attrIds } });
        parsedAttributes = attrDocs.map((attr) => attr.Attribute_name);
      } catch (err) {
        return res
          .status(400)
          .json({ message: "Invalid attribute data", error: err.message });
      }
    }

    // Parse filters (including brand logic)
    let parsedFilters = [];
    if (filter) {
      try {
        const rawFilters = JSON.parse(filter); // [{ _id, selected: [valueId1, valueId2] }]
        for (const f of rawFilters) {
          const filterDoc = await Filter.findById(f._id);
          if (!filterDoc) continue;

          if (filterDoc.Filter_name === "Brand") {
            // 🔥 Special logic for brand
            const brandDocs = await brand.find({ _id: { $in: f.selected } });
            parsedFilters.push({
              _id: filterDoc._id,
              Filter_name: "Brand",
              selected: brandDocs.map((b) => ({
                _id: b._id,
                name: b.brandName,
              })),
            });
          } else {
            // 🧠 Regular filter
            const selectedItems = filterDoc.Filter.filter((item) =>
              f.selected.includes(item._id.toString()),
            );

            parsedFilters.push({
              _id: filterDoc._id,
              Filter_name: filterDoc.Filter_name,
              selected: selectedItems.map((item) => ({
                _id: item._id,
                name: item.name,
              })),
            });
          }
        }
      } catch (err) {
        return res
          .status(400)
          .json({ message: "Invalid filter data", error: err.message });
      }
    }

    // 🔁 Update fields
    if (name) category.name = name;
    if (description) category.description = description;
    if (image) category.image = image;
    if (parsedAttributes.length > 0) category.attribute = parsedAttributes;
    if (parsedFilters.length > 0) category.filter = parsedFilters;

    await category.save();

    res
      .status(200)
      .json({ message: "Main category updated successfully", data: category });
  } catch (error) {
    console.error("editMainCategory error:", error);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

exports.getCategories = async (req, res) => {
  "-> need change";
  try {
    const { id } = req.query;
    const allCategories = await Category.find().lean();

    // helper: get product count by field
    const getCount = async (query) => {
      return await Products.countDocuments(query);
    };

    // format a sub-subcategory with product count
    const formatSubSub = async (subsub) => {
      const count = await getCount({ "subSubCategory._id": subsub._id });
      return {
        id: subsub._id,
        name: subsub.name,
        description: subsub.description,
        image: subsub.image,
        commison: subsub.commison || 0,
        productCount: count,
      };
    };

    // format a subcategory with product count + nested sub-subs
    const formatSub = async (sub) => {
      const subSubFormatted = await Promise.all(
        (sub.subsubcat || []).map(formatSubSub),
      );

      // count products in this subcat (including sub-subs if they reference subCategoryId)
      const count = await getCount({ "subCategory._id": sub._id });

      return {
        id: sub._id,
        name: sub.name,
        description: sub.description,
        image: sub.image,
        commison: sub.commison || 0,
        productCount: count,
        subSubCategories: subSubFormatted,
      };
    };

    // format top-level category with product count + subcats
    const formatCategory = async (cat) => {
      const subFormatted = await Promise.all((cat.subcat || []).map(formatSub));

      // count products in this category
      const count = await getCount({ "category._id": cat._id });

      return {
        id: cat._id,
        name: cat.name,
        description: cat.description,
        image: cat.image,
        productCount: count,
        subCategories: subFormatted,
      };
    };

    if (id) {
      // find single category by id
      const singleCategory = await Category.findById(id).lean();
      if (singleCategory) {
        const formatted = await formatCategory(singleCategory);
        return res.status(200).json({ category: formatted });
      }
      const subCategoryMatch = allCategories.find((cat) =>
        cat.subcat?.some((sub) => String(sub._id) === String(id)),
      );
      if (subCategoryMatch) {
        const sub = subCategoryMatch.subcat.find(
          (s) => String(s._id) === String(id),
        );
        const formatted = await formatSub(sub);
        return res.status(200).json({ subCategory: formatted });
      }

      // try sub-subcategory
      for (const cat of allCategories) {
        for (const sub of cat.subcat || []) {
          const subsub = sub.subsubcat?.find(
            (ss) => String(ss._id) === String(id),
          );
          if (subsub) {
            const formatted = await formatSubSub(subsub);
            return res.status(200).json({ subSubCategory: formatted });
          }
        }
      }

      return res.status(404).json({ message: "Category not found" });
    }
    // otherwise return all
    const formatted = await Promise.all(allCategories.map(formatCategory));

    return res.status(200).json({ categories: formatted });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: err.message });
  }
};

exports.brand = async (req, res) => {
  try {
    const { brandName, description, featured, typeId } = req.body;
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";

    if (!image) {
      // console.log(image);

      return res.status(400).json({ message: "Image is required" });
    }
    const brandId = await getNextBrandId();
    const newBrand = await brand.create({
      brandName,
      brandId,
      brandLogo: image,
      description,
      featured,
      typeId,
    });
    return res.status(200).json({ message: "sucess", newBrand });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occured!", error: error.message });
  }
};

exports.getBrand = async (req, res) => {
  try {
    const { id, page = 1, limit } = req.query;
    const skip = (page - 1) * limit;
    // 🔍 If specific brand ID
    if (id) {
      const b = await brand.findById(id).lean();
      if (!b) return res.status(404).json({ message: "Brand not found" });

      // 🔥 Fetch only products of that brand
      const productsCollection = mongoose.connection.db.collection("products");
      const totalProducts = await productsCollection.countDocuments({
        "brand_Name._id": new mongoose.Types.ObjectId(id),
      });

      const products = await productsCollection
        .find({ "brand_Name._id": new mongoose.Types.ObjectId(id) })
        .skip(skip)
        .limit(Number(limit))
        .toArray();

      // Collect all variant/product combinations
      const productVariantPairs = [];
      for (const p of products) {
        for (const v of p.variants || []) {
          productVariantPairs.push({
            productId: p._id.toString(),
            variantId: v._id.toString(),
          });
        }
      }

      // 🔥 Build query for only required stock entries
      const stockDocs = await Stock.find({
        "stock.productId": { $in: productVariantPairs.map((p) => p.productId) },
      }).lean();

      const storeIds = [
        ...new Set(stockDocs.map((d) => d.storeId?.toString()).filter(Boolean)),
      ];

      const stores = await Store.find(
        { _id: { $in: storeIds } },
        { storeName: 1 },
      ).lean();

      const storeMap = {};
      stores.forEach((s) => {
        storeMap[s._id.toString()] = s.storeName;
      });

      // Build stockMap
      const stockMap = {};
      for (const doc of stockDocs) {
        for (const item of doc.stock || []) {
          const key = `${item.productId}_${item.variantId}`;
          stockMap[key] = {
            quantity: item.quantity,
            storeId: doc.storeId,
            storeName: storeMap[doc.storeId?.toString()] || "",
          };
        }
      }

      // Add inventory
      const attachInventory = (products = []) => {
        for (const product of products) {
          product.inventory = [];

          if (Array.isArray(product.variants)) {
            for (const variant of product.variants) {
              const key = `${product._id}_${variant._id}`;
              const quantity = stockMap[key] || 0;

              const stock = stockMap[key];

              product.inventory.push({
                variantId: variant._id,
                quantity: stock ? stock.quantity : 0,
                storeId: stock ? stock.storeId : "",
                storeName: stock ? stock.storeName : "",
              });
            }
          }
        }
        return products;
      };

      const productsWithStock = attachInventory(products);

      productsWithStock.forEach((product) => {
        if (Array.isArray(product.inventory) && product.inventory.length > 0) {
          const firstInv = product.inventory.find(
            (i) => i.storeId && i.storeName,
          );

          product.storeId = firstInv ? firstInv.storeId : "";
          product.storeName = firstInv ? firstInv.storeName : "";
        } else {
          product.storeId = "";
          product.storeName = "";
        }
      });

      return res.json({
        ...b,
        products: productsWithStock,
        total: totalProducts,
        page: Number(page),
        limit: Number(limit) || "",
        totalPages: Math.ceil(totalProducts / limit) || "",
      });
    }

    // 🔁 For all brands (no products or stock)
    const brands = await brand.find({}).sort({ createdAt: -1 }).lean();

    const allBrands = [];
    const featuredBrands = [];

    for (const b of brands) {
      allBrands.push(b);
      if (b.featured === true || b.featured === "true") {
        featuredBrands.push(b);
      }
    }

    return res.json({
      featuredBrands,
      allBrands,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "An error occurred!",
      error: error.message,
    });
  }
};

exports.editBrand = async (req, res) => {
  try {
    const { id } = req.params;
    const { brandName, description, featured, typeId } = req.body;

    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";

    const updateData = {};
    if (typeId !== undefined) updateData.typeId = typeId;
    if (brandName !== undefined) updateData.brandName = brandName;
    if (description !== undefined) updateData.description = description;
    if (featured !== undefined) updateData.featured = featured;
    if (image) updateData.brandLogo = image;

    const edit = await brand.updateOne({ _id: id }, updateData, { new: true });

    return res.status(200).json({ message: "Done", edit });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred!", error: error.message });
  }
};

exports.editCat = async (req, res) => {
  try {
    const { id } = req.params;
    let { name, description, filter, attribute, status, typeId } = req.body;

    const image = req.file ? req.file.filename : undefined;

    if (filter) {
      filter = JSON.parse(filter);

      filter = filter.map((f) => ({
        _id: f._id,
        selected: (f.selected || []).map((val) => ({
          _id: val,
        })),
      }));
    }

    if (attribute) attribute = JSON.parse(attribute);

    const mainCat = await Category.findOne({
      $or: [{ _id: id }, { "subcat._id": id }, { "subcat.subsubcat._id": id }],
    });

    if (!mainCat) {
      return res.status(404).json({ message: "Category not found" });
    }

    let updated = false;

    if (mainCat._id.toString() === id) {
      if (name !== undefined) mainCat.name = name;
      if (description !== undefined) mainCat.description = description;
      if (image !== undefined) mainCat.image = image;
      if (filter !== undefined) mainCat.filter = filter;
      if (attribute !== undefined) mainCat.attribute = attribute;
      if (typeId !== undefined) mainCat.typeId = typeId;
      if (status !== undefined) mainCat.status = status;

      updated = true;
    } else {
      for (let sub of mainCat.subcat) {
        if (sub._id.toString() === id) {
          sub.status = status;
          updated = true;
          break;
        }

        for (let subsub of sub.subsubcat || []) {
          if (subsub._id.toString() === id) {
            subsub.status = status;
            updated = true;
            break;
          }
        }

        if (updated) break;
      }
    }

    if (updated) {
      await mainCat.save();
      return res
        .status(200)
        .json({ message: "Category status updated successfully" });
    } else {
      return res.status(404).json({ message: "ID not found in any level" });
    }
  } catch (error) {
    console.error("Update error:", error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.updateAt = async (req, res) => {
  try {
    const { id } = req.params;
    const { attribute } = req.body;
    const attrArray = Array.isArray(attribute) ? attribute : [attribute];

    const newUpdate = await Category.findByIdAndUpdate(
      id,
      { $addToSet: { attribute: { $each: attrArray } } },
      { new: true },
    );
    return res
      .status(200)
      .json({ message: "Category status updated successfully", newUpdate });
  } catch (error) {
    console.error("Update error:", error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.addFilter = async (req, res) => {
  try {
    const { Filter_name, Filter } = req.body;
    const newFilter = await Filters.create({ Filter_name, Filter });
    return res.status(200).json({ message: "Filter Created", newFilter });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occured" });
  }
};

exports.editFilter = async (req, res) => {
  try {
    const { id } = req.params;
    const { Filter_name, Filter } = req.body;

    const filter = await Filters.findByIdAndUpdate(
      id,
      {
        $set: {
          Filter_name,
          Filter,
        },
      },
      { new: true },
    );

    return res.status(200).json({ message: "Attributes Updated", filter });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.getFilter = async (req, res) => {
  try {
    const Filter = await Filters.find();
    res.json(Filter);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occured" });
  }
};

exports.deleteFilter = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Filters.findByIdAndDelete(id);
    res.status(200).json({ message: "Filter deleted successfully", deleted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error", error });
  }
};

exports.deleteFilterVal = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Filters.findOneAndUpdate(
      { "Filter._id": id },
      { $pull: { Filter: { _id: id } } },
    );
    res.status(200).json({ message: "Filter deleted successfully", deleted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error", error });
  }
};

// if (req.file && req.file.path) {
//       updateData.image = req.file.path;
//     }

exports.addFiltersToCategory = async (req, res) => {
  try {
    const { id } = req.params; // category id
    const { filterIds } = req.body; // array of filter _ids

    // Convert to ObjectId
    const objectIds = filterIds.map((fid) => new mongoose.Types.ObjectId(fid));

    // Get filter docs
    const filters = await Filters.find({ _id: { $in: objectIds } });

    if (!filters.length) {
      return res.status(404).json({ message: "No valid filters found" });
    }

    // Construct the filter objects as needed in category
    const filtersToAdd = filters.map((f) => ({
      _id: f._id,
      Filter_name: f.Filter_name,
      selected: [], // 🛠️ important: this puts the actual options in
    }));

    // Push into category
    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { $push: { filter: { $each: filtersToAdd } } },
      { new: true },
    );

    if (!updatedCategory) {
      return res.status(404).json({ message: "Category not found" });
    }

    res.status(200).json({
      message: "✅ Filters added to category",
      category: updatedCategory,
    });
  } catch (error) {
    console.error("❌ Error adding filters to category:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.addMainCategory = async (req, res) => {
  try {
    const { name, description, attribute, typeId, filter } = req.body;
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const imagePath = rawImagePath ? `/${rawImagePath}` : "";

    if (!name || !description || !imagePath || !typeId) {
      return res
        .status(400)
        .json({ message: "Name, description, image and type ID are required" });
    }

    let parsedFilters = [];

    if (filter) {
      const rawFilters = JSON.parse(filter); // [{ _id, selected: [valueId1, valueId2] }]

      for (const f of rawFilters) {
        const filterId = f._id;
        const selectedIds = f.selected || [];

        const filterDoc = await Filter.findById(filterId);
        if (!filterDoc) continue;

        if (filterDoc.Filter_name === "Brand") {
          // ✅ Fetch brand names from the Brand model
          const selectedBrands = await brand.find({
            _id: { $in: selectedIds },
          });

          parsedFilters.push({
            _id: filterDoc._id,
            Filter_name: "Brand",
            selected: selectedBrands.map((b) => ({
              _id: b._id,
              name: b.brandName,
            })),
          });
        } else {
          // Normal filter (e.g. Types, Size, etc.)
          const selectedItems = filterDoc.Filter.filter((item) =>
            selectedIds.includes(item._id.toString()),
          );

          parsedFilters.push({
            _id: filterDoc._id,
            Filter_name: filterDoc.Filter_name,
            selected: selectedItems.map((item) => ({
              _id: item._id,
              name: item.name,
            })),
          });
        }
      }
    }

    let attributeArray = [];
    try {
      attributeArray = JSON.parse(attribute); // This turns string into array
    } catch (err) {
      return res
        .status(400)
        .json({ message: "Invalid JSON in attribute", error: err.message });
    }

    const setAttributes = await Attribute.find({
      _id: { $in: attributeArray },
    });
    const categoryId = await getNextCategoryId();

    const newCategory = new Category({
      name,
      categoryId,
      description,
      image: imagePath,
      subcat: [],
      typeId,
      status: true,
      attribute: setAttributes.map((attr) => attr.Attribute_name),
      filter: parsedFilters,
    });

    const result = await newCategory.save();

    res.status(201).json({ message: "Main Category added", id: result._id });
  } catch (error) {
    console.error("Error while adding category:", error);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

exports.addSubCategory = async (req, res) => {
  try {
    const { name, description, mainCategoryId, attribute } = req.body;
    const image = `/${req.files?.image?.[0]?.key}`;

    // Validation
    if (!name || !description || !image || !mainCategoryId) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const subCategoryId = await getNextSubCategoryId();
    // Create subcategory object
    const newSubCategory = {
      name,
      subCategoryId,
      description,
      image,
      status: true,
      attribute: attribute ? JSON.parse(attribute) : [],
    };

    // Update the main category
    const result = await Category.findByIdAndUpdate(
      mainCategoryId,
      { $push: { subcat: newSubCategory } },
      { new: true },
    );

    // Success response
    return res.status(200).json({
      message: "Sub Category added",
      subCategoryId: newSubCategory._id,
      result,
    });
  } catch (error) {
    console.error("Error adding subcategory:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.addSubSubCategory = async (req, res) => {
  try {
    const { subCategoryId, name, description, attribute } = req.body;

    const image = `/${req.files.image[0].key}`;

    if (!subCategoryId || !name || !description || !image) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Custom ID (SUBB01, SUBB02...)
    const subSubCategoryId = await getNextSubbCategoryId();

    const newSubSubCategory = {
      subSubCategoryId, // Your custom ID
      name,
      description,
      image,
      status: true,
      attribute: attribute ? JSON.parse(attribute) : [],
    };

    const update = await Category.findOneAndUpdate(
      { "subcat._id": subCategoryId },
      { $push: { "subcat.$.subsubcat": newSubSubCategory } },
      { new: true },
    );

    return res.status(201).json({
      message: "Sub-Sub Category added",
      subSubCategory: newSubSubCategory,
    });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

exports.getMainCategory = async (req, res) => {
  "->need change";
  try {
    const { page = 1, limit = 20 } = req.query; // default values
    const skip = (page - 1) * limit;

    // Get total categories for pagination
    const totalCategories = await Category.countDocuments();

    // Fetch only current page categories
    const data = await Category.find().skip(skip).limit(limit);

    // Enrich with totalProducts
    const enriched = await Promise.all(
      data.map(async (category) => {
        const categoryIds = [category._id.toString()];

        category.subcat?.forEach((sub) => {
          categoryIds.push(sub._id.toString());
          sub.subsubcat?.forEach((subsub) => {
            categoryIds.push(subsub._id.toString());
          });
        });

        const productCount = await Products.countDocuments({
          $or: [
            { "category._id": { $in: categoryIds } },
            { subCategoryId: { $in: categoryIds } },
            { subSubCategoryId: { $in: categoryIds } },
          ],
        });

        return {
          ...category._doc,
          totalProducts: productCount,
        };
      }),
    );

    res.status(200).send({
      message: "Success",
      limit,
      currentPage: page,
      totalPages: Math.ceil(totalCategories / limit),
      totalCategories,
      result: enriched,
    });
  } catch (err) {
    console.error("getMainCategory error:", err);
    res.status(500).send({
      message: "Server Error",
      error: err.message,
    });
  }
};

exports.GetSubCategories = async (req, res) => {
  try {
    const categoryId = req.params.categoryId;

    // Step 1: Find category by _id
    const category = await Category.findOne({ _id: categoryId });

    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    // Step 2: Return subcat array
    res.status(200).json({ subcategories: category.subcat || [] });
  } catch (err) {
    console.error("GetSubCategories Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.GetSubSubCategories = async (req, res) => {
  try {
    const subcatId = req.params.subcatId;

    // Step 1: Find the category document that contains the given subcat _id
    const category = await Category.findOne({
      "subcat._id": subcatId,
    });

    if (!category) {
      return res.status(404).json({ error: "SubCategory not found" });
    }

    // Step 2: Find that specific subcategory inside the array
    const subcategory = category.subcat.find(
      (item) => item._id.toString() === subcatId,
    );

    if (!subcategory) {
      return res
        .status(404)
        .json({ error: "SubCategory not found in category" });
    }

    res.status(200).json({ subsubcategories: subcategory.subsubcat || [] });
  } catch (err) {
    console.error("GetSubSubCategories Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.setCommison = async (req, res) => {
  try {
    const { id, commison, level } = req.body;

    // Validate commission value
    if (commison === undefined || commison === null) {
      return res.status(400).json({ error: "Commission value is required" });
    }

    const commissionValue = Number(commison);
    if (isNaN(commissionValue) || commissionValue < 0) {
      return res
        .status(400)
        .json({ error: "Commission must be a valid positive number" });
    }

    // Validate level - only sub and subsub are allowed
    if (!level || !["sub", "subsub"].includes(level)) {
      return res.status(400).json({ error: "Level must be 'sub' or 'subsub'" });
    }

    let updatedCategory;

    if (level === "sub") {
      // Update subcategory commission
      updatedCategory = await Category.findOneAndUpdate(
        { "subcat._id": id },
        { $set: { "subcat.$.commison": commissionValue } },
        { new: true },
      );
    } else if (level === "subsub") {
      // For sub-subcategory, we need to find the parent category first
      const category = await Category.findOne({
        "subcat.subsubcat._id": id,
      });

      if (!category) {
        return res.status(404).json({ error: "Sub-subcategory not found" });
      }

      // Find and update the specific sub-subcategory
      let found = false;
      for (let i = 0; i < category.subcat.length; i++) {
        const subcat = category.subcat[i];
        if (subcat.subsubcat && subcat.subsubcat.length > 0) {
          for (let j = 0; j < subcat.subsubcat.length; j++) {
            if (subcat.subsubcat[j]._id.toString() === id) {
              // Update the commission
              category.subcat[i].subsubcat[j].commison = commissionValue;
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }

      if (!found) {
        return res
          .status(404)
          .json({ error: "Sub-subcategory not found in any subcategory" });
      }

      // Save the updated category
      updatedCategory = await category.save();
    }

    if (!updatedCategory) {
      return res.status(404).json({ error: "Category not found" });
    }

    return res.status(200).json({
      message: "Commission set successfully",
      data: updatedCategory,
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
