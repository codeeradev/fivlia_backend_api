// utils/globalStock.js
// Helpers for the GLOBAL (All India) store system only.
//
// Rule: a product that is served by a global store must have stock (> 0).
// Out-of-stock global products are hidden. Local / zone stores are NOT touched:
// every helper below only looks at stores whose serviceScope === "global".

const { isGlobalStore } = require("./globalDelivery");

const isInStock = (quantity) => Number(quantity) > 0;

// Set of store ids (strings) that are global, from the matchedStores array.
const getGlobalStoreIdSet = (stores = []) =>
  new Set(
    (Array.isArray(stores) ? stores : [])
      .filter((store) => isGlobalStore(store))
      .map((store) => String(store._id)),
  );

// Remove variant options that belong to a global store and have no stock.
// Options of local stores are returned untouched.
// storeMapById: { [storeId]: store }
const dropOutOfStockGlobalOptions = (options = [], storeMapById = {}) =>
  options.filter((option) => {
    const store = storeMapById[String(option.storeId)];
    return !isGlobalStore(store) || isInStock(option.quantity);
  });

module.exports = { isInStock, getGlobalStoreIdSet, dropOutOfStockGlobalOptions };
