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

    const { zoneAvailable, storesOpen, matchedStores } =
      await getStoresWithinRadius(currentLat, currentLong);

    if (!zoneAvailable) {
      return res.json({
        status: false,
        result: 0,
        message: "Service zone not available",
      });
    }

    if (!storesOpen) {
      return res.json({
        status: false,
        result: 1,
        message: "All Store Is Closed",
      });
    }

    // Nearest store is chosen from LOCAL (city) stores only
    const validStores = matchedStores.filter(
      (store) =>
        store.serviceScope !== "global" && store.Latitude && store.Longitude
    );
    if (!validStores.length) {
      // No local store: fall back to a global (All India) store if one is open
      const globalStore = matchedStores.find(
        (store) => store.serviceScope === "global"
      );
      if (globalStore) {
        const globalSettings = await SettingAdmin.findOne().lean();
        return res.json({
          status: true,
          result: 2,
          deliveryMode: "global",
          filtered: [buildGlobalEstimateEntry(globalStore, globalSettings)],
        });
      }
      return res.json({ status: false, result: 0, filtered: [] });
    }

    // Find nearest store using haversine
    const nearestStoreData = validStores
      .map((store) => ({
        store,
        distanceMeters: haversine(
          { lat: currentLat, lng: currentLong },
          { lat: parseFloat(store.Latitude), lng: parseFloat(store.Longitude) }
        ),
      }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];

    const store = nearestStoreData.store;

    // Get admin map API settings
    const settings = await SettingAdmin.findOne().lean();
    const mapApiArray = settings?.Map_Api || [];
    const mapApi = mapApiArray[0] || {};
    const googleApi = mapApi?.google || {};
    const appleApi = mapApi?.apple || {};
    const olaApi = mapApi?.ola || {};

    let result = null;

    // Only one API call: Google > Ola > Apple
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
      const approxMinutes =
        (nearestStoreData.distanceMeters / 1000 / 25) * 60 + 5;
      result = {
        source: "approx",
        distanceText: `${Math.round(
          nearestStoreData.distanceMeters / 1000
        )} km`,
        trafficDurationText: `${Math.round(approxMinutes)} mins`,
      };
    }

    // Prepare filtered array (same structure as before)
    const filtered = [
      {
        storeId: store._id,
        storeName: store.storeName,
        city: store.city?.name || null,
        distance: result.distanceText,
        duration: addFiveMinutes(result.trafficDurationText,settings),
        raw: result,
      },
    ];

    res.json({ status: true, result: 2, deliveryMode: "local", filtered });
  } catch (err) {
    console.error("💥 Delivery Error:", err);
    res
      .status(500)
      .json({ status: false, message: "Server error", error: err.message });
  }
};

module.exports = { addFiveMinutes, getDeliveryEstimate };
