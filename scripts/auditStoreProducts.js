// READ-ONLY audit for GET /getStore. Never writes, never drops/creates indexes.
// Usage (on the server, in /home/api/public_html):
//   node scripts/auditStoreProducts.js 684690fb58e40bfc67b22f67
require("dotenv").config();
const mongoose = require("mongoose");
const Store = require("../modals/store");
const Products = require("../modals/Product");
const CategoryModel = require("../modals/category");
const Stock = require("../modals/StoreStock");
const {
  loadCategoryTrees,
  buildProductCategoryFilter,
} = require("../utils/storeCatalog");

const MAX_MS = 5 * 60 * 1000;

const stages = (node, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (node.stage) out.push(node.stage + (node.indexName ? `(${node.indexName})` : ""));
  if (node.inputStage) stages(node.inputStage, out);
  (node.inputStages || []).forEach((s) => stages(s, out));
  if (node.queryPlan) stages(node.queryPlan, out);
  return out;
};
const summarize = (label, ex) => {
  const st = ex.executionStats || {};
  const plan = ex.queryPlanner?.winningPlan;
  console.log(`\n--- ${label}`);
  console.log({
    executionTimeMillis: st.executionTimeMillis,
    nReturned: st.nReturned,
    totalKeysExamined: st.totalKeysExamined,
    totalDocsExamined: st.totalDocsExamined,
    plan: stages(plan).join(" > "),
  });
};

(async () => {
  const storeId = process.argv[2];
  if (!storeId) throw new Error("pass a storeId");
  await mongoose.connect(process.env.MONGO_URI);

  const store = await Store.findById(storeId).lean();
  if (!store) throw new Error("store not found");
  const { categoryTrees, allCategoryIds } = await loadCategoryTrees(CategoryModel, store.Category);
  console.log("category trees:", categoryTrees.length, "| category ids:", allCategoryIds.length);

  console.log("\n=== Existing product indexes (read only)");
  console.log((await Products.collection.indexes()).map((i) => `${i.name}: ${JSON.stringify(i.key)}`).join("\n"));
  console.log("\n=== Existing stock indexes (read only)");
  console.log((await Stock.collection.indexes()).map((i) => `${i.name}: ${JSON.stringify(i.key)}`).join("\n"));

  console.log("\n=== Which fields do product documents REALLY contain?");
  const count = (f) => Products.collection.countDocuments(f, { maxTimeMS: MAX_MS });
  console.log("total products                      :", await count({}));
  console.log("docs with legacy subCategoryId      :", await count({ subCategoryId: { $exists: true } }));
  console.log("docs with legacy subSubCategoryId   :", await count({ subSubCategoryId: { $exists: true } }));
  console.log("docs with subCategory (array)       :", await count({ "subCategory.0": { $exists: true } }));
  console.log("docs with subSubCategory (array)    :", await count({ "subSubCategory.0": { $exists: true } }));

  // Use raw driver filters with ObjectIds for schema fields so counts are exact.
  const oids = allCategoryIds.map((i) => new mongoose.Types.ObjectId(i));
  console.log("\n=== Matches per branch for this store");
  const byCat = await count({ "category._id": { $in: oids } });
  const bySub = await count({ "subCategory._id": { $in: oids } });
  const bySubSub = await count({ "subSubCategory._id": { $in: oids } });
  const byLegacySub = await count({ subCategoryId: { $in: allCategoryIds } });
  const byLegacySubSub = await count({ subSubCategoryId: { $in: allCategoryIds } });
  console.log({ byCat, bySub, bySubSub, byLegacySub, byLegacySubSub });
  const onlySchemaSub = await count({
    "category._id": { $nin: oids },
    $or: [{ "subCategory._id": { $in: oids } }, { "subSubCategory._id": { $in: oids } }],
  });
  console.log("products matched ONLY via subCategory._id/subSubCategory._id (NOT returned by today's endpoint):", onlySchemaSub);

  const legacyFilter = buildProductCategoryFilter(allCategoryIds, { includeLegacy: true });
  const slimFilter = buildProductCategoryFilter(allCategoryIds, { includeLegacy: false });

  console.log("\n=== explain(executionStats) - this EXECUTES the queries (read only; the first can be slow)");
  summarize("CURRENT filter (3 branches)", await Products.find(legacyFilter).maxTimeMS(MAX_MS).explain("executionStats"));
  summarize("category._id only", await Products.find(slimFilter).maxTimeMS(MAX_MS).explain("executionStats"));
  summarize("stock findOne({storeId})", await Stock.findOne({ storeId }).maxTimeMS(MAX_MS).explain("executionStats"));

  console.log("\n=== Result-set equality (ids only)");
  const idsOf = async (f) => (await Products.find(f).select({ _id: 1 }).maxTimeMS(MAX_MS).lean()).map((d) => String(d._id));
  const a = await idsOf(legacyFilter);
  const b = await idsOf(slimFilter);
  const sa = new Set(a), sb = new Set(b);
  console.log({
    currentCount: a.length, currentUnique: sa.size,
    slimCount: b.length, slimUnique: sb.size,
    missingInSlim: [...sa].filter((x) => !sb.has(x)).length,
    extraInSlim: [...sb].filter((x) => !sa.has(x)).length,
  });
  console.log(
    "\nDECISION: STORE_PRODUCTS_LEGACY_CATEGORY_FIELDS=false is safe ONLY if both legacy-field counts above are 0 and missingInSlim is 0.",
  );
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
