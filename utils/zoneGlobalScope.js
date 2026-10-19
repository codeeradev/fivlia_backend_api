// Zone-first rule for product lists:
//   - a product that is sold by a zone (local) store is served by the zone store
//   - if the list has at least one zone product (even when it is out of stock),
//     global (All India) products are NOT shown
//   - if the list has no zone product at all, the global products are shown
const { isGlobalStore } = require("./globalDelivery");

// "zone" | "global" | null
const getStoreScope = (store) => {
  if (!store) return null;
  return isGlobalStore(store) ? "global" : "zone";
};

// Options of one product (each has storeId): when the product is sold by a
// zone store, drop its global options. storeMapById: { [storeId]: store }
const preferZoneOptions = (options = [], storeMapById = {}) => {
  const zoneOptions = options.filter(
    (option) => getStoreScope(storeMapById[String(option.storeId)]) === "zone",
  );
  return zoneOptions.length ? zoneOptions : options;
};

// List level: getScope(item) must return "zone" | "global" | null
const applyZonePriority = (items = [], getScope) => {
  const hasZoneItem = items.some((item) => getScope(item) === "zone");
  return hasZoneItem
    ? items.filter((item) => getScope(item) !== "global")
    : items;
};

module.exports = { getStoreScope, preferZoneOptions, applyZonePriority };
