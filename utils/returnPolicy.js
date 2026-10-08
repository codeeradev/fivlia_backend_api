// NEW FILE: utils/returnPolicy.js
// One place for the item-return rules. Change the two constants below to
// change the policy for everyone (mobile app reads the result from the API).

const RETURN_WINDOW_DAYS = 10; // days after delivery
const RETURN_ALLOWED_SCOPES = ["global"]; // add "city" here to allow local orders too
const RETURN_MAX_IMAGES = 5; // photos per return request
const RETURN_IMAGE_MAX_MB = 5; // size limit per photo
const RETURN_IMAGES_REQUIRED = false; // true = customer must attach at least 1 photo

const DAY_MS = 24 * 60 * 60 * 1000;

const itemKey = (productId, varientId) =>
  `${String(productId)}|${varientId ? String(varientId) : ""}`;

// Quantity already asked for in earlier requests (rejected ones do not count)
const requestedQtyMap = (order) => {
  const map = new Map();
  for (const rr of order?.returnRequests || []) {
    if (rr.status === "rejected") continue;
    for (const it of rr.items || []) {
      const k = itemKey(it.productId, it.varientId);
      map.set(k, (map.get(k) || 0) + Number(it.quantity || 0));
    }
  }
  return map;
};

// Quantity that can still be returned, per order item key
const remainingQtyMap = (order) => {
  const requested = requestedQtyMap(order);
  const ordered = new Map();
  for (const it of order?.items || []) {
    const k = itemKey(it.productId, it.varientId);
    ordered.set(k, (ordered.get(k) || 0) + Number(it.quantity || 0));
  }
  const remaining = new Map();
  for (const [k, qty] of ordered) {
    remaining.set(k, Math.max(0, qty - (requested.get(k) || 0)));
  }
  return remaining;
};

const getReturnEligibility = (order, now = new Date()) => {
  const base = {
    canRequestReturn: false,
    reason: "",
    windowDays: RETURN_WINDOW_DAYS,
    deliveredAt: order?.orderDeliveredTime || null,
    returnWindowEndsAt: null,
    daysLeft: 0,
  };

  const scope = order?.serviceScope || "city";
  if (!RETURN_ALLOWED_SCOPES.includes(scope)) {
    return { ...base, reason: "Returns are not available for this order" };
  }

  if (String(order?.orderStatus || "").trim().toLowerCase() !== "delivered") {
    return { ...base, reason: "Order is not delivered yet" };
  }

  if (!order?.orderDeliveredTime) {
    return { ...base, reason: "Delivery time is not recorded for this order" };
  }

  const endsAt = new Date(
    new Date(order.orderDeliveredTime).getTime() + RETURN_WINDOW_DAYS * DAY_MS,
  );
  const msLeft = endsAt.getTime() - now.getTime();
  const withWindow = {
    ...base,
    returnWindowEndsAt: endsAt,
    daysLeft: msLeft > 0 ? Math.ceil(msLeft / DAY_MS) : 0,
  };

  if (msLeft <= 0) {
    return {
      ...withWindow,
      reason: `Return window of ${RETURN_WINDOW_DAYS} days has ended`,
    };
  }

  const anyLeft = [...remainingQtyMap(order).values()].some((q) => q > 0);
  if (!anyLeft) {
    return { ...withWindow, reason: "Return already requested for all items" };
  }

  return { ...withWindow, canRequestReturn: true };
};

// Return flow never changes order.orderStatus (it stays "Delivered"), so the app
// needs a derived label. Rejected requests are ignored (order is still delivered).
const RETURN_STATUS_LABELS = {
  requested: "Return Requested",
  approved: "Return Approved",
  picked: "Return Picked Up",
  refunded: "Returned",
};

const getReturnDisplayStatus = (order) => {
  const base = String(order?.orderStatus || "");
  const all = order?.returnRequests || [];
  const active = all.filter((r) => r?.status && r.status !== "rejected");
  const none = {
    displayStatus: base,
    returnStatus: all.length ? "rejected" : "",
    isPartialReturn: false,
  };
  if (!active.length || base.trim().toLowerCase() !== "delivered") return none;

  // latest request wins (requestedAt, else array order)
  const latest = active.reduce((a, b) =>
    new Date(b.requestedAt || 0) >= new Date(a.requestedAt || 0) ? b : a,
  );
  const isPartialReturn = [...remainingQtyMap(order).values()].some((q) => q > 0);
  const displayStatus =
    latest.status === "refunded" && isPartialReturn
      ? "Partially Returned"
      : RETURN_STATUS_LABELS[latest.status] || base;

  return { displayStatus, returnStatus: latest.status, isPartialReturn };
};

module.exports = {
  getReturnDisplayStatus,
  RETURN_WINDOW_DAYS,
  RETURN_ALLOWED_SCOPES,
  RETURN_MAX_IMAGES,
  RETURN_IMAGE_MAX_MB,
  RETURN_IMAGES_REQUIRED,
  itemKey,
  remainingQtyMap,
  getReturnEligibility,
};
