const roundMoney = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value)
    ? Math.round((value + Number.EPSILON) * 100) / 100
    : 0;
};

module.exports = { roundMoney };
