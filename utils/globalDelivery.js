// One PIN-code rule is used by cart, order validation and delivery estimates.
const isGlobalStore = (store) => store?.serviceScope === "global";
const getDeliveryMode = (store) => (isGlobalStore(store) ? "global" : "local");
const getOrderScope = (store) => (isGlobalStore(store) ? "global" : "city");
const normalizePincode = (value) => String(value ?? "").trim();
const getGlobalSettings = (settings = {}, pincode) => {
  const pin = normalizePincode(pincode);
  if (!/^[1-9][0-9]{5}$/.test(pin)) return null;
  return (
    settings?.globalDeliveryRules?.find((rule) => rule.pincode === pin) || null
  );
};
// The website may use the admin default when no exact PIN rule exists.
// Mobile/app callers continue using getGlobalSettings and exact rules only.
const getWebsiteGlobalSettings = (settings = {}, pincode) => {
  const pin = normalizePincode(pincode);
  if (!/^[1-9][0-9]{5}$/.test(pin)) return null;
  const exactRule = getGlobalSettings(settings, pin);
  if (exactRule) return { ...exactRule, source: "pincode" };
  const defaults = settings?.globalDeliveryDefaults;
  if (!defaults) return null;
  return { ...defaults, pincode: pin, source: "default" };
};
const isGlobalCodAllowed = (settings, pincode, ruleOverride) =>
  (ruleOverride === undefined ? getGlobalSettings(settings, pincode) : ruleOverride)
    ?.codAllowed === true;
const computeGlobalShippingCharge = (itemsTotal, settings, pincode, ruleOverride) => {
  const rule = ruleOverride === undefined
    ? getGlobalSettings(settings, pincode)
    : ruleOverride;
  if (!rule)
    throw new Error("Global delivery is not available for this PIN code.");
  return Math.round((Number(rule.shippingCharge) + Number.EPSILON) * 100) / 100;
};
const formatGlobalDeliveryText = (settings, pincode, ruleOverride) => {
  const rule = ruleOverride === undefined
    ? getGlobalSettings(settings, pincode)
    : ruleOverride;
  if (!rule) return null;
  return rule.daysMin === rule.daysMax
    ? `${rule.daysMin} days`
    : `${rule.daysMin}-${rule.daysMax} days`;
};
const buildGlobalEstimateEntry = (store, settings, pincode) => {
  if (!getGlobalSettings(settings, pincode)) return null;
  return {
    storeId: store._id,
    storeName: store.storeName,
    city: null,
    distance: "All India",
    duration: formatGlobalDeliveryText(settings, pincode),
    raw: { source: "global" },
  };
};
const buildWebsiteGlobalEstimateEntry = (store, settings, pincode) => {
  const rule = getWebsiteGlobalSettings(settings, pincode);
  if (!rule) return null;
  return {
    storeId: store._id,
    storeName: store.storeName,
    city: null,
    distance: "All India",
    duration: formatGlobalDeliveryText(settings, pincode, rule),
    raw: { source: "global", deliveryRuleSource: rule.source },
  };
};
// Ignore retired fields from old clients and omit them from API responses.
const LEGACY_KEYS = [
  "globalShippingCharge",
  "globalFreeShippingLimit",
  "globalDeliveryDaysMin",
  "globalDeliveryDaysMax",
  "globalCodAllowed",
];
const GLOBAL_SETTING_KEYS = ["globalDeliveryRules", "globalDeliveryDefaults", ...LEGACY_KEYS];
const GLOBAL_SETTING_DEFAULTS = { globalDeliveryRules: [], globalDeliveryDefaults: null };
const validateGlobalSettings = (input = {}) => {
  const values = {};
  if ("globalDeliveryRules" in input) {
    if (!Array.isArray(input.globalDeliveryRules))
      return { error: "globalDeliveryRules must be a list" };
    const seen = new Set();
    const rules = [];
    for (const raw of input.globalDeliveryRules) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { error: "Each delivery rule must be an object" };
      const pincode = normalizePincode(raw.pincode);
      if (!/^[1-9][0-9]{5}$/.test(pincode))
        return { error: "Enter a valid six-digit PIN code" };
      if (seen.has(pincode)) return { error: `Duplicate PIN code: ${pincode}` };
      seen.add(pincode);
      const rule = { pincode };
      for (const key of ["shippingCharge", "daysMin", "daysMax"]) {
        const value = raw[key];
        if (
          !["number", "string"].includes(typeof value) ||
          String(value).trim() === "" ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0
        ) {
          return { error: `${pincode}: ${key} must be a non-negative number` };
        }
        rule[key] = Number(value);
        if (key !== "shippingCharge" && !Number.isInteger(rule[key]))
          return { error: `${pincode}: delivery days must be whole numbers` };
      }
      if (rule.daysMax < rule.daysMin)
        return {
          error: `${pincode}: maximum days must be at least minimum days`,
        };
      if (typeof raw.codAllowed !== "boolean")
        return { error: `${pincode}: codAllowed must be true or false` };
      rule.codAllowed = raw.codAllowed;
      rules.push(rule);
    }
    values.globalDeliveryRules = rules;
  }

  if ("globalDeliveryDefaults" in input) {
    const raw = input.globalDeliveryDefaults;
    if (raw == null) {
      values.globalDeliveryDefaults = null;
    } else {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { error: "globalDeliveryDefaults must be an object or null" };
      const defaults = {};
      for (const key of ["shippingCharge", "daysMin", "daysMax"]) {
        const value = raw[key];
        if (
          !["number", "string"].includes(typeof value) ||
          String(value).trim() === "" ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0
        ) {
          return { error: `Default ${key} must be a non-negative number` };
        }
        defaults[key] = Number(value);
        if (key !== "shippingCharge" && !Number.isInteger(defaults[key]))
          return { error: `Default ${key} must be a whole number of days` };
      }
      if (defaults.daysMax < defaults.daysMin)
        return { error: "Default maximum days must be at least minimum days" };
      if (typeof raw.codAllowed !== "boolean")
        return { error: "Default codAllowed must be true or false" };
      defaults.codAllowed = raw.codAllowed;
      values.globalDeliveryDefaults = defaults;
    }
  }
  return { values };
};
const withGlobalSettingDefaults = (settings = {}) => {
  const out = {
    ...settings,
    globalDeliveryRules: settings?.globalDeliveryRules || [],
    globalDeliveryDefaults: settings?.globalDeliveryDefaults || null,
  };
  LEGACY_KEYS.forEach((key) => delete out[key]);
  return out;
};
module.exports = {
  GLOBAL_SETTING_KEYS,
  GLOBAL_SETTING_DEFAULTS,
  validateGlobalSettings,
  withGlobalSettingDefaults,
  buildGlobalEstimateEntry,
  buildWebsiteGlobalEstimateEntry,
  isGlobalStore,
  getDeliveryMode,
  getOrderScope,
  getGlobalSettings,
  getWebsiteGlobalSettings,
  isGlobalCodAllowed,
  computeGlobalShippingCharge,
  formatGlobalDeliveryText,
};
