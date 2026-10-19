// utils/typeScope.js
// ---------------------------------------------------------------------------
// ONE rule for every type (food / grocery / mall), used by the category,
// brand and product APIs:
//
//   - a type is "zone"   when at least one OPEN zone (local) store serves it
//                        -> only the zone stores' categories / products are shown
//   - a type is "global" when no open zone store serves it
//                        -> only the global (All India) stores' categories /
//                           products are shown
//   - a type is "none"   when nobody serves it
//
// "Serves" means:
//   zone store   : it has at least ONE stock row of that type, EVEN IF the
//                  quantity is 0 (out-of-stock zone items still count as a zone
//                  seller, so global items are never mixed in).
//   global store : it has at least one IN-STOCK product of that type.
//   A zone store with `typeId` saved serves only its own type.
//
// Pure functions (no DB) are exported for tests:
//   buildTypeScope, collectZoneTypeIds, storeServesType, storeCategoryIds
// DB helpers:
//   loadStoreTypeIndex, getZoneTypeIds, resolveTypeScope,
//   resolveTypeScopeForLocation
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const { normalizeTypeId } = require("./productTypeFilter");
const { isGlobalStore } = require("./globalDelivery");

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const INDEX_TTL_MS = 60 * 1000; // stock-type index cache (per set of stores)

const toIdString = (v) => (v ? String(v._id || v) : "");

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

// Main category ids of a store (store.Category + seller categories)
const storeCategoryIds = (store) => {
  const ids = new Set();
  const list = Array.isArray(store?.Category)
    ? store.Category
    : store?.Category
      ? [store.Category]
      : [];
  list.forEach((id) => ids.add(toIdString(id)));
  (store?.sellerCategories || []).forEach(
    (c) => c?.categoryId && ids.add(toIdString(c.categoryId)),
  );
  ids.delete("");
  return [...ids];
};

// index: Map<storeId, { any:Set<typeId>, inStock:Set<typeId> }>
const storeServesType = (store, typeId, index) => {
  const type = normalizeTypeId(typeId);
  if (!store || !type || !index) return false;
  const entry = index.get(String(store._id));
  if (!entry) return false;

  if (isGlobalStore(store)) return entry.inStock.has(type);

  const ownType = normalizeTypeId(store.typeId);
  if (ownType && ownType !== type) return false;
  return entry.any.has(type);
};

// -> { typeId, scope: "zone" | "global" | "none", storeIds, categoryIds }
const buildTypeScope = ({ matchedStores = [], index, typeId }) => {
  const type = normalizeTypeId(typeId);
  const zoneStores = [];
  const globalStores = [];

  for (const store of matchedStores) {
    if (!storeServesType(store, type, index)) continue;
    (isGlobalStore(store) ? globalStores : zoneStores).push(store);
  }

  const chosen = zoneStores.length ? zoneStores : globalStores;
  const scope = zoneStores.length ? "zone" : globalStores.length ? "global" : "none";

  const categoryIds = new Set();
  chosen.forEach((store) =>
    storeCategoryIds(store).forEach((id) => categoryIds.add(id)),
  );

  return {
    typeId: type,
    scope,
    storeIds: chosen.map((s) => String(s._id)),
    categoryIds: [...categoryIds],
  };
};

// Set of typeIds that have at least one open zone store serving them
const collectZoneTypeIds = (matchedStores = [], index) => {
  const out = new Set();
  if (!index) return out;
  for (const store of matchedStores) {
    if (isGlobalStore(store)) continue;
    const entry = index.get(String(store._id));
    if (!entry) continue;
    const ownType = normalizeTypeId(store.typeId);
    entry.any.forEach((type) => {
      if (!ownType || ownType === type) out.add(type);
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// DB: which types does each store really sell?  (cached 60s per store set)
// ---------------------------------------------------------------------------
const indexCache = new Map(); // key -> { promise, exp }

const buildIndexFromDb = async (storeIds) => {
  // lazy requires: keep the pure helpers loadable without mongoose
  const Stock = require("../modals/StoreStock");
  const Products = require("../modals/Product");
  const Category = require("../modals/category");

  const stockDocs = await Stock.find({ storeId: { $in: storeIds } })
    .select("storeId stock.productId stock.quantity")
    .lean();

  const anyByStore = new Map(); // storeId -> Set(productId)
  const inStockByStore = new Map();
  const allProductIds = new Set();

  for (const doc of stockDocs) {
    const storeKey = String(doc.storeId);
    for (const item of doc.stock || []) {
      if (!item?.productId) continue;
      const productKey = String(item.productId);
      allProductIds.add(productKey);
      if (!anyByStore.has(storeKey)) anyByStore.set(storeKey, new Set());
      anyByStore.get(storeKey).add(productKey);
      if (Number(item.quantity) > 0) {
        if (!inStockByStore.has(storeKey)) inStockByStore.set(storeKey, new Set());
        inStockByStore.get(storeKey).add(productKey);
      }
    }
  }

  const productDocs = allProductIds.size
    ? await Products.find({ _id: { $in: [...allProductIds] }, status: { $ne: false } })
        .select("_id typeId category")
        .lean()
    : [];

  // products saved without typeId -> type of their category
  const categoryIds = [
    ...new Set(
      productDocs
        .filter((p) => !normalizeTypeId(p.typeId))
        .flatMap((p) => (p.category || []).map((c) => String(c?._id)))
        .filter((id) => OBJECT_ID_REGEX.test(id)),
    ),
  ];
  const categoryTypeMap = new Map();
  if (categoryIds.length) {
    const cats = await Category.find({ _id: { $in: categoryIds } })
      .select("_id typeId")
      .lean();
    cats.forEach((c) => categoryTypeMap.set(String(c._id), normalizeTypeId(c.typeId)));
  }

  const productTypeMap = new Map();
  for (const p of productDocs) {
    let type = normalizeTypeId(p.typeId);
    if (!type) {
      for (const c of p.category || []) {
        const t = categoryTypeMap.get(String(c?._id));
        if (t) {
          type = t;
          break;
        }
      }
    }
    if (type) productTypeMap.set(String(p._id), type);
  }

  const toTypes = (productSet) => {
    const types = new Set();
    (productSet || new Set()).forEach((pid) => {
      const t = productTypeMap.get(pid);
      if (t) types.add(t);
    });
    return types;
  };

  const index = new Map();
  storeIds.forEach((storeId) => {
    index.set(String(storeId), {
      any: toTypes(anyByStore.get(String(storeId))),
      inStock: toTypes(inStockByStore.get(String(storeId))),
    });
  });
  return index;
};

const loadStoreTypeIndex = async (stores = []) => {
  const ids = [...new Set(stores.map((s) => String(s._id)).filter(Boolean))].sort();
  if (!ids.length) return new Map();

  const key = crypto.createHash("md5").update(ids.join(",")).digest("hex");
  const hit = indexCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.promise;

  if (indexCache.size > 200) indexCache.delete(indexCache.keys().next().value);

  const promise = buildIndexFromDb(ids);
  indexCache.set(key, { promise, exp: Date.now() + INDEX_TTL_MS });
  promise.catch(() => indexCache.delete(key)); // never cache a failure
  return promise;
};

// Set of typeIds that are served by a zone store (for the product APIs).
// Returns null on error so callers fall back to the list-based rule.
const getZoneTypeIds = async (matchedStores = []) => {
  try {
    const local = matchedStores.filter((s) => !isGlobalStore(s));
    if (!local.length) return new Set();
    const index = await loadStoreTypeIndex(local);
    return collectZoneTypeIds(local, index);
  } catch (e) {
    console.error("getZoneTypeIds error:", e.message);
    return null;
  }
};

// ---------------------------------------------------------------------------
// DB: scope of ONE type for a location
// ---------------------------------------------------------------------------

// null -> nothing is open at this location -> caller keeps the old behaviour
const resolveTypeScopeForLocation = async (lat, lng, typeId) => {
  const { getStoresWithinRadius } = require("../config/google"); // lazy: avoids circular load
  const result = await getStoresWithinRadius(lat, lng);
  const matchedStores = result?.matchedStores || [];
  if (!matchedStores.length) return null;

  const index = await loadStoreTypeIndex(matchedStores);
  return {
    ...buildTypeScope({ matchedStores, index, typeId }),
    serviceMode: result.serviceMode,
    insideZone: result.insideZone,
  };
};

// Same coordinate rules as resolveGlobalOnlyScope:
//   1) ?latitude=&longitude= (or lat/lng)  2) location saved on the user
// null  -> no filtering (guest without location, nothing open, any error)
const resolveTypeScope = async (req, typeId) => {
  const type = normalizeTypeId(typeId);
  const debug = (msg) => {
    req.globalScopeDebug = msg;
    return null;
  };
  if (!type) return debug("no typeId -> type scope skipped");

  try {
    let lat = parseFloat(req.query?.latitude ?? req.query?.lat);
    let lng = parseFloat(req.query?.longitude ?? req.query?.lng ?? req.query?.long);
    let source = "query";

    if (isNaN(lat) || isNaN(lng)) {
      const { resolveUser } = require("./locationCategories");
      const user = await resolveUser(req);
      if (!user) return debug("no valid token and no lat/lng in query -> filter skipped");
      lat = parseFloat(user.location?.latitude);
      lng = parseFloat(user.location?.longitude);
      source = "saved user location";
      if (isNaN(lat) || isNaN(lng)) return debug("user has no saved location -> filter skipped");
    }

    const scope = await resolveTypeScopeForLocation(lat, lng, type);
    if (!scope) return debug(`${source} (${lat}, ${lng}): nothing open -> filter skipped`);

    req.globalScopeDebug =
      `${source} (${lat}, ${lng}) type=${type}: scope=${scope.scope} ` +
      `serviceMode=${scope.serviceMode} stores=${scope.storeIds.length} ` +
      `categories=${scope.categoryIds.length}`;
    return scope;
  } catch (e) {
    console.error("resolveTypeScope error:", e.message);
    return debug("error: " + e.message + " -> filter skipped");
  }
};

module.exports = {
  // pure
  storeCategoryIds,
  storeServesType,
  buildTypeScope,
  collectZoneTypeIds,
  // db
  loadStoreTypeIndex,
  getZoneTypeIds,
  resolveTypeScopeForLocation,
  resolveTypeScope,
};
