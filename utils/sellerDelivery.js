const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const isTruthyFlag = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "on"].includes(normalized);
  }

  return false;
};

const getSellerFreeDeliverySettings = (store = {}) => {
  return {
    enabled: isTruthyFlag(store?.sellerFreeDeliveryEnabled),
    limit: Math.max(0, toNumber(store?.sellerFreeDeliveryLimit)),
  };
};

const resolveSellerDeliveryPricing = ({
  itemsTotal = 0,
  settings = {},
  store = {},
  deliveryChargeRaw = 0,
  deliveryPayout = 0,
} = {}) => {
  const itemSubtotal = Math.max(0, toNumber(itemsTotal));
  const baseDeliveryCharge = Math.max(0, toNumber(deliveryChargeRaw));
  const baseDeliveryPayout = Math.max(0, toNumber(deliveryPayout));
  const globalFreeDeliveryLimit = Math.max(
    0,
    toNumber(settings?.freeDeliveryLimit),
  );
  const sellerSettings = getSellerFreeDeliverySettings(store);

  const isPlatformFreeDeliveryApplied =
    globalFreeDeliveryLimit > 0 && itemSubtotal >= globalFreeDeliveryLimit;
  const isSellerFreeDeliveryApplied =
    !isPlatformFreeDeliveryApplied &&
    sellerSettings.enabled &&
    sellerSettings.limit > 0 &&
    itemSubtotal >= sellerSettings.limit;

  const freeDeliverySource = isPlatformFreeDeliveryApplied
    ? "platform"
    : isSellerFreeDeliveryApplied
      ? "seller"
      : null;

  return {
    itemSubtotal,
    deliveryBaseCharge: baseDeliveryCharge,
    customerDeliveryCharge: freeDeliverySource ? 0 : baseDeliveryCharge,
    deliveryPayout: baseDeliveryPayout,
    freeDeliveryApplied: Boolean(freeDeliverySource),
    freeDeliverySource,
    freeDeliveryThreshold: freeDeliverySource
      ? freeDeliverySource === "platform"
        ? globalFreeDeliveryLimit
        : sellerSettings.limit
      : 0,
    sellerSponsoredDeliveryPayout:
      freeDeliverySource === "seller" ? baseDeliveryPayout : 0,
    isPlatformFreeDeliveryApplied,
    isSellerFreeDeliveryApplied,
    globalFreeDeliveryLimit,
    sellerFreeDeliveryEnabled: sellerSettings.enabled,
    sellerFreeDeliveryLimit: sellerSettings.limit,
  };
};

module.exports = {
  toNumber,
  isTruthyFlag,
  getSellerFreeDeliverySettings,
  resolveSellerDeliveryPricing,
};
