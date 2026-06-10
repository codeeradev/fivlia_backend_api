const foodTypeModel = require("../modals/foodType");
const Seller = require("../modals/store");
const Rating = require("../modals/rating");
const Stock = require("../modals/StoreStock");
const User = require("../modals/User");
const { getStoresWithinRadius } = require("../config/google");
const { Order, TempOrder } = require("../modals/order");

exports.addFood = async (req, res) => {
  try {
    const { name, description, filter, commission } = req.body;
    const image = `/${req.files?.image?.[0]?.key}`;

    const parsedFilter = filter ? JSON.parse(filter) : [];

    const newFood = await foodTypeModel.create({
      name,
      description,
      image,
      filter: parsedFilter,
      commission,
    });

    return res
      .status(201)
      .json({ message: "Food item added successfully", food: newFood });
  } catch (error) {
    console.error("Error adding food item:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAllFoods = async (req, res) => {
  try {
    const foods = await foodTypeModel
      .find()
      .select("-__v")
      .sort({ createdAt: -1 });
    return res.status(200).json(foods);
  } catch (error) {
    console.error("Error fetching food items:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.getActiveFoods = async (req, res) => {
  try {
    const foods = await foodTypeModel
      .find({ status: true })
      .select("-__v -createdAt -updatedAt -orderCount")
      .sort({ createdAt: -1 });
    return res.status(200).json(foods);
  } catch (error) {
    console.error("Error fetching active food items:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.updateFood = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, filter, commission } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (description) updateData.description = description;
    if (filter) updateData.filter = JSON.parse(filter);
    if (commission !== undefined) updateData.commission = commission;
    if (req.files?.image?.[0]?.key)
      updateData.image = `/${req.files.image[0].key}`;

    const food = await foodTypeModel.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true },
    );
    if (!food) {
      return res.status(404).json({ message: "Food item not found" });
    }

    return res
      .status(200)
      .json({ message: "Food item updated successfully", food });
  } catch (error) {
    console.error("Error updating food item:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.deleteFood = async (req, res) => {
  try {
    const { id } = req.params;
    const food = await foodTypeModel.findByIdAndDelete(id);
    if (!food) {
      return res.status(404).json({ message: "Food item not found" });
    }
    return res.status(200).json({ message: "Food item deleted successfully" });
  } catch (error) {
    console.error("Error deleting food item:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getFoodSeller = async (req, res) => {
  try {
    const { veg, filter } = req.query;

    console.log("Fetching foods with sellers..." ,req.query);

    const userId = req.user._id;

    const user = await User.findById(userId).lean();

    if (user?.location?.latitude == null || user?.location?.longitude == null) {
      return res.status(400).json({
        message: "User location not found",
      });
    }

    const userLat = user.location.latitude;
    const userLng = user.location.longitude;

    const storesWithinRadius = await getStoresWithinRadius(userLat, userLng);

    const allowedStores = Array.isArray(storesWithinRadius?.matchedStores)
      ? storesWithinRadius.matchedStores
      : [];

    if (!allowedStores.length) {
      return res.status(200).json({
        finalFoods: [],
        allSellers: [],
      });
    }
    const allowedStoreIds = allowedStores.map((store) => store._id.toString());
    // =========================================================
    // SELLER QUERY
    // =========================================================
    const sellerQuery = {
      typeId: new mongoose.Types.ObjectId("69cf8a31ad92aee54ecb1e72"),
      status: true,
      Authorized_Store: false,
    };

    // veg filter
    // if (veg === "true") {
    //   sellerQuery.isVeg = "veg";
    // }

    // custom filters
    if (["gym", "snack", "healthy"].includes(filter)) {
      sellerQuery.filter = filter;
    }

    // =========================================================
    // GET ALL ACTIVE FOODS
    // =========================================================
    const foods = await foodTypeModel
      .find({ status: true })
      .select("-__v -createdAt -updatedAt -orderCount")
      .sort({ createdAt: -1 })
      .lean();

    // =========================================================
    // GET SELLERS
    // =========================================================
    let sellers = await Seller.find({
      ...sellerQuery,
      _id: { $in: allowedStoreIds },
    })
      .select(
        "storeName image referralCode advertisementImages sellerFreeDeliveryEnabled sellerFreeDeliveryLimit fullAddress foodTypes isVeg",
      )
      .lean();

    const sellerIds = sellers.map((s) => s._id);

    const deliveredOrders = await Order.aggregate([
      {
        $match: {
          storeId: { $in: sellerIds },
          orderStatus: "Delivered",
        },
      },
      {
        $group: {
          _id: "$storeId",
          totalDeliveredOrders: { $sum: 1 },
        },
      },
    ]);

    const deliveredOrderMap = {};

    deliveredOrders.forEach((item) => {
      deliveredOrderMap[item._id.toString()] = item.totalDeliveredOrders;
    });
    // =========================================================
    // RATINGS
    // =========================================================
    const ratings = await Rating.find({
      storeId: { $in: sellerIds },
    }).lean();

    // =========================================================
    // RATINGS MAP
    // =========================================================
    const ratingsByStore = ratings.reduce((acc, r) => {
      const id = r.storeId.toString();

      if (!acc[id]) {
        acc[id] = {
          total: 0,
          count: 0,
        };
      }

      acc[id].total += r.rating || 0;
      acc[id].count += 1;

      return acc;
    }, {});

    // =========================================================
    // TOP OFFERS + ITEM COUNT
    // =========================================================
    const topOffers = await Stock.aggregate([
      {
        $match: {
          storeId: { $in: sellerIds },
        },
      },
      {
        $unwind: "$stock",
      },
      {
        $match: {
          "stock.mrp": { $gt: 0 },
          "stock.price": { $gt: 0 },
        },
      },
      {
        $addFields: {
          discount: {
            $multiply: [
              {
                $divide: [
                  { $subtract: ["$stock.mrp", "$stock.price"] },
                  "$stock.mrp",
                ],
              },
              100,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$storeId",
          maxDiscount: { $max: "$discount" },
          totalItems: { $sum: 1 },
        },
      },
      {
        $sort: {
          maxDiscount: -1,
        },
      },
    ]);

    // =========================================================
    // OFFER + ITEM MAP
    // =========================================================
    const offerMap = {};
    const itemCountMap = {};

    topOffers.forEach((o) => {
      offerMap[o._id.toString()] = Number(o.maxDiscount.toFixed(1));
      itemCountMap[o._id.toString()] = o.totalItems;
    });

    // =========================================================
    // 50% OFF FILTER
    // =========================================================
    if (filter === "50%off") {
      sellers = sellers.filter((seller) => {
        const offer = offerMap[seller._id.toString()] || 0;

        return offer >= 50;
      });
    }

    // =========================================================
    // SORT SELLERS BY OFFER DESC
    // =========================================================
    sellers.sort((a, b) => {
      const offerA = offerMap[a._id.toString()] || 0;
      const offerB = offerMap[b._id.toString()] || 0;

      return offerB - offerA;
    });

    const storeDistanceMap = {};

    allowedStores.forEach((store) => {
      storeDistanceMap[store._id.toString()] = store.distance || 999999;
    });

    // =========================================================
    // FINAL FOODS
    // =========================================================
    const finalFoods = foods.map((food) => {
      const matchedSellers = sellers
        .filter((seller) =>
          seller.foodTypes?.some((id) => id.toString() === food._id.toString()),
        )
        .map((store) => {
          const stats = ratingsByStore[store._id.toString()] || {
            total: 0,
            count: 0,
          };

          const avg = stats.count ? stats.total / stats.count : 0;

          return {
            storeId: store._id,
            storeName: store.storeName,
            distance: storeDistanceMap[store._id.toString()] || null,

            topProductOffer: offerMap[store._id.toString()]
              ? `${offerMap[store._id.toString()]}`
              : null,

            totalItems: itemCountMap[store._id.toString()] || 0,

            image: store.image,
            referralCode: store.referralCode,
            advertisementImages: store.advertisementImages,
            sellerFreeDeliveryEnabled: store.sellerFreeDeliveryEnabled,
            sellerFreeDeliveryLimit: store.sellerFreeDeliveryLimit,
            isVeg: store.isVeg,
            fullAddress: store.fullAddress,
            deliveredOrders: deliveredOrderMap[store._id.toString()] || 0,
            averageRating: avg.toFixed(1),
            ratingCount: stats.count,
          };
        })
        .sort((a, b) => {
          return (
            Number(b.topProductOffer || 0) - Number(a.topProductOffer || 0)
          );
        });

      let evenMatchedSellers = [...matchedSellers];

      if (evenMatchedSellers.length % 2 !== 0) {
        evenMatchedSellers.pop(); // remove last seller if odd count
      }

      return {
        ...food,
        sellers: evenMatchedSellers,
      };
    });

    // =========================================================
    // ALL SELLERS
    // =========================================================
    const allSellers = sellers
      .map((store) => {
        const stats = ratingsByStore[store._id.toString()] || {
          total: 0,
          count: 0,
        };

        const avg = stats.count ? stats.total / stats.count : 0;

        return {
          storeId: store._id,
          storeName: store.storeName,

          topProductOffer: offerMap[store._id.toString()]
            ? `${offerMap[store._id.toString()]}`
            : null,

          totalItems: itemCountMap[store._id.toString()] || 0,

          image: store.image,
          referralCode: store.referralCode,
          advertisementImages: store.advertisementImages,
          sellerFreeDeliveryEnabled: store.sellerFreeDeliveryEnabled,
          sellerFreeDeliveryLimit: store.sellerFreeDeliveryLimit,
          isVeg: store.isVeg,
          fullAddress: store.fullAddress,
          deliveredOrders: deliveredOrderMap[store._id.toString()] || 0,
          averageRating: avg.toFixed(1),
          ratingCount: stats.count,
        };
      })
      .sort((a, b) => {
        return Number(b.topProductOffer || 0) - Number(a.topProductOffer || 0);
      });

    let evenSellers = [...allSellers];

    if (evenSellers.length % 2 !== 0) {
      evenSellers.pop(); // remove last seller if odd count
    }

    return res.status(200).json({
      finalFoods,
      allSellers: evenSellers,
    });
  } catch (error) {
    console.error("Error fetching foods with sellers:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.addFoodToSeller = async (req, res) => {
  try {
    const { sellerId, foodId } = req.body;

    const seller = await Seller.findOne({
      _id: sellerId,
      $or: [{ sellFood: true }, { businessType: "FSSAI" }],
      status: true,
      Authorized_Store: false,
    });

    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const foodIds = Array.isArray(foodId) ? foodId : foodId ? [foodId] : [];
    const uniqueFoodIds = [
      ...new Set(foodIds.map((id) => id?.toString()).filter(Boolean)),
    ];

    if (!uniqueFoodIds.length) {
      seller.foodTypes = [];
      await seller.save();
      return res.status(200).json({
        message: "Food types updated successfully",
        foodTypes: seller.foodTypes,
      });
    }

    const activeFoods = await foodTypeModel
      .find({ _id: { $in: uniqueFoodIds }, status: true })
      .select("_id")
      .lean();

    seller.foodTypes = activeFoods.map((food) => food._id);
    await seller.save();

    return res.status(200).json({
      message: "Food types updated successfully",
      foodTypes: seller.foodTypes,
    });
  } catch (error) {
    console.error("Error adding food type to seller:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.removeFoodFromSeller = async (req, res) => {
  try {
    const { sellerId, foodId } = req.body;

    const seller = await Seller.findOne({
      _id: sellerId,
      $or: [{ sellFood: true }, { businessType: "FSSAI" }],
      status: true,
      Authorized_Store: false,
    });
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    const hasFoodType = seller.foodTypes.some((id) => id.toString() === foodId);

    if (!hasFoodType) {
      return res
        .status(400)
        .json({ message: "Food type not associated with this seller" });
    }

    seller.foodTypes = seller.foodTypes.filter(
      (id) => id.toString() !== foodId,
    );
    await seller.save();

    return res
      .status(200)
      .json({ message: "Food type removed from seller successfully" });
  } catch (error) {
    console.error("Error removing food type from seller:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
