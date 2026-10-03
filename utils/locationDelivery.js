// utils/locationDelivery.js
// (This is the code that was wrongly saved inside utils/locationCategories.js.
//  Nothing in the project imports it right now. Keep it here if you plan to use it.)
// Shared helper: resolves the user's CURRENT location per request and decides
// each store's deliveryMode ("local" | "global"), hiding local stores outside the zone.

const mongoose = require("mongoose");
const { getStoresWithinRadius } = require("../config/google"); // fixed: was "./locationCategories" (self-import)
const User = require("../modals/User");

const isGlobalStore = (store) =>
  store?.isGlobal === true ||
  store?.serviceScope === "global" ||
  store?.deliveryScope === "global" ||
  store?.storeType === "global";

const GLOBAL_DISTANCE = 999999;

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

async function getLocationContext(req) {
  const loc = await resolveLocation(req);
  let localIds = new Set();
  if (loc) {
    try {
      const r = await getStoresWithinRadius(loc.lat, loc.lng);
      localIds = new Set(
        (r?.matchedStores || []).filter((s) => !isGlobalStore(s)).map((s) => String(s._id))
      );
    } catch (e) {
      console.error("getLocationContext error:", e.message);
    }
  }
  return { loc, localIds };
}

function getDeliveryMode(store, ctx) {
  if (isGlobalStore(store)) return "global";
  if (!ctx || !ctx.loc) return "local";
  return ctx.localIds.has(String(store._id)) ? "local" : null;
}

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
  GLOBAL_DISTANCE
};
