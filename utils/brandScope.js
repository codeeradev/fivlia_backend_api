// utils/brandScope.js
// Fast helpers for GET /getBrand.
//
// What was slow before (per request, x4 requests from the app):
//   1. global scope : Category.findById() inside a for-loop            (N+1 queries)
//   2. local scope  : loaded EVERY stock doc + EVERY full product doc just to read category ids
//   3. brand list   : loaded every product in scope just to read brand ids
//   4. nothing was cached, and 4 identical parallel calls did 4x the work
//
// What this file does:
//   - one batched query instead of N+1
//   - Stock.distinct / Products.distinct (DB does the work, tiny payload)
//   - Redis cache (falls back to in-memory if REDIS_URL is not set)
//   - in-flight de-duplication: parallel identical requests share ONE computation

const mongoose = require("mongoose");
const crypto = require("crypto");
const Store = require("../modals/store");
const Category = require("../modals/category");
const Stock = require("../modals/StoreStock");
const Products = require("../modals/Product");
const Brand = require("../modals/brand");
const { getStoresWithinRadius } = require("../config/google");
const { resolveUser } = require("./locationCategories");
const { resolveTypeScopeForLocation } = require("./typeScope");
const { getRedisClient } = require("./redisClient");

const SCOPE_TTL = 5 * 60; // seconds - category/brand scope of a set of stores
const LIST_TTL = 5 * 60; // seconds - final brand list
const LOCATION_TTL = 60; // seconds - lat/lng -> local stores (store open/close windows change)

/* ------------------------------------------------------------------ */
/* tiny cache: Redis first, in-memory fallback, in-flight de-dupe      */
/* ------------------------------------------------------------------ */
const memory = new Map(); // key -> { value, exp }
const inflight = new Map(); // key -> Promise
const MEMORY_MAX = 500;

const memGet = (key) => {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return hit.value;
};

const memSet = (key, value, ttlSec) => {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
  memory.set(key, { value, exp: Date.now() + ttlSec * 1000 });
};

// Redis must NEVER slow down or break the API. If Redis is down (ECONNREFUSED),
// node-redis keeps retrying forever and connect() never settles, so every Redis
// call is raced against a short timeout, and after a failure Redis is skipped
// for REDIS_COOLDOWN_MS (circuit breaker) -> the API just uses the in-memory cache.
const REDIS_TIMEOUT_MS = 250;
const REDIS_COOLDOWN_MS = 30 * 1000;
let redisSkipUntil = 0;

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("redis timeout")), ms)),
  ]);

async function safeRedis() {
  if (Date.now() < redisSkipUntil) return null;
  try {
    return await withTimeout(getRedisClient(), REDIS_TIMEOUT_MS);
  } catch (e) {
    redisSkipUntil = Date.now() + REDIS_COOLDOWN_MS;
    return null;
  }
}

async function cached(key, ttlSec, loader) {
  const fromMem = memGet(key);
  if (fromMem !== undefined) return fromMem;

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const redis = await safeRedis();
    if (redis) {
      try {
        const raw = await withTimeout(redis.get(key), REDIS_TIMEOUT_MS);
        if (raw) {
          const value = JSON.parse(raw);
          memSet(key, value, Math.min(ttlSec, 30));
          return value;
        }
      } catch (e) {
        redisSkipUntil = Date.now() + REDIS_COOLDOWN_MS;
      }
    }

    const value = await loader();

    memSet(key, value, ttlSec);
    if (redis && Date.now() >= redisSkipUntil) {
      try {
        await withTimeout(redis.set(key, JSON.stringify(value), { EX: ttlSec }), REDIS_TIMEOUT_MS);
      } catch (e) {
        redisSkipUntil = Date.now() + REDIS_COOLDOWN_MS;
      }
    }
    return value;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

const hashIds = (ids) =>
  crypto
    .createHash("md5")
    .update([...ids].map(String).sort().join(","))
    .digest("hex");

const toObjectIds = (ids) =>
  ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

/* ------------------------------------------------------------------ */
/* store scope                                                         */
/* ------------------------------------------------------------------ */

// GLOBAL: all categories of the open global stores  (1 + 1 queries, was 1 + N)
async function getGlobalScope() {
  return cached("brand:scope:global", SCOPE_TTL, async () => {
    const globalStores = await Store.find({ serviceScope: "global", status: true })
      .select("_id Category")
      .lean();

    const storeIds = globalStores.map((s) => s._id.toString());
    const mainCatIds = [
      ...new Set(
        globalStores
          .flatMap((s) => (Array.isArray(s.Category) ? s.Category : [s.Category]))
          .filter(Boolean)
          .map(String),
      ),
    ];

    const categories = mainCatIds.length
      ? await Category.find({ _id: { $in: toObjectIds(mainCatIds) } })
          .select("_id subcat._id subcat.subsubcat._id")
          .lean()
      : [];

    const categoryIds = new Set();
    for (const category of categories) {
      categoryIds.add(category._id.toString());
      for (const sub of category.subcat || []) {
        categoryIds.add(sub._id.toString());
        for (const subsub of sub.subsubcat || []) {
          categoryIds.add(subsub._id.toString());
        }
      }
    }

    return { scopeType: "global", storeIds, categoryIds: [...categoryIds] };
  });
}

// LOCAL: categories of products that have stock in the local stores
async function getLocalScope(localStoreIds) {
  return cached(`brand:scope:local:${hashIds(localStoreIds)}`, SCOPE_TTL, async () => {
    // DB returns only the distinct product ids (was: every stock document)
    const productIds = await Stock.distinct("stock.productId", {
      storeId: { $in: toObjectIds(localStoreIds) },
    });

    const categoryIds = new Set();
    if (productIds.length) {
      // only the 3 category fields (was: full product documents)
      const products = await Products.find({ _id: { $in: productIds } })
        .select("category subCategory subSubCategory")
        .lean();

      for (const p of products) {
        if (p.category?.[0]?._id) categoryIds.add(p.category[0]._id.toString());
        if (p.subCategory?.[0]?._id) categoryIds.add(p.subCategory[0]._id.toString());
        if (p.subSubCategory?.[0]?._id) categoryIds.add(p.subSubCategory[0]._id.toString());
      }
    }

    return { scopeType: "local", storeIds: localStoreIds, categoryIds: [...categoryIds] };
  });
}

// lat/lng -> ids of open local (zone) stores. Cached 60s per ~11 m grid cell.
async function getLocalStoreIds(lat, lng) {
  const key = `brand:loc:${lat.toFixed(4)}:${lng.toFixed(4)}`;
  return cached(key, LOCATION_TTL, async () => {
    const storeResult = await getStoresWithinRadius(lat, lng);
    // matchedStores = zone stores + open global stores; "local" means zone stores only
    return (storeResult?.matchedStores || [])
      .filter((s) => s.status === true && s.serviceScope !== "global")
      .map((s) => s._id.toString());
  });
}

// lat/lng + type -> { scope: "zone" | "global" | "none", storeIds, ... } | null
async function getTypeScope(lat, lng, typeId) {
  const key = `brand:typeloc:${typeId}:${lat.toFixed(4)}:${lng.toFixed(4)}`;
  return cached(key, LOCATION_TTL, () => resolveTypeScopeForLocation(lat, lng, typeId));
}

// Same contract as the old determineStoreScope(req): { scopeType, storeIds, categoryIds }
// typeId (optional): decide zone-vs-global for THAT type only, e.g. a zone grocery
// store must not turn the mall brands into zone brands.
async function determineStoreScope(req, typeId = null) {
  try {
    let userLat;
    let userLng;

    const qLat = parseFloat(req.query.lat ?? req.query.latitude);
    const qLng = parseFloat(req.query.lng ?? req.query.longitude);
    if (!isNaN(qLat) && !isNaN(qLng)) {
      userLat = qLat;
      userLng = qLng;
    } else {
      const user = await resolveUser(req);
      if (user?.location?.latitude && user?.location?.longitude) {
        userLat = parseFloat(user.location.latitude);
        userLng = parseFloat(user.location.longitude);
      }
    }

    if (!userLat || !userLng || isNaN(userLat) || isNaN(userLng)) {
      return await getGlobalScope();
    }

    if (typeId) {
      const typeScope = await getTypeScope(userLat, userLng, String(typeId));
      if (typeScope?.scope === "zone") return await getLocalScope(typeScope.storeIds);
      if (typeScope?.scope === "global") return await getGlobalScope();
      // "none" / nothing open -> old behaviour below
    }

    const localStoreIds = await getLocalStoreIds(userLat, userLng);
    if (localStoreIds.length > 0) return await getLocalScope(localStoreIds);

    return await getGlobalScope();
  } catch (error) {
    console.error("Error in determineStoreScope:", error);
    return { scopeType: "error", storeIds: [], categoryIds: [] };
  }
}

/* ------------------------------------------------------------------ */
/* brand list                                                          */
/* ------------------------------------------------------------------ */

// Returns { featuredBrands, allBrands } - cached per scope + typeId
async function getBrandList(storeScope, typeId) {
  const scopeKey = `${storeScope.scopeType}:${hashIds(storeScope.storeIds || [])}`;
  const key = `brand:list:${scopeKey}:${typeId || "all"}`;

  return cached(key, LIST_TTL, async () => {
    const brandFilter = {};
    if (typeId) brandFilter.typeId = new mongoose.Types.ObjectId(typeId);

    if (storeScope.categoryIds && storeScope.categoryIds.length > 0) {
      const categoryObjIds = toObjectIds(storeScope.categoryIds);

      // DB returns only distinct brand ids (was: every product document in scope)
      const brandIds = await Products.distinct("brand_Name._id", {
        $or: [
          { "category.0._id": { $in: categoryObjIds } },
          { "subCategory.0._id": { $in: categoryObjIds } },
          { "subSubCategory.0._id": { $in: categoryObjIds } },
        ],
        "brand_Name._id": { $exists: true, $ne: null },
      });

      if (brandIds.length === 0) return { featuredBrands: [], allBrands: [] };
      brandFilter._id = { $in: brandIds };
    }

    const allBrands = await Brand.find(brandFilter).sort({ createdAt: -1 }).lean();
    const featuredBrands = allBrands.filter(
      (b) => b.featured === true || b.featured === "true",
    );

    return { featuredBrands, allBrands };
  });
}

module.exports = { determineStoreScope, getBrandList };
