// Zone-first rule for product lists, decided PER TYPE (food / grocery / mall):
//   - a type is "zone available" when an open zone store serves it (an
//     out-of-stock zone item still counts, see utils/typeScope.js)
//   - zone-available type  -> global products of that type are NOT shown
//   - other types          -> global products are shown
//   - one type never affects another: a grocery zone product must not hide
//     global mall products.
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

// List level.
//   getScope(item) -> "zone" | "global" | null
//   options (optional):
//     getType(item) -> typeId string. Items are grouped by type and the rule
//                      is applied inside each group.
//     zoneTypes     -> Set of typeIds served by a zone store (utils/typeScope
//                      getZoneTypeIds). A type is zone available when it is in
//                      this set OR the list itself has a zone item of that type.
//                      Pass null/undefined to use the list only.
//   Without options the whole list is one group (old behaviour).
const applyZonePriority = (items = [], getScope, options = {}) => {
  const { getType, zoneTypes } = options || {};
  const typeOf = (item) => (getType ? String(getType(item) || "") : "");

  const zoneTypesInList = new Set();
  items.forEach((item) => {
    if (getScope(item) === "zone") zoneTypesInList.add(typeOf(item));
  });

  return items.filter((item) => {
    if (getScope(item) !== "global") return true; // zone / unsold items stay
    const type = typeOf(item);
    const zoneAvailable =
      zoneTypesInList.has(type) || Boolean(type && zoneTypes && zoneTypes.has(type));
    return !zoneAvailable;
  });
};

module.exports = { getStoreScope, preferZoneOptions, applyZonePriority };
