const FOOD_TYPE_ID = "69cf8a31ad92aee54ecb1e72";

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const roundCurrency = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const isFoodOrderItem = (item = {}, store = {}) => {
  const typeName = String(item.typeName || "").trim().toLowerCase();

  return (
    typeName === "food" ||
    String(item.typeId || "") === FOOD_TYPE_ID ||
    Boolean(item.foodTypeId) ||
    item.isVeg === 1 ||
    item.isVeg === 2 ||
    store.sellFood === true ||
    store.businessType === "FSSAI" ||
    String(store.typeId || "") === FOOD_TYPE_ID
  );
};

const calculateOrderSettlement = ({
  order,
  store,
  foodSellerTaxPercent = 0,
}) => {
  const items = order?.items || [];

  const totalCommission = items.reduce((sum, item) => {
    const itemTotal = toNumber(item.price) * toNumber(item.quantity);
    const commissionAmount = (toNumber(item.commision) / 100) * itemTotal;
    return sum + commissionAmount;
  }, 0);

  const itemTotal = items.reduce((sum, item) => {
    return sum + toNumber(item.price) * toNumber(item.quantity);
  }, 0);

  const foodItemsTotal = items.reduce((sum, item) => {
    if (!isFoodOrderItem(item, store)) {
      return sum;
    }

    return sum + toNumber(item.price) * toNumber(item.quantity);
  }, 0);

  const foodSellerTaxAmountRaw = !store?.Authorized_Store
    ? (foodItemsTotal * toNumber(foodSellerTaxPercent)) / 100
    : 0;
  const foodSellerTaxAmount = roundCurrency(foodSellerTaxAmountRaw);
  const roundedTotalCommission = roundCurrency(totalCommission);

  return {
    totalCommission: roundedTotalCommission,
    itemTotal: roundCurrency(itemTotal),
    foodItemsTotal: roundCurrency(foodItemsTotal),
    foodSellerTaxAmount,
    totalAdminDeduction: roundCurrency(
      roundedTotalCommission + foodSellerTaxAmount,
    ),
    adminReferralProfit: roundCurrency(
      roundedTotalCommission + foodSellerTaxAmount,
    ),
  };
};

module.exports = {
  FOOD_TYPE_ID,
  calculateOrderSettlement,
  isFoodOrderItem,
};
