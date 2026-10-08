const { CityData, ZoneData } = require("../modals/cityZone");
const Location = require("../modals/location");
const User = require("../modals/User");
const Address = require("../modals/Address");
const { getStoresWithinRadius } = require("../config/google");
const StoreStock = require("../modals/StoreStock");
const Store = require("../modals/store");
const haversine = require("haversine-distance");
const mongoose = require("mongoose");
const {
  buildCartWarning,
  hasZoneToGlobalCartConflict,
} = require("../utils/cartAddressWarning");
const { Cart } = require("../modals/cart");

const toPositiveNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

// Keeps the user's saved location (user.location) in sync with an address, so
// location based APIs (getMainCategory, banners, products ...) follow the address.
// It never throws and never changes the response of the calling API.
const syncUserLocationFromAddress = async (userId, latitude, longitude) => {
  try {
    if (!userId) return;
    if (
      latitude === undefined || latitude === null || latitude === "" ||
      longitude === undefined || longitude === null || longitude === ""
    ) {
      return;
    }
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    ) {
      return;
    }

    const user = await User.findById(userId).select("mobileNumber").lean();
    if (!user) return;
    // same demo-account skip as updateLocation
    if (user.mobileNumber === "+919999999999") return;

    // dotted $set keeps location.city / location.zone untouched
    await User.findByIdAndUpdate(userId, {
      $set: { "location.latitude": lat, "location.longitude": lng },
    });
  } catch (err) {
    console.error("syncUserLocationFromAddress error:", err.message);
  }
};

const getZoneStoreCountMap = async (zoneDocs) => {
  const zoneIds = zoneDocs.flatMap((doc) =>
    (doc.zones || []).map((zone) => zone?._id).filter(Boolean),
  );

  if (!zoneIds.length) {
    return new Map();
  }

  const storeCounts = await Store.aggregate([
    {
      $match: {
        "zone._id": { $in: zoneIds },
      },
    },
    { $unwind: "$zone" },
    {
      $match: {
        "zone._id": { $in: zoneIds },
      },
    },
    {
      $group: {
        _id: {
          zoneId: "$zone._id",
          storeId: "$_id",
        },
      },
    },
    {
      $group: {
        _id: "$_id.zoneId",
        storeCount: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    storeCounts.map((item) => [item._id.toString(), item.storeCount]),
  );
};

const attachStoreCountsToZoneDocs = async (
  zoneDocs,
  { onlyActiveZones = false } = {},
) => {
  const normalizedZoneDocs = zoneDocs
    .map((doc) => {
      const zones = Array.isArray(doc.zones) ? doc.zones : [];
      const filteredZones = onlyActiveZones
        ? zones.filter((zone) => zone?.status === true)
        : zones;

      return {
        ...doc,
        zones: filteredZones,
      };
    })
    .filter((doc) => doc.zones.length > 0 || !onlyActiveZones);

  const storeCountMap = await getZoneStoreCountMap(normalizedZoneDocs);

  return normalizedZoneDocs.map((doc) => ({
    ...doc,
    zones: doc.zones.map((zone) => ({
      ...zone,
      storeCount: storeCountMap.get(zone._id.toString()) || 0,
    })),
  }));
};

exports.AvalibleCity = async (req, res) => {
  try {
    const { city, state, fullAddress, latitude, longitude } = req.body;

    const dataToInsert = {
      city,
      state,
      fullAddress,
      latitude,
      longitude,
      status: true,
      createdAt: new Date(),
    };
    const result = await CityData.create(dataToInsert);
    res
      .status(200)
      .json({ message: "City added successfully", result: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error adding city", error: err.message });
  }
};

exports.AddZone = async (req, res) => {
  try {
    const { city, address, zoneTitle, latitude, longitude, range, nightRange } =
      req.body;
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    const parsedRange = toPositiveNumber(range);
    const parsedNightRange = toPositiveNumber(nightRange);

    if (
      !city ||
      !address ||
      !zoneTitle ||
      !Number.isFinite(parsedLatitude) ||
      !Number.isFinite(parsedLongitude) ||
      (!parsedRange && !parsedNightRange)
    ) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const zone = {
      address: address.trim(),
      zoneTitle: zoneTitle.trim(),
      latitude: parsedLatitude,
      longitude: parsedLongitude,
      range: parsedRange || parsedNightRange,
      nightRange: parsedNightRange,
      status: true,
      cashOnDelivery: false,
      createdAt: new Date(),
    };

    await ZoneData.findOneAndUpdate(
      { city },
      { $push: { zones: zone } },
      { upsert: true },
    );

    return res.status(200).json({
      message: "Zone saved successfully",
      city,
    });
  } catch (err) {
    console.error("Error saving location:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.deleteZone = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid zone id" });
    }

    const zoneDoc = await ZoneData.findOne({ "zones._id": id }).lean();

    if (!zoneDoc) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const storeCount = await Store.countDocuments({ "zone._id": id });

    if (storeCount > 0) {
      return res.status(400).json({
        message: "Zone cannot be deleted because stores are assigned to it",
        storeCount,
      });
    }

    const result = await ZoneData.updateOne(
      { "zones._id": id },
      { $pull: { zones: { _id: id } } },
    );

    if (!result.modifiedCount) {
      return res.status(404).json({ message: "Zone not found" });
    }

    return res.status(200).json({
      message: "Zone deleted successfully",
      storeCount: 0,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An error occurred" });
  }
};

exports.addCity = async (req, res) => {
  try {
    const { city, zone } = req.body;

    if (!city || !Array.isArray(zone)) {
      return res
        .status(400)
        .json({ message: "City and zone array are required" });
    }

    let cityDoc = await CityData.findOne({ city });

    if (!cityDoc) {
      const newDoc = new CityData({
        city,
        zones: zone,
      });
      await newDoc.save();
    } else {
      const mergedZones = Array.from(new Set([...cityDoc.zones, ...zone]));
      cityDoc.zones = mergedZones;
      await cityDoc.save();
    }

    return res.status(200).json({ message: "City/Zone merged successfully" });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.updateCityStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, city, state, latitude, longitude, fullAddress } = req.body;

    const cityDoc = await CityData.findByIdAndUpdate(
      id,
      { status, city, state, latitude, longitude, fullAddress },
      { new: true },
    );
    return res
      .status(200)
      .json({ message: "Status updated successfully", data: cityDoc });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.getAviableCity = async (req, res) => {
  try {
    const status = await CityData.find({ status: true });
    res.json(status);
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.getCity = async (req, res) => {
  const city = await CityData.find();
  res.json(city);
};

exports.updateLocation = async (req, res) => {
  try {
    const { id } = req.user; // get from token or body
    const { latitude, longitude } = req.body;

    if (!latitude || !longitude || !id) {
      return res.status(400).json({ message: "Missing userId or coordinates" });
    }

    const user = await User.findById(id);
    if (user.mobileNumber === "+919999999999") {
      return res
        .status(200)
        .json({ message: "Location updated successfully!" });
    }

    const updatedUser = await User.findByIdAndUpdate(
      id,
      {
        $set: {
          location: {
            latitude,
            longitude,
          },
        },
      },
      { new: true },
    );

    // Get all user addresses
    const addresses = await Address.find({ userId: id });
    if (addresses.length > 0) {
      // Compute nearest one using haversine distance
      let nearestAddress = null;
      let shortestDistance = Infinity;

      addresses.forEach((addr) => {
        if (addr.latitude && addr.longitude) {
          const distance = haversine(
            { lat: latitude, lon: longitude },
            { lat: addr.latitude, lon: addr.longitude },
          );
          if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestAddress = addr;
          }
        }
      });

      if (nearestAddress) {
        await Address.updateMany({ userId: id }, { $set: { default: false } });
        await Address.findByIdAndUpdate(
          nearestAddress._id,
          { $set: { default: true } },
          { new: true },
        );
      }
    }

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "Location updated successfully!",
      location: updatedUser.location,
    });
  } catch (error) {
    console.error("❌ Location update error:", error);
    return res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

exports.getAllZone = async (req, res) => {
  try {
    const cityStatus = await CityData.find({ status: true });
    const activeCityNames = cityStatus.map((city) => city.city);

    const zoneDocs = await ZoneData.find({
      city: { $in: activeCityNames },
    }).lean();
    const zones = await attachStoreCountsToZoneDocs(zoneDocs);
    res.json(zones);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ResponseMsg: "An Error Occured" });
  }
};

exports.getZone = async (req, res) => {
  try {
    const cityStatus = await CityData.find({ status: true });
    const activeCityNames = cityStatus.map((city) => city.city);
    const zones = await ZoneData.find({
      status: true,
      city: { $in: activeCityNames },
    });
    res.json(zones);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ResponseMsg: "An Error Occured" });
  }
};

exports.updateZoneStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      city,
      zoneTitle,
      address,
      latitude,
      longitude,
      range,
      nightRange,
      status,
      cashOnDelivery,
    } = req.body;

    const parsedLatitude =
      latitude === undefined ? undefined : Number(latitude);
    const parsedLongitude =
      longitude === undefined ? undefined : Number(longitude);
    const parsedRange = toPositiveNumber(range);
    const parsedNightRange = toPositiveNumber(nightRange);

    if (!city || typeof city !== "string") {
      return res.status(400).json({ message: "City is required" });
    }

    const currentCityDoc = await ZoneData.findOne({ "zones._id": id });
    if (!currentCityDoc) {
      return res.status(404).json({ message: "Zone not found" });
    }

    const existingZone = currentCityDoc.zones.find(
      (z) => z._id.toString() === id,
    );
    if (!existingZone) {
      return res
        .status(404)
        .json({ message: "Zone not found inside document" });
    }

    const normalizedZoneTitle =
      typeof zoneTitle === "string" && zoneTitle.trim()
        ? zoneTitle.trim()
        : existingZone.zoneTitle;

    if (currentCityDoc.city === city) {
      await ZoneData.updateOne(
        { city, "zones._id": id },
        {
          $set: {
            "zones.$.zoneTitle": normalizedZoneTitle,
            "zones.$.address": address?.trim() || existingZone.address,
            "zones.$.latitude": Number.isFinite(parsedLatitude)
              ? parsedLatitude
              : existingZone.latitude,
            "zones.$.longitude": Number.isFinite(parsedLongitude)
              ? parsedLongitude
              : existingZone.longitude,
            "zones.$.range": parsedRange ?? existingZone.range,
            "zones.$.status": status ?? existingZone.status,
            "zones.$.nightRange": parsedNightRange ?? existingZone.nightRange,
            "zones.$.cashOnDelivery":
              cashOnDelivery ?? existingZone.cashOnDelivery,
            updatedAt: new Date(),
          },
        },
      );

      return res.status(200).json({
        message: "Zone updated successfully (in-place)",
        updatedZone: { ...existingZone, city },
      });
    }

    const targetCityDoc = await ZoneData.findOne({ city });
    if (!targetCityDoc) {
      return res
        .status(400)
        .json({ message: `Target city '${city}' does not exist.` });
    }

    await ZoneData.updateOne(
      { "zones._id": id },
      { $pull: { zones: { _id: id } } },
    );

    const updatedZone = {
      _id: existingZone._id,
      zoneTitle: normalizedZoneTitle,
      address: address?.trim() || existingZone.address,
      latitude: Number.isFinite(parsedLatitude)
        ? parsedLatitude
        : existingZone.latitude,
      longitude: Number.isFinite(parsedLongitude)
        ? parsedLongitude
        : existingZone.longitude,
      range: parsedRange ?? existingZone.range,
      nightRange: parsedNightRange ?? existingZone.nightRange,
      status: status ?? existingZone.status,
      cashOnDelivery: cashOnDelivery ?? existingZone.cashOnDelivery,
      createdAt: existingZone.createdAt || new Date(),
    };

    await ZoneData.updateOne(
      { city },
      {
        $push: { zones: updatedZone },
        $set: { updatedAt: new Date() },
      },
    );

    return res.status(200).json({
      message: "Zone moved and updated successfully",
      updatedZone,
    });
  } catch (error) {
    console.error("Update error:", error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.addAddress = async (req, res) => {
  try {
    const { id } = req.user;
    // console.log(id);

    const {
      fullName,
      alternateNumber,
      pincode,
      house_No,
      address,
      state,
      latitude,
      longitude,
      city,
      addressType,
      floor,
      landmark,
      range,
    } = req.body;

    const user = await User.findById(id);
    // ✅ Step 1: Fetch all stores

    const userLat = latitude;
    const userLng = longitude;
    const { zoneAvailable, matchedStores, serviceMode } =
      await getStoresWithinRadius(userLat, userLng);

    if (!zoneAvailable) {
      return res.status(200).json({
        status: false,
        message: "Service area not available.",
      });
    }

    if (matchedStores.length === 0) {
      return res.status(200).json({
        status: false,
        message:
          "No store available in your area. Please try a different address.",
      });
    }

    const newAddress = await Address.create({
      userId: user._id,
      fullName,
      mobileNumber: user.mobileNumber,
      alternateNumber,
      pincode,
      house_No,
      address,
      state,
      range,
      latitude,
      longitude,
      city,
      addressType,
      floor,
      landmark,
    });

    // address saved -> move the user's saved location to this address
    await syncUserLocationFromAddress(user._id, latitude, longitude);

    // cart built in a zone but address is now outside every zone -> app shows popup
    const cartWarning = await buildCartWarning(user._id, latitude, longitude);

    return res.status(200).json({
      status: true,
      message: "Address added successfully",
      serviceMode: serviceMode || "local",
      newAddress,
      cartWarning,
    });
  } catch (error) {
    console.error("❌ Error adding address:", error);
    return res.status(500).json({
      status: false,
      message: "Server error",
      error: error.message,
    });
  }
};

exports.getAddress = async (req, res) => {
  try {
    const { id } = req.user;
    //   const { city, zone } = user.location;

    // const addresses = await Address.find({ userId: id }).sort({ createdAt: -1 });

    // const userZoneDoc = await ZoneData.findOne({ city });

    //   const matchedZone = userZoneDoc.zones.find(z =>
    //     z.address.toLowerCase().includes(zone.toLowerCase())
    //   );

    //   const stores = await Store.find({
    //     zone: { $elemMatch: { _id: matchedZone._id } }
    //   });

    //   if (!addresses.length && !stores.length)
    //     return res.json({status:false, message: "Sorry, no stores available in your zone pls change ur address." });

    //     let matched = false;
    // for (const addr of addresses) {
    //   if (
    //     addr.city.toLowerCase() === city.toLowerCase() &&
    //     addr.address.toLowerCase() === zone.toLowerCase()
    //   ) {
    //     matched = addr;
    //     break;
    //   }
    // }

    // await Promise.all(addresses.map(addr =>
    //   Address.findByIdAndUpdate(addr._id, { default: matched && addr._id.equals(matched._id) })
    // ));

    const addresses = await Address.find({
      userId: id,
      isDeleted: { $ne: true },
    }).sort({ createdAt: -1 });

    res.status(200).json({
      addresses,
    });
  } catch (error) {
    console.error("Error adding address:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.EditAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      userId,
      fullName,
      mobileNumber,
      pincode,
      house_No,
      address,
      state,
      latitude,
      longitude,
      city,
      addressType,
      floor,
      landmark,
    } = req.body;

    const edit = await Address.findByIdAndUpdate(id, {
      userId,
      fullName,
      mobileNumber,
      pincode,
      house_No,
      address,
      state,
      latitude,
      longitude,
      city,
      addressType,
      floor,
      landmark,
    });

    // if the edited address is the default one, keep the user's location in sync
    // (owner and coordinates are read from the database, not from the request body)
    if (edit) {
      try {
        const updatedAddress = await Address.findById(id).lean();
        if (updatedAddress && updatedAddress.default === true) {
          await syncUserLocationFromAddress(
            updatedAddress.userId,
            updatedAddress.latitude,
            updatedAddress.longitude,
          );
        }
      } catch (syncErr) {
        console.error("EditAddress location sync error:", syncErr.message);
      }
    }

    return res.status(200).json({ message: "Address Updated Successfuly" });
  } catch (error) {
    return res.status(500).json({ message: "Server error" });
  }
};

exports.deleteAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const deleteAddress = await Address.findByIdAndUpdate(
      id,
      { isDeleted: true },
      { new: true },
    );
    return res
      .status(200)
      .json({ message: "Address Delete Successfuly", deleteAddress });
  } catch (error) {
    console.error(error);

    return res.status(500).json({ message: "Server error" });
  }
};

exports.setDefault = async (req, res) => {
  try {
    const { id: userId } = req.user; // Get user ID from auth middleware
    const { addressId } = req.body;

    await Address.updateMany({ userId }, { $set: { default: false } });

    const setDefault = await Address.findByIdAndUpdate(
      addressId,
      { $set: { default: true } },
      { new: true },
    );

    if (!setDefault) {
      return res
        .status(404)
        .json({ status: false, message: "Address not found" });
    }

    // selected address becomes the user's current location
    await syncUserLocationFromAddress(
      userId,
      setDefault.latitude,
      setDefault.longitude,
    );

    const cartWarning = await buildCartWarning(
      userId,
      setDefault.latitude,
      setDefault.longitude,
    );

    res.status(200).json({
      status: true,
      message: "Default address updated",
      address: setDefault,
      cartWarning,
    });
  } catch (error) {
    console.error("Error setting default address:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Called by the app when the user taps OK on the cart warning popup.
// Re-checks the conflict against the user's current location before emptying the
// cart, so it can never wipe a cart that is still valid.
exports.clearCartOnAddressChange = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const user = await User.findById(userId).select("location").lean();
    if (!user) {
      return res.status(404).json({ status: false, message: "User not found" });
    }

    const conflict = await hasZoneToGlobalCartConflict(
      userId,
      user.location?.latitude,
      user.location?.longitude,
    );
    if (!conflict) {
      return res.status(200).json({
        status: true,
        cleared: false,
        message: "Cart is deliverable to your address, nothing was removed.",
      });
    }

    await Cart.deleteMany({ userId });
    return res.status(200).json({
      status: true,
      cleared: true,
      message: "Cart cleared",
    });
  } catch (error) {
    console.error("clearCartOnAddressChange error:", error);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};
