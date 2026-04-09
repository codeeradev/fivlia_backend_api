const normalizeTypeId = (value) => {
  if (!value) return "";

  if (typeof value === "string") {
    return value;
  }

  // Mongoose ObjectId instances expose `_id` that points back to themselves.
  if (typeof value?.toHexString === "function") {
    return value.toHexString();
  }

  if (typeof value === "object" && value._id && value._id !== value) {
    return normalizeTypeId(value._id);
  }

  const normalizedValue = value.toString?.() || "";
  return normalizedValue === "[object Object]" ? "" : normalizedValue;
};

const resolveRequestedTypeId = (req = {}) =>
  normalizeTypeId(req.typeId || req.query?.typeId);

const filterProductsByRequestedType = (products = [], reqOrTypeId) => {
  if (!Array.isArray(products) || !products.length) {
    return products;
  }

  const requestedTypeId =
    reqOrTypeId && typeof reqOrTypeId === "object" && !Array.isArray(reqOrTypeId)
      ? resolveRequestedTypeId(reqOrTypeId)
      : normalizeTypeId(reqOrTypeId);

  if (!requestedTypeId) {
    return products;
  }

  return products.filter((product) => {
    const productTypeId = normalizeTypeId(product?.typeId);
    return productTypeId && productTypeId === requestedTypeId;
  });
};

module.exports = {
  filterProductsByRequestedType,
  normalizeTypeId,
  resolveRequestedTypeId,
};
