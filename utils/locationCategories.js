// utils/locationCategories.js
// Global-only scope helpers used by categorycontroler.js
// (getMainCategory, getCategory, getBrand) and scripts/check_global_scope.js.
//
// resolveGlobalOnlyScope(req)
//   -> null                       : normal user (city/zone/mixed) -> NO filtering, old behaviour
//   -> { mainCategoryIds, storeIds } : user is in "global_only" mode -> show only the
//                                      categories of the open global stores
//
// getGlobalBrandIds(scope) -> [brandId strings] that have products in those categories.

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../modals/User");
const Products = require("../modals/Product");

const toIdString = (v) => (v ? String(v._id || v) : "");

// Who is calling? /getMainCategory has no verifyToken, so decode the token here.
async function resolveUser(req) {
  if (req.user && (req.user._id || req.user.id)) {
    // verifyToken already ran; make sure we have the location field
    if (req.user.location) return req.user;
    return User.findById(req.user._id || req.user.id).lean();
  }

  const token = req.headers?.authorization?.split(" ")[1];
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, process.env.jwtSecretKey);
    if (!decoded?._id || !mongoose.Types.ObjectId.isValid(decoded._id)) return null;
    return await User.findById(decoded._id).lean();
  } catch (e) {
    return null; // bad/expired token -> treat as guest
  }
}

async function resolveGlobalOnlyScope(req) {
  const debug = (msg) => {
    req.globalScopeDebug = msg;
    return null;
  };

  try {
    const user = await resolveUser(req);
    if (!user) return debug("no valid token -> filter skipped");

    const lat = user.location?.latitude;
    const lng = user.location?.longitude;
    if (!lat || !lng) return debug("user has no saved location -> filter skipped");

    // lazy require: avoids circular-dependency problems at load time
    const { getStoresWithinRadius } = require("../config/google");
    const result = await getStoresWithinRadius(lat, lng);

    if (result.serviceMode !== "global_only") {
      return debug(`serviceMode=${result.serviceMode} -> filter only applies to global_only`);
    }

    const globalStores = (result.matchedStores || []).filter(
      (s) => s.serviceScope === "global" && s.status === true
    );

    const ids = new Set();
    for (const s of globalStores) {
      (s.Category || []).forEach((id) => ids.add(toIdString(id)));
      (s.sellerCategories || []).forEach((c) => c?.categoryId && ids.add(toIdString(c.categoryId)));
    }
    ids.delete("");

    req.globalScopeDebug = `global_only: ${globalStores.length} global store(s), ${ids.size} categor(ies)`;
    return {
      mainCategoryIds: [...ids],
      storeIds: globalStores.map((s) => String(s._id)),
    };
  } catch (e) {
    console.error("resolveGlobalOnlyScope error:", e.message);
    return debug("error: " + e.message + " -> filter skipped");
  }
}

// Brands that have at least one product in the global stores' categories.
async function getGlobalBrandIds(scope) {
  if (!scope?.mainCategoryIds?.length) return [];

  const categoryObjectIds = scope.mainCategoryIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const brandIds = await Products.distinct("brand_Name._id", {
    "category._id": { $in: categoryObjectIds },
    "brand_Name._id": { $exists: true, $ne: null },
  });

  return brandIds.map(String);
}

module.exports = { resolveGlobalOnlyScope, getGlobalBrandIds };
