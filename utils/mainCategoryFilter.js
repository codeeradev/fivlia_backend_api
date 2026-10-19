// Category-list visibility only; product, brand and stock scopes stay unchanged.
async function resolveMainCategoryFilter(req, {
  resolveUser,
  getStoresWithinRadius,
  resolveTypeScope,
  resolveGlobalOnlyScope,
}) {
  try {
    let lat = parseFloat(req.query?.latitude ?? req.query?.lat);
    let lng = parseFloat(req.query?.longitude ?? req.query?.lng ?? req.query?.long);
  
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      const user = await resolveUser(req);
      lat = parseFloat(user?.location?.latitude);
      lng = parseFloat(user?.location?.longitude);
    }
  
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      // Use existing active-zone/day-night radius rules. Store availability is
      // intentionally irrelevant to whether this location is inside a zone.
      const location = await getStoresWithinRadius(lat, lng, { allStores: [] });
      if (location?.insideZone) {
        req.globalScopeDebug = 'inside delivery zone -> all categories for selected type';
        // Query by type directly: middleware categoryIds contains only active
        // categories and would incorrectly hide inactive categories here.
        return req.typeId ? { typeId: req.typeId } : {};
      }
    }
  } catch (error) {
    // Preserve the existing scope helpers' fallback behavior on lookup errors.
    console.error("Main category zone lookup failed:", error.message);
  }

  // Outside delivery zones (or no location): preserve the existing filters.
  if (req.typeId) {
    const typeScope = await resolveTypeScope(req, req.typeId);
    const typeCategorySet = typeScope ? new Set(typeScope.categoryIds) : null;
    const typeCategoryIds = typeCategorySet
      ? req.categoryIds.filter((id) => typeCategorySet.has(String(id)))
      : req.categoryIds;
    return { _id: { $in: typeCategoryIds } };
  }

  const globalScope = await resolveGlobalOnlyScope(req);
  return globalScope ? { _id: { $in: globalScope.mainCategoryIds } } : {};
}

module.exports = { resolveMainCategoryFilter };
