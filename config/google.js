require("dotenv").config();
const Store = require("../modals/store");
const haversine = require("haversine-distance");
const { ZoneData } = require("../modals/cityZone");
const { SettingAdmin } = require("../modals/setting");
const moment = require("moment-timezone");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const SETTINGS_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_TIMEZONE = "Asia/Kolkata";
// const DEFAULT_TIMEZONE =
//   process.env.BUSINESS_TIMEZONE || process.env.TIME_ZONE || process.env.TZ || "UTC";

let zoneWindowConfigCache = {
  value: null,
  expiresAt: 0,
};

const pickFirstDefined = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
};

const normalizeTimeString = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = moment(value.trim(), ["HH:mm", "H:mm", "hh:mm A", "h:mm A"], true);
  return parsed.isValid() ? parsed.format("HH:mm") : null;
};

const parseWindowMinutes = (timeValue) => {
  const normalized = normalizeTimeString(timeValue);
  if (!normalized) return null;

  const [hours, minutes] = normalized.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
};

const parsePositiveNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const isMinuteInWindow = (minuteOfDay, startMinute, endMinute) => {
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) return false;
  if (startMinute === endMinute) return true;

  if (startMinute < endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }

  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
};

const getNowInTimezone = (timezone) => {
  if (timezone && moment.tz.zone(timezone)) {
    return moment.tz(timezone);
  }
  return moment();
};

const toZoneWindowConfig = (settings = {}) => {
  const timezoneValue = pickFirstDefined(settings, [
    "zoneTimeZone",
    "zoneTimezone",
    "timeZone",
    "timezone",
  ]);

  const dayStart = parseWindowMinutes(
    pickFirstDefined(settings, ["dayStartTime", "dayStart", "dayTimeStart"])
  );
  const dayEnd = parseWindowMinutes(
    pickFirstDefined(settings, ["dayEndTime", "dayEnd", "dayTimeEnd"])
  );
  const nightStart = parseWindowMinutes(
    pickFirstDefined(settings, ["nightStartTime", "nightStart", "nightTimeStart"])
  );
  const nightEnd = parseWindowMinutes(
    pickFirstDefined(settings, ["nightEndTime", "nightEnd", "nightTimeEnd"])
  );

  return {
    timezone: timezoneValue || DEFAULT_TIMEZONE,
    dayStart,
    dayEnd,
    nightStart,
    nightEnd,
    dayEnabled: Number.isInteger(dayStart) && Number.isInteger(dayEnd),
    nightEnabled: Number.isInteger(nightStart) && Number.isInteger(nightEnd),
  };
};

async function getZoneWindowConfig(options = {}) {
  const { forceRefresh = false } = options;
  const nowMs = Date.now();

  if (
    !forceRefresh &&
    zoneWindowConfigCache.value &&
    zoneWindowConfigCache.expiresAt > nowMs
  ) {
    return zoneWindowConfigCache.value;
  }

  const settings = await SettingAdmin.findOne(
    {},
    [
      "dayStartTime",
      "dayEndTime",
      "nightStartTime",
      "nightEndTime",
      "zoneTimeZone",
      "dayStart",
      "dayEnd",
      "nightStart",
      "nightEnd",
      "dayTimeStart",
      "dayTimeEnd",
      "nightTimeStart",
      "nightTimeEnd",
      "zoneTimezone",
      "timeZone",
      "timezone",
    ].join(" ")
  ).lean();

  const parsedConfig = toZoneWindowConfig(settings || {});
  zoneWindowConfigCache = {
    value: parsedConfig,
    expiresAt: nowMs + SETTINGS_CACHE_TTL_MS,
  };

  return parsedConfig;
}

function getActiveZoneRange(zone, zoneWindowConfig, nowMoment = null) {
  const dayRange = parsePositiveNumber(zone?.range);
  const nightRange = parsePositiveNumber(zone?.nightRange);

  if (!dayRange && !nightRange) return null;

  const config = zoneWindowConfig || toZoneWindowConfig({});
  const currentMoment = nowMoment || getNowInTimezone(config.timezone);

  if (!config.dayEnabled && !config.nightEnabled) {
    return dayRange || nightRange;
  }

  const minuteOfDay = currentMoment.hours() * 60 + currentMoment.minutes();
  const inDay = config.dayEnabled
    ? isMinuteInWindow(minuteOfDay, config.dayStart, config.dayEnd)
    : false;
  const inNight = config.nightEnabled
    ? isMinuteInWindow(minuteOfDay, config.nightStart, config.nightEnd)
    : false;

  if (inDay && !inNight) return dayRange || nightRange;
  if (inNight && !inDay) return nightRange || dayRange;
  if (inDay && inNight) return dayRange || nightRange;

  return null;
}

function getCurrentZoneWindowMode(zoneWindowConfig = null, nowMoment = null) {
  const config = zoneWindowConfig || toZoneWindowConfig({});

  if (!config.dayEnabled && !config.nightEnabled) return "day";

  const currentMoment = nowMoment || getNowInTimezone(config.timezone);
  const minuteOfDay = currentMoment.hours() * 60 + currentMoment.minutes();

  const inDay = config.dayEnabled
    ? isMinuteInWindow(minuteOfDay, config.dayStart, config.dayEnd)
    : false;
  const inNight = config.nightEnabled
    ? isMinuteInWindow(minuteOfDay, config.nightStart, config.nightEnd)
    : false;

  if (inNight) return "night";
  if (inDay) return "day";

  return "day";
}

const calculateDeliveryTime = async (
  storeLat,
  storeLng,
  userLat,
  userLng,
  apiKey
) => {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${storeLat},${storeLng}&destinations=${userLat},${userLng}&departure_time=now&mode=driving&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK") throw new Error("Google API Error");

    const element = data.rows[0].elements[0];

    if (element.status !== "OK") {
      console.warn("Route status:", element.status);
      return {
        distanceText: "0 km",
        durationText: "0 min",
        trafficDurationText: "0 min",
        distanceValue: 0,
        durationValue: 0,
        trafficDurationValue: 0,
      };
    }

    return {
      distanceText: element.distance.text,
      durationText: element.duration.text,
      trafficDurationText: element.duration_in_traffic.text,
      distanceValue: element.distance.value,
      durationValue: element.duration.value,
      trafficDurationValue: element.duration_in_traffic.value,
    };
  } catch (error) {
    console.error("Error fetching ETA:", error.message);
    throw error;
  }
};

const reverseGeocode = async (lat, lng) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK") throw new Error("Reverse geocoding failed");

    const components = data.results[0].address_components;

    const city = components.find((c) => c.types.includes("locality"))?.long_name;
    const zone = components.find(
      (c) =>
        c.types.includes("sublocality") ||
        c.types.includes("sublocality_level_1")
    )?.long_name;

    return { city, zone };
  } catch (err) {
    console.error("Reverse geocoding error:", err.message);
    return null;
  }
};

function isWithinZone(userLat, userLng, zone, zoneWindowConfig = null, nowMoment = null) {
  const activeRange = getActiveZoneRange(zone, zoneWindowConfig, nowMoment);
  if (!activeRange || !zone?.latitude || !zone?.longitude) return false;

  const userLocation = { lat: userLat, lon: userLng };
  const zoneLocation = { lat: zone.latitude, lon: zone.longitude };
  const distance = haversine(userLocation, zoneLocation);

  return distance <= activeRange;
}

async function getStoresWithinRadius(userLat, userLng) {
  const [allStores, cityZoneDocs, zoneWindowConfig] = await Promise.all([
    Store.find({ status: true }).lean(),
    ZoneData.find({}),
    getZoneWindowConfig(),
  ]);

  const nowInZoneTimezone = getNowInTimezone(zoneWindowConfig?.timezone);
  const activeZones = cityZoneDocs.flatMap((doc) =>
    doc.zones.filter((z) => z.status === true)
  );

  const matchedZones = activeZones.filter((zone) =>
    isWithinZone(userLat, userLng, zone, zoneWindowConfig, nowInZoneTimezone)
  );

  if (matchedZones.length === 0) {
    return {
      zoneAvailable: false,
      matchedStores: [],
    };
  }

  const matchedZoneIds = matchedZones.map((z) => z._id.toString());

  const zoneStores = allStores.filter(
    (store) =>
      Array.isArray(store.zone) &&
      store.zone.some((z) => matchedZoneIds.includes(z._id.toString()))
  );

  const currentMinute = nowInZoneTimezone.hours() * 60 + nowInZoneTimezone.minutes();

  const openStores = zoneStores.filter((store) => {
    const { openTime, closeTime } = store;
    if (openTime && closeTime) {
      const openMinute = parseWindowMinutes(openTime);
      const closeMinute = parseWindowMinutes(closeTime);
      if (openMinute === null || closeMinute === null) return true;
      return isMinuteInWindow(currentMinute, openMinute, closeMinute);
    }
    return true;
  });

  if (openStores.length === 0) {
    return {
      zoneAvailable: true,
      storesOpen: false,
      matchedStores: [],
    };
  }

  const matchedStores = openStores.map((store) => ({
    ...store,
    soldBy: {
      storeId: store._id,
      storeName: store.Authorized_Store ? "Fivlia" : store.storeName,
      official: store.Authorized_Store ? 1 : 0,
    },
  }));

  return {
    zoneAvailable: true,
    storesOpen: true,
    matchedStores,
  };
}

function isWithinBanner(userLat, userLng, zone, zoneWindowConfig = null, nowMoment = null) {
  const activeRange = getActiveZoneRange(zone, zoneWindowConfig, nowMoment);
  if (!activeRange || !zone?.latitude || !zone?.longitude) return false;

  const userLocation = { lat: userLat, lon: userLng };
  const zoneLocation = { lat: zone.latitude, lon: zone.longitude };
  const distance = haversine(userLocation, zoneLocation);

  return distance <= activeRange;
}

async function getBannersWithinRadius(userLat, userLng, banners = []) {
  const [allZones, zoneWindowConfig] = await Promise.all([
    ZoneData.find({}),
    getZoneWindowConfig(),
  ]);
  const nowInZoneTimezone = getNowInTimezone(zoneWindowConfig?.timezone);

  return banners.filter((banner) => {
    if (!Array.isArray(banner.city)) return false;

    return banner.city.some((cityObj) => {
      const cityDoc = allZones.find(
        (city) => city.city.toLowerCase() === cityObj.name.toLowerCase()
      );

      if (!cityDoc) return false;

      const validZone = cityDoc.zones.find(
        (zone) =>
          zone.status === true &&
          isWithinBanner(userLat, userLng, zone, zoneWindowConfig, nowInZoneTimezone)
      );

      return Boolean(validZone);
    });
  });
}

function findAvailableDriversNearUser(userLat, userLng, driverLat, driverLng) {
  const user = { lat: userLat, lon: userLng };
  const driverz = { lat: driverLat, lon: driverLng };

  return Math.round(haversine(user, driverz));
}

module.exports = {
  calculateDeliveryTime,
  reverseGeocode,
  getStoresWithinRadius,
  getBannersWithinRadius,
  findAvailableDriversNearUser,
  isWithinZone,
  getZoneWindowConfig,
  getCurrentZoneWindowMode,
  getActiveZoneRange,
};

