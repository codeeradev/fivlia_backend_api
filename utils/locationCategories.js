// utils/locationDelivery.js
// Shared helper: resolves the user's CURRENT location per request and decides
// each store's deliveryMode ("local" | "global"), hiding local stores outside the zone.
// Existing response shape is unchanged; only `deliveryMode` is added.

const mongoose = require("mongoose");

// ---- ADJUST THESE 3 THINGS TO YOUR PROJECT -------------------------------
// 1) Where getStoresWithinRadius lives (it is already used in POST /address)
const { getStoresWithinRadius } = require("./locationCategories"); // <-- change path if different
// 2) Your User model path
const User = require("../modals/User"); // <-- change path/name if different
// 3) How a store is marked as global
const isGlobalStore = (store) =>
  store?.isGlobal === true ||
  store?.deliveryScope === "global" ||
  store?.storeType === "global";
// --------------------------------------------------------------------------

const GLOBAL_DISTANCE = 999999;

// Priority: query params (selected address in app) -> saved user location.
async function resolveLocation(req) {
  const lat = parseFloat(req.query?.latitude ?? req.query?.lat);
  const lng = parseFloat(req.query?.longitude ?? req.query?.lng ?? req.query?.long);
  if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };

  const userId = req.user?._id || req.user?.id || req.userId;
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    try {
      const user = await User.findById(userId).select("location latitude longitude").lean();
      const l = user?.location || user;
      const ulat = parseFloat(l?.latitude);
      const ulng = parseFloat(l?.longitude);
      if (!isNaN(ulat) && !isNaN(ulng)) return { lat: ulat, lng: ulng };
    } catch (e) {
      console.error("resolveLocation error:", e.message);
    }
  }
  return null;
}

// Call ONCE per request, before building variantOptions.
async function getLocationContext(req) {
  const loc = await resolveLocation(req);
  let localIds = new Set();
  if (loc) {
    try {
      const stores = await getStoresWithinRadius(loc.lat, loc.lng);
      localIds = new Set(
        (stores || []).filter((s) => !isGlobalStore(s)).map((s) => String(s._id))
      );
    } catch (e) {
      console.error("getLocationContext error:", e.message);
    }
  }
  return { loc, localIds };
}

// Returns "global" | "local" | null (null = hide this store for this location)
function getDeliveryMode(store, ctx) {
  if (isGlobalStore(store)) return "global";
  if (!ctx || !ctx.loc) return "local"; // location unknown: keep old behaviour
  return ctx.localIds.has(String(store._id)) ? "local" : null;
}

// Convenience: returns the extra keys to spread into a variantOption,
// or null if the store must be skipped.
function deliveryFields(store, ctx, localDistance) {
  const mode = getDeliveryMode(store, ctx);
  if (!mode) return null;
  return {
    deliveryMode: mode,
    distance: mode === "global" ? GLOBAL_DISTANCE : localDistance,
  };
}

module.exports = {
  resolveLocation,
  getLocationContext,
  getDeliveryMode,
  deliveryFields,
  isGlobalStore,
  GLOBAL_DISTANCE,
};
