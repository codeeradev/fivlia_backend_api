const roundRupees = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value + Number.EPSILON) : 0;
};

// Calculate the percentage plus fixed platform charge as a whole-rupee amount.
// A zero subtotal cannot represent a fixed charge as a percentage: waive it.
const getLocalPlatformFee = (subtotal, settings = {}) => {
  const total = Number(subtotal);
  if (!Number.isFinite(total) || total <= 0) return { amount: 0, percent: 0 };
  const rate = Number(settings?.Platform_Fee || 0);
  const fixed = Number(settings?.Platform_Fee_Fixed || 0);
  const amount = roundRupees(total * rate / 100 + fixed);
  return { amount, percent: amount / total * 100 };
};

const validatePlatformFeeSettings = (fields) => {
  for (const key of ['Platform_Fee', 'Platform_Fee_Fixed']) {
    if (!(key in fields)) continue;
    const raw = fields[key];
    const value = Number(raw);
    if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '' ||
        !Number.isFinite(value) || value < 0) {
      return `${key} must be a non-negative number`;
    }
    fields[key] = value;
  }
  return null;
};

module.exports = {
  getLocalPlatformFee,
  roundPlatformFeeAmount: roundRupees,
  validatePlatformFeeSettings,
};
