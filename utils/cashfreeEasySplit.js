const { isFoodOrderItem } = require("./orderSettlement");

const parseDecimal = (value) => {
  const sourceValue = String(value).trim().replace(/%$/, "");
  const number = Number(sourceValue);
  if (!Number.isFinite(number)) throw new Error("Invalid monetary value");
  let source = sourceValue;
  if (/e/i.test(source)) source = number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const sign = source.startsWith("-") ? -1n : 1n;
  source = source.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = source.split(".");
  if (!/^\d+$/.test(whole || "0") || (fraction && !/^\d+$/.test(fraction))) {
    throw new Error("Invalid monetary value");
  }
  return { sign, whole: BigInt(whole || "0"), fraction };
};

const toMinorUnits = (value) => {
  const { sign, whole, fraction } = parseDecimal(value);
  const cents = (fraction + "00").slice(0, 2);
  const extra = fraction.slice(2);
  let minor = whole * 100n + BigInt(cents || "0");
  if (extra && Number(extra[0]) >= 5) minor += 1n;
  return sign * minor;
};

const percentageToMicros = (value) => {
  const { sign, whole, fraction } = parseDecimal(value);
  if (sign < 0n) throw new Error("Percentage must not be negative");
  const micros = whole * 1000000n + BigInt((fraction + "000000").slice(0, 6) || "0");
  const extra = fraction.slice(6);
  const rounded = extra && Number(extra[0]) >= 5 ? micros + 1n : micros;
  if (rounded > 100000000n) throw new Error("Percentage cannot exceed 100");
  return rounded;
};

const roundRatioHalfUp = (numerator, denominator) =>
  (numerator + denominator / 2n) / denominator;

const toSafeNumber = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Amount is outside the supported range");
  return number;
};

const calculateCashfreeVendorShare = ({ order, store, foodSellerTaxPercent = 0 }) => {
  const items = Array.isArray(order?.items) ? order.items : [];
  const itemTotalMinor = items.reduce((sum, item) => {
    const priceMinor = toMinorUnits(item.price || 0);
    const quantity = Number(item.quantity || 0);
    if (priceMinor < 0n) throw new Error("Item price must not be negative");
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("Invalid item quantity");
    return sum + priceMinor * BigInt(quantity);
  }, 0n);

  const foodItemsTotalMinor = items.reduce((sum, item) => {
    if (!isFoodOrderItem(item, store)) return sum;
    const quantity = Number(item.quantity || 0);
    return sum + toMinorUnits(item.price || 0) * BigInt(quantity);
  }, 0n);

  let commissionMinor = 0n;
  if (!store?.Authorized_Store) {
    const commissionScaledMinor = items.reduce((sum, item) => {
      const quantity = Number(item.quantity || 0);
      const lineMinor = toMinorUnits(item.price || 0) * BigInt(quantity);
      return sum + lineMinor * percentageToMicros(item.commision || 0);
    }, 0n);
    commissionMinor = roundRatioHalfUp(commissionScaledMinor, 100000000n);
  }

  const foodTaxMinor = !store?.Authorized_Store
    ? roundRatioHalfUp(
        foodItemsTotalMinor * percentageToMicros(foodSellerTaxPercent),
        100000000n,
      )
    : 0n;
  const sponsoredDeliveryMinor = toMinorUnits(order?.sellerSponsoredDeliveryPayout || 0);
  const deductionsMinor = commissionMinor + foodTaxMinor;
  const vendorAmountMinor = itemTotalMinor - deductionsMinor - sponsoredDeliveryMinor;
  const payableMinor = toMinorUnits(order?.totalPrice ?? order?.totalAmount ?? 0);

  if (itemTotalMinor < 0n || payableMinor <= 0n) throw new Error("Invalid order amount");
  if (vendorAmountMinor < 0n) throw new Error("Vendor share cannot be negative");
  if (vendorAmountMinor > payableMinor) throw new Error("Vendor share exceeds customer payment");

  return {
    itemTotalMinor: toSafeNumber(itemTotalMinor),
    commissionMinor: toSafeNumber(commissionMinor),
    foodTaxMinor: toSafeNumber(foodTaxMinor),
    sponsoredDeliveryMinor: toSafeNumber(sponsoredDeliveryMinor),
    vendorAmountMinor: toSafeNumber(vendorAmountMinor),
    platformAmountMinor: toSafeNumber(payableMinor - vendorAmountMinor),
    payableMinor: toSafeNumber(payableMinor),
  };
};

const minorToMajor = (minor) => Number((Number(minor) / 100).toFixed(2));

module.exports = {
  calculateCashfreeVendorShare,
  minorToMajor,
  toMinorUnits
};
