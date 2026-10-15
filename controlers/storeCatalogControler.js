// controlers/storeCatalogControler.js
// NEW file. Splits the heavy GET /getStore?id=... into 3 small endpoints.
// /getStore itself is left untouched (Admin panel still uses it).
//
//   GET /getStoreCategories?id=<storeId>
//   GET /getStoreProducts?id=<storeId>&page=1&limit=30&search=&city=&stockFilter=&withCities=1
//   GET /getStoreStockSummary?id=<storeId>

const mongoose = require("mongoose");
const Store = require("../modals/store");
const Stock = require("../modals/StoreStock");
const Products = require("../modals/Product");
const CategoryModel = require("../modals/category");
const {
  buildProductCategoryFilter,
  loadCategoryTrees,
  applyStockToProducts,
} = require("../utils/storeCatalog");

const LOW_STOCK_LIMIT = 10;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// store + category tree + every category id that belongs to the store
const loadStoreScope = async (id) => {
  const store = await Store.findById(id).lean();
  if (!store) return null;
  const { categoryTrees, allCategoryIds } = await loadCategoryTrees(
    CategoryModel,
    store.Category,
  );
  return { store, categoryTrees, allCategoryIds };
};

// Only the stock rows of the given products (not the whole store stock array)
const loadStockForProducts = async (storeId, productIds) => {
  if (!productIds.length) return [];
  const rows = await Stock.aggregate([
    { $match: { storeId: new mongoose.Types.ObjectId(storeId) } },
    {
      $project: {
        stock: {
          $filter: {
            input: "$stock",
            as: "s",
            cond: { $in: ["$$s.productId", productIds] },
          },
        },
      },
    },
  ]);
  return rows[0]?.stock || [];
};

// Tiny projection (_id + variant ids only) -> ids of out-of-stock / low-stock products.
// Same rule as the old front-end: totalStock = sum of variant quantities.
const computeStockBuckets = async (storeId, categoryFilter) => {
  const [slim, stockDoc] = await Promise.all([
    Products.find(categoryFilter).select({ _id: 1, "variants._id": 1 }).lean(),
    Stock.findOne({ storeId }).select({ stock: 1 }).lean(),
  ]);

  const qtyByProduct = new Map();
  const firstSeen = new Set();
  for (const s of stockDoc?.stock || []) {
    const key = `${s.productId}_${s.variantId}`;
    if (firstSeen.has(key)) continue; // first entry wins (same as applyStockToProducts)
    firstSeen.add(key);
    const pid = String(s.productId);
    qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + (s.quantity || 0));
  }

  const out = [];
  const low = [];
  for (const p of slim) {
    const total = qtyByProduct.get(String(p._id)) || 0;
    if (total === 0) out.push(p._id);
    else if (total <= LOW_STOCK_LIMIT) low.push(p._id);
  }
  return { out, low };
};

// ---------------------------------------------------------------
// 1) Categories only
// ---------------------------------------------------------------
exports.getStoreCategories = async (req, res) => {
  try {
    const { id } = req.query;
    if (!id || !isValidId(id)) {
      return res.status(400).json({ message: "Valid store id is required" });
    }
    const scope = await loadStoreScope(id);
    if (!scope) return res.status(404).json({ message: "Store not found" });

    return res
      .status(200)
      .json({ store: scope.store, categories: scope.categoryTrees });
  } catch (err) {
    console.error("Error in getStoreCategories:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ---------------------------------------------------------------
// 2) Products – paginated, with this store's stock/price applied
// ---------------------------------------------------------------
exports.getStoreProducts = async (req, res) => {
  try {
    const { id, search = "", city = "", stockFilter = "", withCities } = req.query;
    if (!id || !isValidId(id)) {
      return res.status(400).json({ message: "Valid store id is required" });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // limit=0 -> everything (used for export / out-of-stock popup)
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isNaN(rawLimit) ? 30 : Math.max(rawLimit, 0);

    const scope = await loadStoreScope(id);
    if (!scope) return res.status(404).json({ message: "Store not found" });

    const and = [buildProductCategoryFilter(scope.allCategoryIds)];

    if (search.trim()) {
      const rx = new RegExp(escapeRegex(search.trim()), "i");
      and.push({
        $or: [
          { productName: rx },
          { sku: rx },
          { "brand_Name.name": rx },
          { "category.name": rx },
        ],
      });
    }
    if (city) and.push({ "location.city.name": city });

    if (stockFilter === "out" || stockFilter === "low") {
      const buckets = await computeStockBuckets(id, and[0]);
      and.push({ _id: { $in: stockFilter === "out" ? buckets.out : buckets.low } });
    }

    const filter = and.length === 1 ? and[0] : { $and: and };

    const total = await Products.countDocuments(filter);

    let query = Products.find(filter).select({ inventory: 0 }).sort({ _id: 1 });
    if (limit > 0) query = query.skip((page - 1) * limit).limit(limit);
    const products = await query.lean();

    const stockEntries = await loadStockForProducts(
      id,
      products.map((p) => p._id),
    );
    applyStockToProducts(products, stockEntries);

    const body = {
      products,
      total,
      page,
      limit,
      totalPages: limit > 0 ? Math.max(Math.ceil(total / limit), 1) : 1,
    };

    if (withCities) {
      const cities = await Products.distinct(
        "location.city.name",
        buildProductCategoryFilter(scope.allCategoryIds),
      );
      body.cities = cities.filter(Boolean).sort();
    }

    return res.status(200).json(body);
  } catch (err) {
    console.error("Error in getStoreProducts:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ---------------------------------------------------------------
// 3) Out-of-stock / low-stock counts for the Stock page
// ---------------------------------------------------------------
exports.getStoreStockSummary = async (req, res) => {
  try {
    const { id } = req.query;
    if (!id || !isValidId(id)) {
      return res.status(400).json({ message: "Valid store id is required" });
    }
    const scope = await loadStoreScope(id);
    if (!scope) return res.status(404).json({ message: "Store not found" });

    const buckets = await computeStockBuckets(
      id,
      buildProductCategoryFilter(scope.allCategoryIds),
    );
    return res.status(200).json({
      outOfStock: buckets.out.length,
      lowStock: buckets.low.length,
    });
  } catch (err) {
    console.error("Error in getStoreStockSummary:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};
