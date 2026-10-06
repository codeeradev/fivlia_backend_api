// Shared helpers for Global (All India) store delivery.
// Used by getCart, placeOrder, getDeliveryEstimate and the product list APIs
// so every place calculates the same values.

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundCurrency = (value) =>
  Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;

// store.serviceScope -> "global" | "local"
const isGlobalStore = (store) => store?.serviceScope === "global";

const getDeliveryMode = (store) => (isGlobalStore(store) ? "global" : "local");

// Order / TempOrder / cart scope: "global" | "city" (missing = "city")
const getOrderScope = (store) => (isGlobalStore(store) ? "global" : "city");

// Normalise the 4 global settings (missing values fall back to defaults)
const getGlobalSettings = (settings = {}) => {
  const min = Math.max(0, toNumber(settings?.globalDeliveryDaysMin, 3));
  const maxRaw = Math.max(0, toNumber(settings?.globalDeliveryDaysMax, 5));
  return {
    shippingCharge: Math.max(0, toNumber(settings?.globalShippingCharge, 0)),
    freeShippingLimit: Math.max(0, toNumber(settings?.globalFreeShippingLimit, 0)),
    daysMin: min,
    daysMax: Math.max(min, maxRaw),
    codAllowed: settings?.globalCodAllowed === true,
  };
};

// Admin toggle: may customers pay Cash on Delivery on Global (All India) orders?
const isGlobalCodAllowed = (settings = {}) => settings?.globalCodAllowed === true;

// Flat shipping. This is the FINAL global delivery charge (admin setting
// "globalShippingCharge"): it never depends on the cart value and no free-shipping
// rule applies to global orders.
const computeGlobalShippingCharge = (itemsTotal, settings = {}) => {
  const g = getGlobalSettings(settings);
  return roundCurrency(g.shippingCharge);
};

// "3-5 days" or "3 days" when min === max
const formatGlobalDeliveryText = (settings = {}) => {
  const g = getGlobalSettings(settings);
  return g.daysMin === g.daysMax
    ? `${g.daysMin} days`
    : `${g.daysMin}-${g.daysMax} days`;
};

// One entry of the getDeliveryEstimate "filtered" array for a global store
const buildGlobalEstimateEntry = (store, settings = {}) => ({
  storeId: store._id,
  storeName: store.storeName,
  city: null,
  distance: "All India",
  duration: formatGlobalDeliveryText(settings),
  raw: { source: "global" },
});

// ---------------------------------------------------------------------------
// Admin settings: validation + defaults for the 4 global settings
// ---------------------------------------------------------------------------
const GLOBAL_NUMBER_KEYS = [
  "globalShippingCharge",
  "globalFreeShippingLimit",
  "globalDeliveryDaysMin",
  "globalDeliveryDaysMax",
];

const GLOBAL_BOOLEAN_KEYS = ["globalCodAllowed"];

const GLOBAL_SETTING_KEYS = [...GLOBAL_NUMBER_KEYS, ...GLOBAL_BOOLEAN_KEYS];

const GLOBAL_SETTING_DEFAULTS = {
  globalShippingCharge: 0,
  globalFreeShippingLimit: 0,
  globalDeliveryDaysMin: 3,
  globalDeliveryDaysMax: 5,
  globalCodAllowed: false,
};

const isBlank = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

// Returns { error } or { values } (only the keys that were sent).
// - every number must be >= 0 (days must be whole numbers)
// - globalDeliveryDaysMax >= globalDeliveryDaysMin (checked against the saved
//   value when only one of the two is sent)
// Blank values are treated as "not sent".
const validateGlobalSettings = (input = {}, current = {}) => {
  const values = {};

  for (const key of GLOBAL_BOOLEAN_KEYS) {
    const raw = input?.[key];
    if (isBlank(raw)) continue;

    if (raw === true || raw === "true") values[key] = true;
    else if (raw === false || raw === "false") values[key] = false;
    else return { error: `${key} must be true or false` };
  }

  for (const key of GLOBAL_NUMBER_KEYS) {
    const raw = input?.[key];
    if (isBlank(raw)) continue;

    if (typeof raw !== "number" && typeof raw !== "string") {
      return { error: `${key} must be a number` };
    }

    const num = typeof raw === "number" ? raw : Number(raw.trim());
    if (!Number.isFinite(num) || num < 0) {
      return { error: `${key} must be a number greater than or equal to 0` };
    }

    const isDayKey = key === "globalDeliveryDaysMin" || key === "globalDeliveryDaysMax";
    if (isDayKey && !Number.isInteger(num)) {
      return { error: `${key} must be a whole number of days` };
    }

    values[key] = num;
  }

  const daysSent =
    "globalDeliveryDaysMin" in values || "globalDeliveryDaysMax" in values;

  if (daysSent) {
    const min =
      values.globalDeliveryDaysMin ??
      toNumber(
        current?.globalDeliveryDaysMin,
        GLOBAL_SETTING_DEFAULTS.globalDeliveryDaysMin,
      );
    const max =
      values.globalDeliveryDaysMax ??
      toNumber(
        current?.globalDeliveryDaysMax,
        GLOBAL_SETTING_DEFAULTS.globalDeliveryDaysMax,
      );

    if (max < min) {
      return {
        error:
          "globalDeliveryDaysMax must be greater than or equal to globalDeliveryDaysMin",
      };
    }
  }

  return { values };
};

// Older settings documents do not have the new keys (lean() skips schema
// defaults), so API responses fill them in.
const withGlobalSettingDefaults = (settings = {}) => {
  const out = { ...settings };
  for (const key of GLOBAL_SETTING_KEYS) {
    if (out[key] === undefined || out[key] === null) {
      out[key] = GLOBAL_SETTING_DEFAULTS[key];
    }
  }
  return out;
};

module.exports = {
  GLOBAL_SETTING_KEYS,
  GLOBAL_SETTING_DEFAULTS,
  validateGlobalSettings,
  withGlobalSettingDefaults,
  buildGlobalEstimateEntry,
  isGlobalStore,
  getDeliveryMode,
  getOrderScope,
  getGlobalSettings,
  isGlobalCodAllowed,
  computeGlobalShippingCharge,
  formatGlobalDeliveryText
};
