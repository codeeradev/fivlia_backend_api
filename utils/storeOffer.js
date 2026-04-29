const Coupon = require("../modals/sellerCoupon");

async function getActiveStoreOffer(storeId, now = new Date()) {
  if (!storeId) return null;

  return Coupon.findOne({
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
  getActiveStoreOffer,
  applyStoreOfferToPrice,
};
