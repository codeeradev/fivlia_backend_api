// utils/productWeight.js
// Helpers for per-variant shipping weight.
//
// Rule: a variant may carry its own `weight: { value, unit }`.
// If it does not (or the value is not > 0), the product-level `weight` is used.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Cleans the weight of ONE variant coming from the admin panel / API client.
 * Accepts either:
 *   variant.weight = { value, unit }        (what the admin panel sends)
 *   variant.weight = 0.5, variant.weightUnit = "kg"   (flat form)
 * Returns a NEW variant object. Invalid / empty / <= 0 weights are removed so the
 * variant simply inherits the product-level weight.
 */
const normalizeVariantWeight = (variant = {}) => {
  const { weight, weightUnit, ...rest } = variant;

  let rawValue;
  let rawUnit;

  if (weight && typeof weight === "object") {
    rawValue = weight.value;
    rawUnit = weight.unit;
  } else {
    rawValue = weight;
    rawUnit = weightUnit;
  }

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return rest;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return rest;
  }

  return {
    ...rest,
    weight: {
      value: round2(parsed),
      unit: rawUnit === "g" ? "g" : "kg",
    },
  };
};

const toKg = (weight) => {
  if (!weight) return 0;
  const value = Number(weight.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return weight.unit === "g" ? value / 1000 : value;
};

/**
 * Effective shipping weight of a variant, in kg.
 * variant.weight  ->  product.weight  ->  0
 *
 * @param {Object} product  Product document / lean object
 * @param {String|ObjectId} variantId  variant _id (optional)
 */
const getEffectiveWeightKg = (product, variantId) => {
  if (!product) return 0;

  if (variantId && Array.isArray(product.variants)) {
    const variant = product.variants.find(
      (v) => String(v._id) === String(variantId)
    );
    const variantKg = toKg(variant?.weight);
    if (variantKg > 0) return variantKg;
  }

  return toKg(product.weight);
};

module.exports = { normalizeVariantWeight, getEffectiveWeightKg, toKg };
