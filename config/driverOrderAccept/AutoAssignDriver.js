const {
  findAvailableDriversNearUser,
  isWithinZone,
  getZoneWindowConfig,
  getActiveZoneRange,
} = require("../google");
const assignDriverModule = require("./assignDriver");
const assignWithSocketLoop = assignDriverModule;
const { getBusyDriverIds } = assignDriverModule;
const Address = require("../../modals/Address");
const { Order } = require("../../modals/order");
const driver = require("../../modals/driver");
const Store = require("../../modals/store");
const { ZoneData } = require("../../modals/cityZone");
const admin = require("../../firebase/firebase");
const telegramOrderLog = require("../../utils/telegram_logs");
const db = admin.firestore();

const safeText = (value, fallback = "N/A") => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
};

const safeNumberText = (value, fallback = "N/A", fractionDigits = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num.toFixed(fractionDigits);
};

const telegramDriverId = (driverDoc) =>
  safeText(driverDoc?.driverId, safeText(driverDoc?._id));

const safeTelegramLog = async (title, data) => {
  try {
    await telegramOrderLog(title, data);
  } catch (err) {
    console.error("Telegram dispatch log failed:", err.message);
  }
};

const buildDriverLine = (index, item) =>
  `${index + 1}. ${safeText(item.driverName)} (${safeText(item.driverId)}) | distance=${safeNumberText(item.distanceM)}m | ${item.withinRadius ? "within_radius" : "out_of_radius"}${item.busy ? " | busy" : ""}${item.rejected ? " | rejected" : ""}`;

const activeAssignments = new Map();

const runAutoAssignDriver = async (orderId) => {
  try {
    const order = await Order.findById(orderId);
    if (!order) {
      console.warn(`Order ${orderId} not found for auto assignment`);
      return;
    }

    if (order.driver?.driverId) {
      console.log(`Order ${order.orderId} already has a driver assigned`);
      return;
    }

    const user = await Address.findById(order.addressId);
    if (!user) {
      console.warn(`Address not found for order ${order.orderId}`);
      return;
    }

    const storeDoc = await Store.findById(order.storeId).lean();
    const userLat = user.latitude;
    const userLng = user.longitude;
    const drivers = await driver.find({ activeStatus: "online", status: true });
    const busyDriverIds = await getBusyDriverIds(order.orderId);

    const zoneDocs = await ZoneData.find({});
    const zoneWindowConfig = await getZoneWindowConfig();

    let matchedZone = null;

    for (const city of zoneDocs) {
      const zone = city.zones.find(
        (z) =>
          z.status === true &&
          isWithinZone(userLat, userLng, z, zoneWindowConfig),
      );

      if (zone) {
        matchedZone = zone;
        break;
      }
    }

    if (!matchedZone) {
      console.log("User not in any delivery zone", {
        orderId: order.orderId,
        storeId: order.storeId?.toString?.() || String(order.storeId || ""),
      });
      return;
    }

    const zoneRange = getActiveZoneRange(matchedZone, zoneWindowConfig);
    const zoneName = safeText(
      matchedZone.zoneName || matchedZone.name || matchedZone.title || matchedZone.label,
    );
    const zoneRadiusM = Number(zoneRange || 5000);

    await safeTelegramLog("NEW ORDER RECEIVED", [
      { label: "orderId", value: order.orderId },
      { label: "zoneName", value: zoneName },
      { label: "zoneRadiusM", value: zoneRadiusM },
      { label: "sellerName", value: storeDoc?.storeName },
      { label: "storeId", value: order.storeId },
      { label: "orderAcceptedBy", value: order.orderAcceptedBy },
    ]);

    console.log("NEW ORDER RECEIVED", {
      orderId: order.orderId,
      zoneName,
      zoneRadiusM,
      sellerName: storeDoc?.storeName || "N/A",
      storeId: order.storeId?.toString?.() || String(order.storeId || ""),
      orderAcceptedBy: order.orderAcceptedBy || "N/A",
    });

    const driverTrace = [];
    const eligibleDrivers = [];

    for (const d of drivers) {
      const driverId = d._id?.toString?.() || String(d._id || "");
      const logDriverId = telegramDriverId(d);
      const driverIdentifiers = [driverId, d.driverId?.toString?.()].filter(Boolean);
      const isBusy = driverIdentifiers.some((id) => busyDriverIds.has(id));
      // Per-cycle rejection is owned by Dispatch and applied in
      // assignWithBroadcast. Assignment history must not permanently exclude
      // a driver after the retry policy deliberately resets rejected drivers.
      const isRejected = false;

      let distance = null;
      let withinRadius = false;

      try {
        const driverDocRef = db.collection("updates").doc(driverId);
        const driverSnapshot = await driverDocRef.get();
        if (driverSnapshot.exists) {
          const driverData = driverSnapshot.data() || {};
          distance = findAvailableDriversNearUser(
            userLat,
            userLng,
            driverData.latitude,
            driverData.longitude,
          );
          withinRadius = Number(distance) <= zoneRadiusM;
        }
      } catch (err) {
        console.error("Driver location lookup failed:", {
          orderId: order.orderId,
          driverId,
          error: err.message,
        });
      }

      driverTrace.push({
        driverId,
        logDriverId,
        driverName: safeText(d.driverName),
        distanceM: distance,
        withinRadius,
        busy: isBusy,
        rejected: isRejected,
      });

      if (!isBusy && !isRejected && withinRadius) {
        eligibleDrivers.push({ driverz: d, distance: distance ?? zoneRadiusM });
      }
    }

    eligibleDrivers.sort((a, b) => a.distance - b.distance);

    await safeTelegramLog("ALL DRIVERS TRACED", [
      { label: "orderId", value: order.orderId },
      { label: "zoneName", value: zoneName },
      { label: "zoneRadiusM", value: zoneRadiusM },
      { label: "totalOnlineDrivers", value: drivers.length },
      { label: "busyDrivers", value: busyDriverIds.size },
      { label: "rejectedDrivers", value: "managed_by_dispatch_state" },
      ...driverTrace.map((item, index) => ({
        label: `${index + 1}`,
        value: `${index + 1}. ${safeText(item.driverName)} (${safeText(item.logDriverId)}) | distance=${safeNumberText(item.distanceM)}m | ${item.withinRadius ? "within_radius" : "out_of_radius"}${item.busy ? " | busy" : ""}${item.rejected ? " | rejected" : ""}`,
      })),
    ]);

    await safeTelegramLog("ELIGIBLE DRIVERS", [
      { label: "orderId", value: order.orderId },
      { label: "zoneName", value: zoneName },
      { label: "eligibleCount", value: eligibleDrivers.length },
      ...eligibleDrivers.map((item, index) => ({
        label: `${index + 1}`,
        value: `${safeText(item.driverz.driverName)} (${safeText(item.driverz.driverId, safeText(item.driverz._id))}) | distance=${safeNumberText(item.distance)}m`,
      })),
    ]);

    console.log("ELIGIBLE DRIVERS", {
      orderId: order.orderId,
      zoneName,
      eligibleCount: eligibleDrivers.length,
      drivers: eligibleDrivers.map((item) => ({
        driverId: item.driverz._id?.toString?.() || String(item.driverz._id || ""),
        driverName: safeText(item.driverz.driverName),
        distanceM: item.distance,
      })),
    });

    const SPECIAL_STORE_ID = "68c24838f9cf1104714f2f23";
    const SPECIAL_DRIVER_IDS = [
      "69c66c8b11e3744c3d212e7a",
      "68f1d8c5a72119a8c21c6c34",
    ];

    let finalDrivers = eligibleDrivers.map((d) => d.driverz);

    if (String(order.storeId) === SPECIAL_STORE_ID) {
      finalDrivers = finalDrivers.filter((drv) =>
        SPECIAL_DRIVER_IDS.includes(drv._id.toString()),
      );
    }

    await safeTelegramLog("FINAL DISPATCH DRIVER SET", [
      { label: "orderId", value: order.orderId },
      { label: "zoneName", value: zoneName },
      { label: "finalDriverCount", value: finalDrivers.length },
      ...finalDrivers.map((item, index) => ({
        label: `${index + 1}`,
        value: `${safeText(item.driverName)} (${safeText(item.driverId, safeText(item._id))})`,
      })),
    ]);

    console.log("FINAL DISPATCH DRIVER SET", {
      orderId: order.orderId,
      zoneName,
      finalDriverCount: finalDrivers.length,
      drivers: finalDrivers.map((item) => ({
        driverId: item._id?.toString?.() || String(item._id || ""),
        driverName: safeText(item.driverName),
      })),
    });

    await assignWithSocketLoop(order, finalDrivers);
  } catch (err) {
    console.error("Auto assignment error:", err);
  }
};

const autoAssignDriver = (orderId) => {
  const key = String(orderId || "");
  if (!key) return Promise.resolve();
  if (activeAssignments.has(key)) return activeAssignments.get(key);

  const task = runAutoAssignDriver(orderId).finally(() => {
    activeAssignments.delete(key);
  });
  activeAssignments.set(key, task);
  return task;
};

module.exports = autoAssignDriver;
