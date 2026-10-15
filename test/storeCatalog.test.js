const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProductCategoryFilter,
  loadCategoryTrees,
  applyStockToProducts,
} = require("../utils/storeCatalog");

// ---- reference = the ORIGINAL inline logic from getStore (before optimisation) ----
const legacyApplyStock = (products, stockEntries) => {
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
  return products;
};

const legacyCategories = async (Model, storeCategory) => {
  const categoryIds = Array.isArray(storeCategory) ? storeCategory : [storeCategory];
  const trees = [];
  const ids = [];
  for (const catId of categoryIds) {
    const category = await Model.findById(catId).lean();
    if (!category) continue;
    trees.push(category);
    ids.push(category._id.toString());
    (category.subcat || []).forEach((sub) => {
      ids.push(sub._id.toString());
      (sub.subsubcat || []).forEach((ss) => ids.push(ss._id.toString()));
    });
  }
  return { trees, ids };
};

const clone = (o) => JSON.parse(JSON.stringify(o));

test("applyStockToProducts matches the old find()-based logic", () => {
  const products = [
    { _id: "p1", variants: [{ _id: "v1", sell_price: 10, mrp: 12 }, { _id: "v2", sell_price: 20, mrp: 25 }] },
    { _id: "p2", variants: [{ _id: "v3", sell_price: 5, mrp: 6 }] },
    { _id: "p3" },                       // no variants
    { _id: "p4", variants: [] },         // empty variants
    { _id: "p5", variants: [{ _id: "v9", sell_price: 1, mrp: 2 }] }, // no stock at all
  ];
  const stock = [
    { productId: "p1", variantId: "v1", quantity: 7, price: 11, mrp: 13 },
    { productId: "p1", variantId: "v1", quantity: 99, price: 1, mrp: 1 }, // duplicate: first must win
    { productId: "p1", variantId: "v2", quantity: 0, price: 0, mrp: 0 },  // zero qty, zero price (!= null)
    { productId: "p2", variantId: "v3" },                                 // entry without qty/price/mrp
    { productId: "pX", variantId: "v1", quantity: 5 },                    // other product, same variant id
  ];
  const a = legacyApplyStock(clone(products), stock);
  const b = applyStockToProducts(clone(products), stock);
  assert.deepEqual(b, a);
  assert.equal(b[0].inventory[0].quantity, 7);
  assert.equal(b[0].variants[1].sell_price, 0);
});

test("applyStockToProducts handles ObjectId-like values via toString", () => {
  const oid = (s) => ({ toString: () => s });
  const products = [{ _id: oid("p1"), variants: [{ _id: oid("v1"), sell_price: 1, mrp: 2 }] }];
  const stock = [{ productId: oid("p1"), variantId: oid("v1"), quantity: 3, price: 9, mrp: 10 }];
  const out = applyStockToProducts(products, stock);
  assert.equal(out[0].inventory[0].quantity, 3);
  assert.equal(out[0].variants[0].sell_price, 9);
  assert.equal(out[0].variants[0].mrp, 10);
});

const CATS = [
  { _id: "c1", name: "A", subcat: [{ _id: "s1", subsubcat: [{ _id: "ss1" }, { _id: "ss2" }] }, { _id: "s2" }] },
  { _id: "c2", name: "B" }, // no subcat
  { _id: "c3", name: "C", subcat: [{ _id: "s3", subsubcat: [{ _id: "ss3" }] }] },
];
const fakeModel = {
  calls: 0,
  findById(id) { this.calls++; return { lean: async () => CATS.find((c) => c._id === id) || null }; },
  find(q) { this.calls++; const set = new Set(q._id.$in); return { lean: async () => CATS.filter((c) => set.has(c._id)) }; },
};

test("loadCategoryTrees == old loop, in ONE query, order/duplicates/missing preserved", async () => {
  for (const input of [["c3", "c1"], ["c1", "nope", "c2", "c1"], "c2", [undefined], [], undefined]) {
    fakeModel.calls = 0;
    const old = await legacyCategories(fakeModel, input);
    const oldCalls = fakeModel.calls;
    fakeModel.calls = 0;
    const neu = await loadCategoryTrees(fakeModel, input);
    assert.deepEqual(neu.categoryTrees, old.trees, JSON.stringify(input));
    assert.deepEqual([...neu.allCategoryIds].sort(), [...new Set(old.ids)].sort(), JSON.stringify(input));
    assert.ok(fakeModel.calls <= 1, "must use at most one DB call");
    assert.ok(oldCalls >= fakeModel.calls);
  }
});

test("buildProductCategoryFilter: default keeps the exact original 3 branches", () => {
  const ids = ["a", "b"];
  assert.deepEqual(buildProductCategoryFilter(ids, { includeLegacy: true }), {
    $or: [
      { "category._id": { $in: ids } },
      { subCategoryId: { $in: ids } },
      { subSubCategoryId: { $in: ids } },
    ],
  });
  assert.deepEqual(buildProductCategoryFilter(ids, { includeLegacy: false }), {
    $or: [{ "category._id": { $in: ids } }],
  });
  delete process.env.STORE_PRODUCTS_LEGACY_CATEGORY_FIELDS;
  assert.equal(buildProductCategoryFilter(ids).$or.length, 3);
  process.env.STORE_PRODUCTS_LEGACY_CATEGORY_FIELDS = "false";
  assert.equal(buildProductCategoryFilter(ids).$or.length, 1);
  delete process.env.STORE_PRODUCTS_LEGACY_CATEGORY_FIELDS;
});
