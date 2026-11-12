const mongoose = require("mongoose");
const { SettingAdmin } = require("../modals/setting");
const ContactUs = require("../modals/contactUs");
const Store = require("../modals/store");
const Product = require("../modals/Product");
const Stock = require("../modals/StoreStock");
const Category = require("../modals/category");
const Brand = require("../modals/brand");
const Banner = require("../modals/banner");
const Type = require("../modals/type");
const { getGlobalDeliveryRule } = require("../utils/globalDelivery");

const INQUIRY_TYPES = new Set(["general", "seller", "delivery"]);
const pageArgs = (query) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 24)),
});
const escapeRegex = (value) => String(value).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

exports.checkDelivery = async (req, res) => {
  const pincode = String(req.params.pincode || "").trim();
  if (!/^[1-9][0-9]{5}$/.test(pincode)) return res.status(400).json({ available: false, message: "Enter a valid six-digit PIN code." });
  try {
    const settings = await SettingAdmin.findOne().select("globalDeliveryRules globalDeliveryDefaults").lean();
    const rule = getGlobalDeliveryRule(settings, pincode);
    if (!rule) return res.json({ available: false, pincode, message: "Global delivery is not available for this PIN code yet." });
    const deliveryDays = rule.daysMin === rule.daysMax
      ? `${rule.daysMin}`
      : `${rule.daysMin}-${rule.daysMax}`;
    const deliveryCharge = Number(rule.shippingCharge);
    return res.json({
      available: true,
      pincode,
      shippingCharge: deliveryCharge,
      deliveryCharge,
      daysMin: Number(rule.daysMin),
      daysMax: Number(rule.daysMax),
      deliveryDays,
      estimatedDeliveryText: `${deliveryDays} days`,
      codAllowed: rule.codAllowed === true,
      ruleSource: rule.source,
      message: "Global delivery is available for this PIN code.",
    });
  } catch (error) {
    console.error("Global delivery PIN check failed:", error);
    return res.status(500).json({ available: false, message: "Could not check delivery right now." });
  }
};

const globalTypeIds = async () => {
  const types = await Type.find({ name: { $in: ["grocery", "mall"] } }).select("_id").lean();
  return types.map((type) => type._id);
};

const globalStores = async () => {
  const typeIds = await globalTypeIds();
  if (!typeIds.length) return [];
  return Store.find({ status: true, serviceScope: "global", typeId: { $in: typeIds } })
    .select("_id storeName Category image typeId")
    .lean();
};
const globalProductFilter = async () => {
  const [stores, typeIds] = await Promise.all([globalStores(), globalTypeIds()]);
  const globalCategories = typeIds.length
    ? await Category.find({ status: true, typeId: { $in: typeIds } }).select("_id").lean()
    : [];
  const stockDocs = stores.length
    ? await Stock.find({ storeId: { $in: stores.map((store) => store._id) } }).select("storeId stock").lean()
    : [];
  const stockByProduct = new Map();
  stockDocs.forEach((doc) => (doc.stock || []).forEach((item) => {
    if (!item.productId || Number(item.quantity) <= 0) return;
    const key = String(item.productId);
    if (!stockByProduct.has(key)) stockByProduct.set(key, []);
    stockByProduct.get(key).push({ ...item, storeId: doc.storeId });
  }));
  return {
    stores,
    stockByProduct,
    filter: {
      status: true,
      online_visible: true,
      typeId: { $in: typeIds },
      "category._id": { $in: globalCategories.map((category) => category._id) },
      _id: { $in: [...stockByProduct.keys()].map((id) => new mongoose.Types.ObjectId(id)) },
    },
  };
};

const attachGlobalStock = (products, stores, stockByProduct) => {
  const storeNames = new Map(stores.map((store) => [String(store._id), store.storeName]));
  return products.map((product) => {
    const entries = stockByProduct.get(String(product._id)) || [];
    const first = entries[0];
    const byVariant = new Map(entries.map((entry) => [String(entry.variantId), entry]));
    const variants = (product.variants || []).map((variant) => {
      const stock = byVariant.get(String(variant._id));
      return stock ? { ...variant, sell_price: stock.price ?? variant.sell_price, mrp: stock.mrp ?? variant.mrp } : variant;
    });
    return {
      ...product,
      variants,
      inventory: variants.map((variant) => ({ variantId: variant._id, quantity: Number(byVariant.get(String(variant._id))?.quantity || 0) })),
      storeId: first?.storeId,
      storeName: storeNames.get(String(first?.storeId)) || "Fivlia Global",
    };
  });
};

exports.banners = async (req, res) => {
  const type = req.query.type;
  if (type && !["offer", "normal"].includes(type)) return res.status(400).json({ message: 'Invalid banner type. Must be "offer" or "normal".' });
  try {
    const data = await Banner.find({ status: true, isGlobal: true, ...(type ? { type } : {}) }).sort({ createdAt: -1 }).lean();
    return res.json({ message: "Global banners", count: data.length, data });
  } catch (error) { return res.status(500).json({ message: "Could not load global banners." }); }
};

exports.categories = async (_req, res) => {
  try {
    const stores = await globalStores();
    const { filter: globalFilter } = await globalProductFilter();
    const productIds = await Product.distinct("category._id", globalFilter);
    const filter = { status: true, _id: { $in: productIds } };
    const result = await Category.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
    return res.json({ result, count: result.length });
  } catch (error) { return res.status(500).json({ message: "Could not load global categories." }); }
};

exports.brands = async (req, res) => {
  try {
    const { filter, stockByProduct, stores } = await globalProductFilter();
    const ids = await Product.distinct("brand_Name._id", { ...filter, "brand_Name._id": { $ne: null } });
    const requestedId = req.query.id;
    if (requestedId && mongoose.isValidObjectId(requestedId)) {
      const [brand, products] = await Promise.all([
        Brand.findOne({ $and: [{ _id: requestedId }, { _id: { $in: ids } }] }).lean(),
        Product.find({ ...filter, "brand_Name._id": requestedId }).sort({ createdAt: -1 }).limit(100).lean(),
      ]);
      return res.json({ brand, products: attachGlobalStock(products, stores, stockByProduct) });
    }
    const [featuredBrands, allBrands] = await Promise.all([
      Brand.find({ _id: { $in: ids }, featured: true }).lean(),
      Brand.find({ _id: { $in: ids } }).lean(),
    ]);
    return res.json({ featuredBrands, allBrands });
  } catch (error) { return res.status(500).json({ message: "Could not load global brands." }); }
};

exports.stores = async (_req, res) => {
  try {
    const stores = await globalStores();
    return res.json({ storeDetailsWithRatings: stores.map((store) => ({ ...store, storeId: store._id, storeName: store.storeName })) });
  } catch (error) { return res.status(500).json({ message: "Could not load global sellers." }); }
};

exports.productCounts = async (req, res) => {
  try {
    const { filter } = await globalProductFilter();
    const countByField = async (field) => {
      const rows = await Product.aggregate([
        { $match: filter },
        { $unwind: `$${field}` },
        { $match: { [`${field}._id`]: { $exists: true, $ne: null } } },
        { $group: { _id: `$${field}._id`, count: { $sum: 1 } } },
      ]);
      return Object.fromEntries(rows.map((row) => [String(row._id), row.count]));
    };
    const [main, subcat, subsubcat] = await Promise.all([
      countByField("category"),
      countByField("subCategory"),
      countByField("subSubCategory"),
    ]);
    return res.json({ counts: { main, subcat, subsubcat } });
  } catch (error) { return res.status(500).json({ counts: { main: {}, subcat: {}, subsubcat: {} } }); }
};

exports.products = async (req, res) => {
  try {
    const { page, limit } = pageArgs(req.query);
    const { stores, filter, stockByProduct } = await globalProductFilter();
    const category = req.query.category;
    const brandId = req.query.brandId || req.query.id;
    const sellerId = req.query.seller || req.query.storeId;
    const name = req.query.name || req.query.search;
    if (category) filter["category._id"] = { $in: (Array.isArray(category) ? category : [category]).filter(mongoose.isValidObjectId) };
    if (brandId && mongoose.isValidObjectId(brandId)) filter["brand_Name._id"] = brandId;
    if (sellerId) {
      const idsForSeller = mongoose.isValidObjectId(sellerId) && stores.some((store) => String(store._id) === String(sellerId))
        ? [...stockByProduct.entries()].filter(([, entries]) => entries.some((entry) => String(entry.storeId) === String(sellerId))).map(([id]) => id)
        : [];
      filter._id.$in = [...new Set(idsForSeller)];
    }
    const subCategory = req.query.subCategory;
    if (subCategory) filter["subCategory._id"] = { $in: (Array.isArray(subCategory) ? subCategory : [subCategory]).filter(mongoose.isValidObjectId) };
    const subSubCategory = req.query.subSubCategory;
    if (subSubCategory) filter["subSubCategory._id"] = { $in: (Array.isArray(subSubCategory) ? subSubCategory : [subSubCategory]).filter(mongoose.isValidObjectId) };
    if (req.query.priceMin != null || req.query.priceMax != null) {
      filter.sell_price = {};
      if (req.query.priceMin != null) filter.sell_price.$gte = Number(req.query.priceMin);
      if (req.query.priceMax != null) filter.sell_price.$lte = Number(req.query.priceMax);
    }
    if (name) filter.productName = { $regex: escapeRegex(name), $options: "i" };
    if (req.query.featured === "true") filter.feature_product = true;
    const [products, total] = await Promise.all([
      Product.find(filter).sort({ purchases: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(filter),
    ]);
    const withStore = attachGlobalStock(products, stores, stockByProduct);
    return res.json({ products: withStore, best: withStore, total, page, limit, pages: Math.ceil(total / limit), filter: [] });
  } catch (error) {
    console.error("Global website products failed:", error);
    return res.status(500).json({ message: "Could not load global products." });
  }
};

exports.productBySlug = async (req, res) => {
  try {
    const { filter, stockByProduct, stores } = await globalProductFilter();
    const product = await Product.findOne({ ...filter, slug: req.params.slug }).lean();
    if (!product) return res.status(404).json({ message: "Global product not found." });
    const [enriched] = attachGlobalStock([product], stores, stockByProduct);
    return res.json({ product: enriched, data: enriched });
  } catch (error) { return res.status(500).json({ message: "Could not load this product." }); }
};

exports.relatedProducts = async (req, res) => {
  try {
    const { filter, stockByProduct, stores } = await globalProductFilter();
    const source = await Product.findOne({ ...filter, _id: req.params.id }).select("category subCategory subSubCategory brand_Name").lean();
    if (!source) return res.json({ relatedProducts: [] });
    const relatedFilter = { ...filter, _id: { $ne: source._id, $in: filter._id.$in } };
    if (source.category?.length) relatedFilter["category._id"] = { $in: source.category.map((item) => item._id) };
    else if (source.brand_Name?._id) relatedFilter["brand_Name._id"] = source.brand_Name._id;
    const products = await Product.find(relatedFilter).sort({ purchases: -1 }).limit(12).lean();
    return res.json({ relatedProducts: attachGlobalStock(products, stores, stockByProduct) });
  } catch (error) { return res.status(500).json({ relatedProducts: [], message: "Could not load related global products." }); }
};

exports.recommendedProducts = async (req, res) => {
  try {
    const { stores, filter, stockByProduct } = await globalProductFilter();
    const products = await Product.find(filter).sort({ purchases: -1, createdAt: -1 }).limit(12).lean();
    return res.json({ relatedProducts: attachGlobalStock(products, stores, stockByProduct) });
  } catch (error) { return res.status(500).json({ relatedProducts: [], message: "Could not load recommendations." }); }
};

exports.seller = async (req, res) => {
  try {
    const { stores, filter, stockByProduct } = await globalProductFilter();
    const store = stores.find((item) => String(item._id) === String(req.query.id));
    if (!store) return res.status(404).json({ seller: null, products: [], categories: [] });
    const productIds = [...stockByProduct.entries()].filter(([, entries]) => entries.some((entry) => String(entry.storeId) === String(store._id))).map(([id]) => id);
    const products = await Product.find({ ...filter, _id: { $in: productIds } }).limit(100).lean();
    return res.json({ seller: store, products: attachGlobalStock(products, stores, stockByProduct), categories: [], sellerImage: store.image || [] });
  } catch (error) { return res.status(500).json({ seller: null, products: [], categories: [] }); }
};

exports.submitInquiry = async (req, res) => {
  const { name, email, phone = "", message, inquiryType = "general", website = "" } = req.body || {};
  if (String(website).trim()) return res.status(201).json({ message: "Thanks for reaching out." });
  const cleanName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cleanPhone = typeof phone === "string" ? phone.trim() : "";
  const cleanMessage = typeof message === "string" ? message.trim() : "";
  if (cleanName.length < 2 || cleanName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 160 || cleanPhone.length > 24 || cleanMessage.length < 5 || cleanMessage.length > 2000 || !INQUIRY_TYPES.has(inquiryType)) return res.status(400).json({ message: "Please check your contact details and message." });
  try {
    const [firstName, ...lastName] = cleanName.split(" ");
    const label = { general: "General enquiry", seller: "Seller partnership", delivery: "Delivery partner" }[inquiryType];
    await ContactUs.create({ firstName, lastName: lastName.join(" "), email: cleanEmail, phone: cleanPhone, message: `[${label}] ${cleanMessage}` });
    return res.status(201).json({ message: "Thanks for reaching out. Our team will be in touch soon." });
  } catch (error) { return res.status(500).json({ message: "We could not save your note right now." }); }
};
