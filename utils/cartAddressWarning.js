const { Cart } = require("../modals/cart");
const Store = require("../modals/store");
const { ZoneData } = require("../modals/cityZone");
const { isWithinZone, getZoneWindowConfig } = require("../config/google");

const CART_ADDRESS_WARNING_MESSAGE =
  "Your cart has items from a local store that does not deliver to this address. " +
  "Continuing will empty your cart.";

const toCoord = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Is the point inside any active zone (same rule addCart uses)?
const isInsideAnyActiveZone = async (lat, lng) => {
  const [zoneDocs, zoneWindowConfig] = await Promise.all([
    ZoneData.find({}),
    getZoneWindowConfig(),
  ]);
  const activeZones = zoneDocs.flatMap((doc) =>
    (doc.zones || []).filter((z) => z.status === true),
  );
  return activeZones.some((zone) =>
    isWithinZone(lat, lng, zone, zoneWindowConfig),
  );
};

// Conflict = user has items from a LOCAL (zone) store in the cart and the
// location is now outside every active zone (global-only area).
// Reverse case (global cart -> zone) is intentionally not handled.
// Never throws: on any problem returns false so the calling API is unaffected.
const hasZoneToGlobalCartConflict = async (userId, latitude, longitude) => {
  try {
    const lat = toCoord(latitude);
    const lng = toCoord(longitude);
    if (!userId || lat === null || lng === null) return false;

    const cartItem = await Cart.findOne({ userId }).select("storeId").lean();
    if (!cartItem?.storeId) return false; // empty cart -> nothing to warn

    const store = await Store.findById(cartItem.storeId)
      .select("serviceScope")
      .lean();
    if (!store || store.serviceScope === "global") return false; // global cart is fine

    return !(await isInsideAnyActiveZone(lat, lng));
  } catch (err) {
    console.error("hasZoneToGlobalCartConflict error:", err.message);
    return false;
  }
};

// Object added to the address API responses. No product info, only a warning.
const buildCartWarning = async (userId, latitude, longitude) => {
  const show = await hasZoneToGlobalCartConflict(userId, latitude, longitude);
  return show
    ? {
        show: true,
        type: "zone_to_global",
        message: CART_ADDRESS_WARNING_MESSAGE,
        clearCartApi: "/clearCartOnAddressChange",
      }
    : { show: false };
};

// App re-sends the same request with confirmCartClear=true after the user taps OK
const isCartClearConfirmed = (req) => {
  const v = req?.body?.confirmCartClear;
  return v === true || v === "true";
};

const cartWarningBody = () => ({
  show: true,
  type: "zone_to_global",
  message: CART_ADDRESS_WARNING_MESSAGE,
});

module.exports = {
  isCartClearConfirmed,
  cartWarningBody,
  hasZoneToGlobalCartConflict,
  buildCartWarning,
  CART_ADDRESS_WARNING_MESSAGE,
};
