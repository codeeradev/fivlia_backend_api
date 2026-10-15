// READ-ONLY: runs the ORIGINAL getStore logic and the OPTIMIZED one for the same store
// and compares products, categories, variants, inventory, prices and MRP.
// Usage: node scripts/compareGetStore.js 684690fb58e40bfc67b22f67
require("dotenv").config();
const mongoose = require("mongoose");
const Store = require("../modals/store");
const Products = require("../modals/Product");
const CategoryModel = require("../modals/category");
const Stock = require("../modals/StoreStock");
const { loadStoreCatalog } = require("../utils/storeCatalog");

// ---------- ORIGINAL implementation (verbatim logic from before the change) ----------
const original = async (store, id) => {
  const categoryIds = Array.isArray(store.Category) ? store.Category : [store.Category];
  const allCategoryTrees = [];
  const allCategoryIds = [];
  for (const catId of categoryIds) {
    const category = await CategoryModel.findById(catId).lean();
    if (!category) continue;
    allCategoryTrees.push(category);
    allCategoryIds.push(category._id.toString());
    (category.subcat || []).forEach((sub) => {
      allCategoryIds.push(sub._id.toString());
      (sub.subsubcat || []).forEach((ss) => allCategoryIds.push(ss._id.toString()));
    });
  }
  const products = await Products.find({
    $or: [
      { "category._id": { $in: allCategoryIds } },
      { subCategoryId: { $in: allCategoryIds } },
      { subSubCategoryId: { $in: allCategoryIds } },
    ],
  }).lean();
  const storeStockDoc = await Stock.findOne({ storeId: id }).lean();
  const stockEntries = storeStockDoc?.stock || [];
  for (const product of products) {
    product.inventory = [];
    if (Array.isArray(product.variants)) {
      for (const variant of product.variants) {
        const stockData = stockEntries.find(
          (item) =>
            item.productId.toString() === product._id.toString() &&
            item.variantId.toString() === variant._id.toString(),
        );
        const quantity = stockData?.quantity || 0;
        if (stockData?.price != null) variant.sell_price = stockData.price;
        if (stockData?.mrp != null) variant.mrp = stockData.mrp;
        product.inventory.push({ variantId: variant._id, quantity });
      }
    }
  }
  return { categories: allCategoryTrees, products };
};

// key-order independent stringify (the optimized query drops `inventory` from the projection,
// so that key is re-added at a different position; clients don't care about key order)
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    if (typeof v.toHexString === "function") return JSON.stringify(v.toHexString());
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
};
const norm = (docs) => new Map(docs.map((d) => [String(d._id), stable(d)]));

(async () => {
  const id = process.argv[2];
  await mongoose.connect(process.env.MONGO_URI);
  const store = await Store.findById(id).lean();
  if (!store) throw new Error("store not found");

  let t = Date.now();
  const a = await original(store, id);
  const tOld = Date.now() - t;
  t = Date.now();
  const b = await loadStoreCatalog({ store, storeId: id, CategoryModel, Products, Stock });
  const tNew = Date.now() - t;

  const ma = norm(a.products), mb = norm(b.products);
  const missing = [...ma.keys()].filter((k) => !mb.has(k));
  const extra = [...mb.keys()].filter((k) => !ma.has(k));
  const different = [...ma.keys()].filter((k) => mb.has(k) && ma.get(k) !== mb.get(k));
  const dupNew = b.products.length - mb.size;
  const dupOld = a.products.length - ma.size;
  const sameOrder = a.products.map((p) => String(p._id)).join() === b.products.map((p) => String(p._id)).join();

  console.log({
    originalMs: tOld, optimizedMs: tNew,
    productsOriginal: a.products.length, productsOptimized: b.products.length,
    missing: missing.length, extra: extra.length, differentContent: different.length,
    duplicatesOriginal: dupOld, duplicatesOptimized: dupNew, sameOrder,
    categoriesIdentical: stable(a.categories) === stable(b.categories),
  });
  if (different.length) console.log("first differing product id:", different[0]);
  const ok = !missing.length && !extra.length && !different.length && !dupNew;
  console.log(ok ? "RESULT: IDENTICAL (ignoring order)" : "RESULT: MISMATCH - do not deploy");
  await mongoose.disconnect();
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
