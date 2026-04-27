const {
  findAvailableDriversNearUser,
  isWithinZone,
  getZoneWindowConfig,
  getActiveZoneRange,
} = require("../google");
const assignWithSocketLoop = require("./assignDriver");
const Address = require("../../modals/Address");
const Assign = require("../../modals/driverModals/assignments");
const { Order } = require("../../modals/order");
const driver = require("../../modals/driver");
const { ZoneData } = require("../../modals/cityZone");
const admin = require("../../firebase/firebase");
const telegramOrderLog = require("../../utils/telegram_logs");
const db = admin.firestore();

const autoAssignDriver = async (orderId) => {
  try {
    const order = await Order.findById(orderId);
    const user = await Address.findById(order.addressId);

    const userLat = user.latitude;
    const userLng = user.longitude;
    const drivers = await driver.find({ activeStatus: "online", status: true });
    const busyAssignments = await Assign.find({
      orderStatus: "Accepted",
    }).select("driverId");
    const busyDriverIds = busyAssignments.map((a) => String(a.driverId));

    const rejectedAssignmentsForOrder = await Assign.find({
      orderStatus: "Rejected",
      orderId: order.orderId,
    }).select("driverId");

    const rejectedDriverIdsForOrder = rejectedAssignmentsForOrder.map((a) =>
      String(a.driverId),
    );

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
      console.log("User not in any delivery zone");
      return;
    }

    const zoneRange = getActiveZoneRange(matchedZone, zoneWindowConfig);

    const availableDrivers = [];
    const rawDriversWithDistance = [];

    for (let d of drivers) {
      if (busyDriverIds.includes(String(d._id))) continue;
      if (rejectedDriverIdsForOrder.includes(String(d._id))) continue;
      const driverDocRef = db.collection("updates").doc(String(d._id));
      const driverSnapshot = await driverDocRef.get();
      if (!driverSnapshot.exists) {
        continue;
      }
      const driverData = driverSnapshot.data();
      // console.log('driverData',driverData)
      const driverLat = driverData.latitude;
      const driverLng = driverData.longitude;

      const distance = findAvailableDriversNearUser(
        userLat,
        userLng,
        driverLat,
        driverLng,
      );
      console.log("distance", distance);

      rawDriversWithDistance.push(`${d.driverName} (${d._id}) | ${distance}m`);

      if (distance <= (zoneRange || 5000)) {
        console.log(
          "Raw Drivers",
          drivers.map((dr) => String(dr.driverName)),
        );

        console.log("Busy Drivers", busyDriverIds);

        await telegramOrderLog("🚚 BUSY DRIVERS", {
          orderId: order.orderId,
          busyDrivers: busyDriverIds,
        });
        console.log("Rejected Drivers for Order", rejectedDriverIdsForOrder);
        await telegramOrderLog("❌ REJECTED DRIVERS", {
          orderId: order.orderId,
          rejectedDrivers: rejectedDriverIdsForOrder,
        });
        availableDrivers.push({ driverz: d, distance });
        console.log("Available driver:", availableDrivers);
      }
    }

    availableDrivers.sort((a, b) => a.distance - b.distance);

    await telegramOrderLog("🚚 RAW DRIVERS", {
      orderId: order.orderId,
      drivers: rawDriversWithDistance,
    });

    await telegramOrderLog("📍 AVAILABLE DRIVERS", {
      orderId: order.orderId,
      drivers: availableDrivers.map(
        (d) => `${d.driverz.driverName} (${d.driverz._id}) | ${d.distance}m`,
      ),
    });
    console.log("Available driver After Sorting:", availableDrivers);

    assignWithSocketLoop(
      order,
      availableDrivers.map((d) => d.driverz),
    );
  } catch (err) {
    console.error(err);
  }
};

module.exports = autoAssignDriver;
