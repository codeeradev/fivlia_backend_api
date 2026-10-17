const {
  calculateDeliveryTime,
  reverseGeocode,
  getStoresWithinRadius,
} = require("../config/google");
const Store = require("../modals/store");
const { SettingAdmin } = require("../modals/setting");
const User = require("../modals/User");
const { ZoneData } = require("../modals/cityZone");
const { getDistance } = require("../config/Ola");
const MapUsage = require("../modals/mapUsage");
const haversine = require("haversine-distance");
const { buildGlobalEstimateEntry } = require("../utils/globalDelivery");
const Category = require("../modals/category");
const Type = require("../modals/type");
const { normalizeTypeId } = require("../utils/productTypeFilter");

function addFiveMinutes(durationText,settings) {
  const match = durationText.match(/(\d+)\s*min/);
  if (match) {
    const originalMinutes = parseInt(match[1]);
    const addedTime = settings.extraTime || 0
    const newMinutes = originalMinutes + addedTime;
    return `${newMinutes} mins`;
  }
  return durationText;
}

const getDeliveryEstimate = async (req, res) => {
  try {
    const { id } = req.user;
    if (!id)
      return res
        .status(200)
        .json({ status: false, message: "Missing user ID" });

    const user = await User.findById(id);
    const currentLat = parseFloat(user?.location?.latitude);
    const currentLong = parseFloat(user?.location?.longitude);

    if (!currentLat || !currentLong) {
      return res
        .status(200)
        .json({ status: false, message: "User location not set" });
    }

    const { zoneAvailable, storesOpen, matchedStores, serviceMode, insideZone } =
      await getStoresWithinRadius(currentLat, currentLong);

    // Same serviceMode that resolveGlobalOnlyScope uses for the category filter:
    //   "local" | "mixed" -> local store serves the user  -> deliveryMode "local"
    //   "global_only"     -> only global store is open    -> deliveryMode "global"
    //   "none"            -> nothing open                 -> deliveryMode "none"
    const meta = { serviceMode, insideZone };

    if (!zoneAvailable) {
      return res.json({
        status: false,
        result: 0,
        deliveryMode: "none",
        ...meta,
        message: "Service zone not available",
      });
    }

    if (!storesOpen) {
      return res.json({
        status: false,
        result: 1,
        deliveryMode: "none",
        ...meta,
        message: "All Store Is Closed",
      });
    }

    // Local (city) stores that can be measured
    const validStores = matchedStores.filter(
      (store) =>
        store.serviceScope !== "global" && store.Latitude && store.Longitude
    );

    // Admin settings + map API (Google > Ola > Apple)
    const settings = await SettingAdmin.findOne().lean();
    const mapApiArray = settings?.Map_Api || [];
    const mapApi = mapApiArray[0] || {};
    const googleApi = mapApi?.google || {};
    const appleApi = mapApi?.apple || {};
    const olaApi = mapApi?.ola || {};

    // ------------------------------------------------------------------
    // ✅ Types of every open store (food / grocery / mall ... from saved data).
    //    A store can sell more than one type, so its types are:
    //      - its own typeId, PLUS
    //      - the typeId of every saved category (Category.typeId):
    //        Store.Category and Store.sellerCategories
    //    The store is listed under each of those types.
    // ------------------------------------------------------------------
    const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

    const getStoreCategoryIds = (store) =>
      [
        ...(Array.isArray(store.Category) ? store.Category : [store.Category]),
        ...(store.sellerCategories || []).map((c) => c?.categoryId),
      ]
        .filter(Boolean)
        .map((c) => String(c))
        .filter((id) => OBJECT_ID_REGEX.test(id));

    const allCategoryIds = [
      ...new Set(matchedStores.flatMap(getStoreCategoryIds)),
    ];

    const categoryTypeMap = new Map();
    if (allCategoryIds.length) {
      const categoryDocs = await Category.find({
        _id: { $in: allCategoryIds },
      })
        .select("_id typeId")
        .lean();
      categoryDocs.forEach((c) =>
        categoryTypeMap.set(String(c._id), normalizeTypeId(c.typeId))
      );
    }

    // every type id this store belongs to ("other" when none can be found)
    const getStoreTypeKeys = (store) => {
      const keys = new Set();
      const ownTypeId = normalizeTypeId(store.typeId);
      if (ownTypeId) keys.add(ownTypeId);
      getStoreCategoryIds(store).forEach((id) => {
        const categoryType = categoryTypeMap.get(id);
        if (categoryType) keys.add(categoryType);
      });
      if (!keys.size) keys.add("other");
      return [...keys];
    };

    // Distance + time for ONE local store (same logic as before)
    const getLocalEstimate = async (store, distanceMeters) => {
      let result = null;

      // Only one API call per store: Google > Ola > Apple
      if (googleApi.status && googleApi.api_key) {
        try {
          result = await calculateDeliveryTime(
            parseFloat(store.Latitude),
            parseFloat(store.Longitude),
            currentLat,
            currentLong,
            googleApi.api_key
          );
          if (result) result.source = "google";
        } catch (err) {
          console.log("Google API failed:", err.message);
        }
      } else if (olaApi.status && olaApi.api_key) {
        try {
          // Track API usage once
          await MapUsage.findOneAndUpdate(
            {
              source: "app",
              callType: "getDistance",
              subCallType: "getDeliveryEstimate_DeliveryControler",
            },
            { $inc: { count: 1 }, $set: { lastCalledAt: new Date() } },
            { upsert: true, new: true }
          );

          const olaResult = await getDistance(
            { lat: parseFloat(store.Latitude), lng: parseFloat(store.Longitude) },
            { lat: currentLat, lng: currentLong },
            olaApi.api_key
          );

          if (olaResult.status === "OK") {
            result = {
              source: "ola",
              distanceText: olaResult.distance.text,
              durationText: olaResult.duration.text,
              trafficDurationText: olaResult.duration.text,
              distanceValue: olaResult.distance.value,
              durationValue: olaResult.duration.value,
              trafficDurationValue: olaResult.duration.value,
            };
          }
        } catch (err) {
          console.error("Ola API failed:", err.message);
        }
      } else if (appleApi.status && appleApi.api_key) {
        console.log("Apple API not implemented yet");
      }

      // If API fails, fallback: approximate duration based on distance
      if (!result) {
        const approxMinutes = (distanceMeters / 1000 / 25) * 60 + 5;
        result = {
          source: "approx",
          distanceText: `${Math.round(distanceMeters / 1000)} km`,
          trafficDurationText: `${Math.round(approxMinutes)} mins`,
        };
      }

      return {
        storeId: store._id,
        storeName: store.storeName,
        city: store.city?.name || null,
        distance: result.distanceText,
        duration: addFiveMinutes(result.trafficDurationText, settings),
        raw: result,
      };
    };

    // 1️⃣ Nearest LOCAL store of EACH type (haversine)
    const nearestLocalByType = new Map();
    validStores.forEach((store) => {
      const distanceMeters = haversine(
        { lat: currentLat, lng: currentLong },
        { lat: parseFloat(store.Latitude), lng: parseFloat(store.Longitude) }
      );
      getStoreTypeKeys(store).forEach((typeKey) => {
        const current = nearestLocalByType.get(typeKey);
        if (!current || distanceMeters < current.distanceMeters) {
          nearestLocalByType.set(typeKey, { store, distanceMeters });
        }
      });
    });

    // 2️⃣ Global (All India) store of every type that has NO local store open
    const globalByType = new Map();
    matchedStores
      .filter((store) => store.serviceScope === "global")
      .forEach((store) => {
        getStoreTypeKeys(store).forEach((typeKey) => {
          if (!nearestLocalByType.has(typeKey) && !globalByType.has(typeKey)) {
            globalByType.set(typeKey, store);
          }
        });
      });

    // 3️⃣ Build one entry per type (nearest first, global entries last)
    // a store that is the nearest for 2 types is measured only once
    const estimateCache = new Map();
    const getCachedEstimate = (store, distanceMeters) => {
      const key = String(store._id);
      if (!estimateCache.has(key)) {
        estimateCache.set(key, getLocalEstimate(store, distanceMeters));
      }
      return estimateCache.get(key);
    };

    const localEntries = await Promise.all(
      [...nearestLocalByType.entries()].map(
        async ([typeKey, { store, distanceMeters }]) => ({
          typeKey,
          distanceMeters,
          entry: await getCachedEstimate(store, distanceMeters),
        })
      )
    );
    localEntries.sort((a, b) => a.distanceMeters - b.distanceMeters);

    const globalEntries = [...globalByType.entries()].map(
      ([typeKey, store]) => ({
        typeKey,
        entry: buildGlobalEstimateEntry(store, settings),
      })
    );

    if (!localEntries.length && !globalEntries.length) {
      return res.json({
        status: false,
        result: 0,
        deliveryMode: "none",
        ...meta,
        filtered: [],
      });
    }

    // type name comes from the saved `type` collection (no hardcoded names)
    const typeIds = [...localEntries, ...globalEntries]
      .map((e) => e.typeKey)
      .filter((k) => OBJECT_ID_REGEX.test(k));
    const typeDocs = typeIds.length
      ? await Type.find({ _id: { $in: typeIds } })
          .select("_id name")
          .lean()
      : [];
    const typeNameMap = new Map(typeDocs.map((t) => [String(t._id), t.name]));

    const filtered = [...localEntries, ...globalEntries].map(
      ({ typeKey, entry }) => ({
        ...entry,
        typeId: OBJECT_ID_REGEX.test(typeKey) ? typeKey : null,
        typeName: typeNameMap.get(typeKey) || null,
      })
    );

    res.json({
      status: true,
      result: 2,
      deliveryMode: localEntries.length ? "local" : "global",
      ...meta,
      filtered,
    });
  } catch (err) {
    console.error("💥 Delivery Error:", err);
    res
      .status(500)
      .json({ status: false, message: "Server error", error: err.message });
  }
};

module.exports = { addFiveMinutes, getDeliveryEstimate };
