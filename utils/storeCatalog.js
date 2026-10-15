// utils/storeCatalog.js
// Helpers used by GET /getStore (controlers/storeControler.js -> getStore).
// Behaviour is intentionally identical to the previous inline implementation;
// only the number of DB round-trips and the per-variant stock lookup changed.

// Legacy filter branches. `subCategoryId` / `subSubCategoryId` are NOT declared in
// modals/Product.js (the schema uses subCategory[]._id / subSubCategory[]._id), so on
// Mongoose 8 (strictQuery=false) they are sent to MongoDB as-is, uncast, and have no index,
// which forces a full collection scan for the whole $or.
// Default = true  -> exactly the same filter as before (safe).
// Set STORE_PRODUCTS_LEGACY_CATEGORY_FIELDS=false ONLY after scripts/auditStoreProducts.js
// shows that no product document contains those two fields.
const includeLegacyCategoryFields = () =>
  String(process.env.STORE_PRODUCTS_LEGACY_CATEGORY_FIELDS).toLowerCase() !==
  "false";

const buildProductCategoryFilter = (
  allCategoryIds,
  { includeLegacy = includeLegacyCategoryFields() } = {},
) => {
  const or = [{ "category._id": { $in: allCategoryIds } }];
  if (includeLegacy) {
    or.push({ subCategoryId: { $in: allCategoryIds } });
    or.push({ subSubCategoryId: { $in: allCategoryIds } });
  }
  return { $or: or };
};

// One batched query instead of one findById() per store category.
// Keeps the order of store.Category, keeps duplicates, skips missing categories
// (same as the old loop with `if (!category) continue`).
const loadCategoryTrees = async (CategoryModel, storeCategory) => {
  const rawIds = Array.isArray(storeCategory) ? storeCategory : [storeCategory];
  const wanted = rawIds.filter(
    (id) => id !== null && id !== undefined && id !== "",
  );

  const categoryTrees = [];
  const allCategoryIds = new Set();
  if (wanted.length === 0) {
    return { categoryTrees, allCategoryIds: [] };
  }

  const uniqueIds = [...new Set(wanted.map((id) => String(id)))];
  const docs = await CategoryModel.find({ _id: { $in: uniqueIds } }).lean();
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));

  for (const rawId of wanted) {
    const category = byId.get(String(rawId));
    if (!category) continue;

    categoryTrees.push(category);
    allCategoryIds.add(category._id.toString());

    for (const sub of category.subcat || []) {
      allCategoryIds.add(sub._id.toString());
      for (const subsub of sub.subsubcat || []) {
        allCategoryIds.add(subsub._id.toString());
      }
    }
  }

  return { categoryTrees, allCategoryIds: [...allCategoryIds] };
};

const stockKey = (productId, variantId) =>
  `${String(productId)}_${String(variantId)}`;

// Map keyed by productId_variantId holding the FULL stock entry.
// First entry wins, exactly like the old Array.prototype.find() did.
const buildStockMap = (stockEntries) => {
  const stockMap = new Map();
  for (const item of stockEntries || []) {
    const key = stockKey(item.productId, item.variantId);
    if (!stockMap.has(key)) stockMap.set(key, item);
  }
  return stockMap;
};

// Mutates products (they are lean objects) - same as before.
const applyStockToProducts = (products, stockEntries) => {
  const stockMap = buildStockMap(stockEntries);

  for (const product of products) {
    product.inventory = [];
    if (!Array.isArray(product.variants)) continue;

    for (const variant of product.variants) {
      const stockData = stockMap.get(stockKey(product._id, variant._id));
      const quantity = stockData?.quantity || 0;

      if (stockData?.price != null) variant.sell_price = stockData.price;
      if (stockData?.mrp != null) variant.mrp = stockData.mrp;

      product.inventory.push({ variantId: variant._id, quantity });
    }
  }
  return products;
};

// Tiny timer: collects durations in ms, logs one line when STORE_TIMING_LOGS=true.
const createTimer = (label) => {
  const enabled = String(process.env.STORE_TIMING_LOGS).toLowerCase() === "true";
  const t0 = process.hrtime.bigint();
  let last = t0;
  const steps = {};
  return {
    mark(name) {
      const now = process.hrtime.bigint();
      steps[name] = Number(now - last) / 1e6;
      last = now;
    },
    done(extra = {}) {
      steps.total = Number(process.hrtime.bigint() - t0) / 1e6;
      if (enabled) {
        const fmt = Object.entries(steps)
          .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
          .join(" ");
        const ex = Object.entries(extra)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        console.log(`[${label}] ${fmt} ${ex}`.trim());
      }
      return steps;
    },
  };
};

// Everything after the store lookup. Returns the same data the endpoint always returned.
const loadStoreCatalog = async ({
  store,
  storeId,
  CategoryModel,
  Products,
  Stock,
  timer,
}) => {
  const { categoryTrees, allCategoryIds } = await loadCategoryTrees(
    CategoryModel,
    store.Category,
  );
  timer?.mark("categories");

  // `inventory` is always overwritten below, so it is not worth transferring.
  const products = await Products.find(
    buildProductCategoryFilter(allCategoryIds),
  )
    .select({ inventory: 0 })
    .lean();
  timer?.mark("products");

  const storeStockDoc = await Stock.findOne({ storeId })
    .select({
      "stock.productId": 1,
      "stock.variantId": 1,
      "stock.quantity": 1,
      "stock.price": 1,
      "stock.mrp": 1,
    })
    .lean();
  const stockEntries = storeStockDoc?.stock || [];
  timer?.mark("stock");

  applyStockToProducts(products, stockEntries);
  timer?.mark("inventory");

  return { categories: categoryTrees, products, stockEntries };
};

module.exports = {
  buildProductCategoryFilter,
  loadCategoryTrees,
  buildStockMap,
  applyStockToProducts,
  createTimer,
  loadStoreCatalog,
};
