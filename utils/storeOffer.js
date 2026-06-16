const Coupon = require("../modals/sellerCoupon");
const Products = require("../modals/Product");
const stock = require("../modals/StoreStock");

const OFFER_TYPES = {
  FREE_PRODUCT: "free_product",
  CART_DISCOUNT: "cart_discount",
};

const DISCOUNT_SCOPES = {
  ENTIRE_CART: "entire_cart",
  SELECTED_PRODUCTS: "selected_products",
};

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIdString(value) {
  if (!value) return null;
  if (typeof value === "object") {
    if (value._id) return value._id.toString();
    if (value.id) return value.id.toString();
  }
  return value.toString();
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(toIdString).filter(Boolean);
}

function getOfferMinimumAmount(offer) {
  return Math.max(toNumber(offer?.minimumOrderAmount ?? offer?.limit), 0);
}

function calculateCartSubtotal(cartItems = []) {
  return cartItems.reduce((sum, item) => {
    const quantity = Math.max(toNumber(item.quantity, 1), 1);
    const baseUnitPrice = toNumber(item.originalPrice ?? item.price);
    return sum + baseUnitPrice * quantity;
  }, 0);
}

function isOfferActive(offer, now = new Date()) {
  if (!offer) return false;

  const offerStart = offer.fromTo ? new Date(offer.fromTo) : null;
  const offerEnd = offer.expireDate ? new Date(offer.expireDate) : null;

  return (
    offer.status === true &&
    offer.approvalStatus === "approved" &&
    (!offerStart || offerStart <= now) &&
    (!offerEnd || offerEnd >= now)
  );
}

async function getActiveStoreOffers(storeId, now = new Date()) {
  if (!storeId) return [];

  return Coupon.find({
    storeId,
    status: true,
    approvalStatus: "approved",
    expireDate: { $gte: now },
    $or: [
      { fromTo: { $exists: false } },
      { fromTo: null },
      { fromTo: { $lte: now } },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function getActiveStoreOffer(storeId, now = new Date()) {
  const offers = await getActiveStoreOffers(storeId, now);
  return offers[0] || null;
}

async function getActiveProductOffer(storeId, now = new Date(), productIds = []) {
  const offers = await getActiveStoreOffers(storeId, now);
  const requestedProductIds = normalizeIdArray(productIds);

  return offers.filter((offer) => {
    if (!isOfferActive(offer, now)) return false;
    if (offer.offerType !== OFFER_TYPES.CART_DISCOUNT) return false;
    if (offer.discountScope !== DISCOUNT_SCOPES.SELECTED_PRODUCTS) {
      return false;
    }

    if (!requestedProductIds.length) {
      return true;
    }

    const offerProductIds = normalizeIdArray(offer.productId);
    return offerProductIds.some((productId) =>
      requestedProductIds.includes(productId),
    );
  });
}

function resolveOfferPercent(offer, subtotal) {
  if (!offer) return 0;

  return Math.min(
    Math.max(toNumber(offer.offer ?? offer.offerValue ?? offer.discountPercent), 0),
    100,
  );
}

function buildOfferPreviewText(offer) {
  if (!offer) return "";

  const threshold = getOfferMinimumAmount(offer);
  const thresholdText =
    offer.discountScope === DISCOUNT_SCOPES.SELECTED_PRODUCTS || threshold <= 0
      ? ""
      : ` above ₹${threshold}`;
  const freeQuantity = toNumber(offer.freeProductQuantity, 1);
  const freeProduct = offer.freeProductId;
  const freeProductName =
    freeProduct &&
    typeof freeProduct === "object" &&
    (freeProduct.productName || freeProduct.title || freeProduct.name)
      ? freeProduct.productName || freeProduct.title || freeProduct.name
      : "selected product";
  const selectedText =
    offer.discountScope === DISCOUNT_SCOPES.SELECTED_PRODUCTS
      ? "on selected products"
      : "on the cart";

  if (offer.offerType === OFFER_TYPES.FREE_PRODUCT) {
    return `Spend ₹${threshold} and get ${freeQuantity} ${freeProductName} free`;
  }

  const percent = resolveOfferPercent(offer, threshold);

  return `Get ${percent}% off ${selectedText}${thresholdText}`;
}

function getApplicableCartItems(cartItems = [], offer) {
  if (!offer || offer.discountScope !== DISCOUNT_SCOPES.SELECTED_PRODUCTS) {
    return cartItems;
  }

  const offerProductIds = normalizeIdArray(offer.productId);
  if (!offerProductIds.length) return [];

  return cartItems.filter((item) =>
    offerProductIds.includes(toIdString(item.productId)),
  );
}

function buildCartDiscountBreakdown(cartItems = [], offer = null) {
  const mappedItems = [];
  let subtotal = 0;
  let discountAmount = 0;

  const normalizedItems = cartItems.map((item) => {
    const quantity = Math.max(toNumber(item.quantity, 1), 1);
    const baseUnitPrice = toNumber(item.originalPrice ?? item.price);
    const lineTotal = baseUnitPrice * quantity;
    subtotal += lineTotal;

    return {
      ...item,
      quantity,
      baseUnitPrice,
      lineTotal,
    };
  });

  const eligibleProductIds = new Set(normalizeIdArray(offer?.productId));
  const minimumAmount = getOfferMinimumAmount(offer);
  const meetsMinimum =
    !offer ||
    offer.discountScope === DISCOUNT_SCOPES.SELECTED_PRODUCTS ||
    subtotal >= minimumAmount;
  const percent = offer ? resolveOfferPercent(offer, subtotal) : 0;

  normalizedItems.forEach((item) => {
    const isEligible =
      meetsMinimum &&
      (!offer ||
        offer.discountScope !== DISCOUNT_SCOPES.SELECTED_PRODUCTS ||
        eligibleProductIds.has(toIdString(item.productId)));

    const finalUnitPrice =
      offer && isEligible && percent > 0
        ? applyStoreOfferToPrice(item.baseUnitPrice, percent)
        : Math.round(item.baseUnitPrice);

    const finalLineTotal = finalUnitPrice * item.quantity;
    const lineDiscount = Math.max(item.lineTotal - finalLineTotal, 0);
    discountAmount += lineDiscount;

    mappedItems.push({
      ...item,
      finalUnitPrice,
      finalLineTotal,
      lineDiscount,
      offerId: isEligible ? offer?._id || null : null,
      offerTitle: isEligible ? offer?.title || null : null,
      offerType: isEligible ? offer?.offerType || null : null,
      offerPercent: isEligible ? percent : 0,
      isOfferApplied: Boolean(isEligible && percent > 0),
    });
  });

  return {
    subtotal,
    discountAmount,
    finalSubtotal: Math.max(subtotal - discountAmount, 0),
    percent,
    items: mappedItems,
  };
}

function buildEmptyCartDiscountBreakdown(cartItems = []) {
  return buildCartDiscountBreakdown(cartItems, null);
}

function isOfferEligibleForCart(offer, cartItems = [], subtotal = null, now = new Date()) {
  if (!isOfferActive(offer, now)) {
    return { eligible: false, reason: "Offer is not active" };
  }

  const cartSubtotal =
    subtotal === null || subtotal === undefined
      ? calculateCartSubtotal(cartItems)
      : subtotal;
  const minimumAmount = getOfferMinimumAmount(offer);

  if (
    offer.discountScope !== DISCOUNT_SCOPES.SELECTED_PRODUCTS &&
    cartSubtotal < minimumAmount
  ) {
    return {
      eligible: false,
      reason: `Minimum order amount is ₹${minimumAmount}`,
    };
  }

  if (offer.offerType === OFFER_TYPES.CART_DISCOUNT) {
    if (resolveOfferPercent(offer, cartSubtotal) <= 0) {
      return { eligible: false, reason: "Discount percentage is missing" };
    }

    if (offer.discountScope === DISCOUNT_SCOPES.SELECTED_PRODUCTS) {
      const offerProductIds = normalizeIdArray(offer.productId);
      if (!offerProductIds.length) {
        return { eligible: false, reason: "No selected products on this offer" };
      }

      const hasProduct = cartItems.some((item) =>
        offerProductIds.includes(toIdString(item.productId)),
      );

      if (!hasProduct) {
        return {
          eligible: false,
          reason: "Offer products are not in cart",
        };
      }
    }
  }

  if (offer.offerType === OFFER_TYPES.FREE_PRODUCT && !offer.freeProductId) {
    return { eligible: false, reason: "Free product is missing" };
  }

  return { eligible: true, reason: null };
}

async function getAppliedOfferContext(cartItems = [], storeId, now = new Date()) {
  const subtotal = calculateCartSubtotal(cartItems);
  const emptyBreakdown = buildEmptyCartDiscountBreakdown(cartItems);
  const appliedOfferIds = [
    ...new Set(cartItems.map((item) => toIdString(item.couponId)).filter(Boolean)),
  ];

  if (!appliedOfferIds.length || !storeId) {
    return {
      offers: [],
      cartDiscount: emptyBreakdown,
      freeProductOffer: null,
      freeProductItem: null,
    };
  }

  const offers = await Coupon.find({
    _id: { $in: appliedOfferIds },
    storeId,
  })
    .sort({ createdAt: -1 })
    .lean();

  const activeOffers = offers.filter((offer) => isOfferActive(offer, now));
  const cartDiscountOffer =
    activeOffers.find((offer) => offer.offerType === OFFER_TYPES.CART_DISCOUNT) ||
    null;
  const freeProductOffer =
    activeOffers.find((offer) => offer.offerType === OFFER_TYPES.FREE_PRODUCT) ||
    null;

  const cartDiscount =
    cartDiscountOffer &&
    isOfferEligibleForCart(cartDiscountOffer, cartItems, subtotal, now).eligible
      ? {
          offer: cartDiscountOffer,
          ...buildCartDiscountBreakdown(cartItems, cartDiscountOffer),
        }
      : emptyBreakdown;

  const freeProductItem =
    freeProductOffer &&
    isOfferEligibleForCart(freeProductOffer, cartItems, subtotal, now).eligible
      ? await resolveFreeProductItem({ offer: freeProductOffer, storeId })
      : null;

  return {
    offers: activeOffers,
    cartDiscount,
    freeProductOffer: freeProductItem ? freeProductOffer : null,
    freeProductItem,
  };
}

async function resolveFreeProductItem({
  offer,
  storeId,
  productsModel = Products,
  stockModel = stock,
}) {
  if (!offer || offer.offerType !== OFFER_TYPES.FREE_PRODUCT) {
    return null;
  }

  const productId = toIdString(offer.freeProductId);
  if (!productId || !storeId) return null;

  const product = await productsModel.findById(productId).lean();
  if (!product) return null;

  const stockDoc = await stockModel.findOne({
    storeId,
    "stock.productId": product._id,
  }).lean();

  if (!stockDoc?.stock?.length) return null;

  const stockEntry = stockDoc.stock.find((entry) => {
    return (
      toIdString(entry.productId) === product._id.toString() &&
      toNumber(entry.quantity) >= Math.max(toNumber(offer.freeProductQuantity, 1), 1)
    );
  });

  if (!stockEntry) return null;

  const productVariantId =
    stockEntry.variantId ||
    product.variants?.[0]?._id ||
    null;

  if (!productVariantId) return null;

  const variant = Array.isArray(product.variants)
    ? product.variants.find(
        (item) => toIdString(item._id) === toIdString(productVariantId),
      )
    : null;

  const basePrice = toNumber(stockEntry.price ?? variant?.sell_price ?? 0);
  const quantity = Math.max(toNumber(offer.freeProductQuantity, 1), 1);

  return {
    productId: product._id,
    varientId: productVariantId,
    name: product.productName,
    quantity,
    price: 0,
    basePrice,
    mrp: stockEntry.mrp ?? variant?.mrp ?? null,
    tax: product.tax || "0%",
    image: product.productThumbnailUrl || product.productImage || null,
    isFreeProduct: true,
    freeProductSavings: basePrice * quantity,
    offerId: offer._id,
    offerTitle: offer.title,
    offerType: offer.offerType,
  };
}

function applyStoreOfferToPrice(price, offer) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) return null;

  const numericOffer = Number(offer);
  if (!Number.isFinite(numericOffer) || numericOffer <= 0) {
    return Math.round(numericPrice);
  }

  const discountedPrice =
    numericPrice - (numericPrice * numericOffer) / 100;

  return Math.max(Math.round(discountedPrice), 0);
}

module.exports = {
  OFFER_TYPES,
  DISCOUNT_SCOPES,
  getActiveStoreOffer,
  getActiveStoreOffers,
  getActiveProductOffer,
  isOfferActive,
  isOfferEligibleForCart,
  getOfferMinimumAmount,
  calculateCartSubtotal,
  resolveOfferPercent,
  buildOfferPreviewText,
  buildCartDiscountBreakdown,
  buildEmptyCartDiscountBreakdown,
  getAppliedOfferContext,
  resolveFreeProductItem,
  applyStoreOfferToPrice,
};
