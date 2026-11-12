const roundMoney = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value)
    ? Math.round((value + Number.EPSILON) * 100) / 100
    : 0;
};

const calculatePayableTotal = (subtotal, platformFee, deliveryCharge) =>
  roundMoney(Number(subtotal) + Number(platformFee) + Number(deliveryCharge));

module.exports = { roundMoney, calculatePayableTotal };
