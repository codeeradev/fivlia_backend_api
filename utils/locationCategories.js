// Global (All India) catalog scope for the mobile app.
//
// Rule:
//   * User is inside a city/zone that has an open local store -> NO filtering.
//     Every API behaves exactly as it does today.
//   * User is outside every zone (serviceMode === "global_only") -> only the
//     categories / brands of the open GLOBAL stores are shown.
//
// Safe by design: returns null (= "do not filter") when there is no token, no
// saved location, the user is not global-only, or anything throws.
const jwt = require("jsonwebtoken");
const User = require("../modals/User");
const Category = require("../modals/category");
const Products = require("../modals/Product");
const { getStoresWithinRadius } = require("../config/google");

// Same bearer-token parsing as verifyToken, but never rejects the request.
const getOptionalUser = async (req) => {
  try {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.jwtSecretKey);
    if (!decoded?._id) return null;
    return await User.findById(decoded._id).lean();
  } catch {
    return null;
  }
};

const storeMainCategoryIds = (store) => {
  const ids = new Set();
  (Array.isArray(store.Category)
    ? store.Category
    : store.Category
      ? [store.Category]
      : []
  ).forEach((id) => id && ids.add(id.toString()));
  if (!ids.size) {
    (store.sellerCategories || []).forEach((c) => {
      if (c?.categoryId) ids.add(c.categoryId.toString());
    });
  }
  return ids;
};

// Returns null  -> do not filter (old behaviour)
//         object -> { storeIds, mainCategoryIds, allCategoryIds } for a global-only user
const resolveGlobalOnlyScope = async (req) => {
  try {
    const user = await getOptionalUser(req);
    const lat = user?.location?.latitude;
    const lng = user?.location?.longitude;
    if (!lat || !lng) return null;

    const result = await getStoresWithinRadius(lat, lng);
    if (result?.serviceMode !== "global_only") return null;

    const globalStores = (result.matchedStores || []).filter(
      (s) => s.serviceScope === "global",
    );

    const main = new Set();
    globalStores.forEach((s) =>
      storeMainCategoryIds(s).forEach((id) => main.add(id)),
    );
    const mainCategoryIds = [...main];

    // Expand to sub / sub-sub categories (products are tagged at any level)
    const all = new Set(mainCategoryIds);
    if (mainCategoryIds.length) {
      const cats = await Category.find({ _id: { $in: mainCategoryIds } })
        .select("subcat")
        .lean();
      cats.forEach((cat) =>
        (cat.subcat || []).forEach((sub) => {
          if (sub?._id) all.add(sub._id.toString());
          (sub.subsubcat || []).forEach(
            (ss) => ss?._id && all.add(ss._id.toString()),
          );
        }),
      );
    }

    return {
      storeIds: globalStores.map((s) => s._id.toString()),
      mainCategoryIds,
      allCategoryIds: [...all],
    };
  } catch (err) {
    console.error("resolveGlobalOnlyScope failed, not filtering:", err.message);
    return null;
  }
};

// Brand ids that have at least one product in the global stores' categories
const getGlobalBrandIds = async (scope) => {
  if (!scope?.allCategoryIds?.length) return [];
  const ids = scope.allCategoryIds;
  const brandIds = await Products.distinct("brand_Name._id", {
    $or: [
      { "category._id": { $in: ids } },
      { "subCategory._id": { $in: ids } },
      { "subSubCategory._id": { $in: ids } },
    ],
  });
  return brandIds.filter(Boolean).map((id) => id.toString());
};

module.exports = { resolveGlobalOnlyScope, getGlobalBrandIds };
