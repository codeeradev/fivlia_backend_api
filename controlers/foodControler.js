const foodTypeModel = require("../modals/foodType");
const Seller = require("../modals/store");
const Rating = require("../modals/rating");
const Stock = require("../modals/StoreStock");

exports.addFood = async (req, res) => {
  try {
    const { name, description, filter } = req.body;
    const image = `/${req.files?.image?.[0]?.key}`;

    const parsedFilter = filter ? JSON.parse(filter) : [];

    const newFood = await foodTypeModel.create({
      name,
      description,
      image,
      filter: parsedFilter,
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
    const { name, description, filter } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (description) updateData.description = description;
    if (filter) updateData.filter = JSON.parse(filter);
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
    console.log("Fetching foods with sellers...");

    const sellerQuery = {
      $or: [{ sellFood: true }, { businessType: "FSSAI" }],
      status: true,
      Authorized_Store: false,
    };

    // only apply veg filter when veg=true
    if (veg === "true") {
      sellerQuery.isVeg = "veg";
    }

    // apply filter only for valid values
    if (["gym", "snack", "healthy", "50%off"].includes(filter)) {
      sellerQuery.filter = filter;
    }
    // ✅ Get all active foods
    const foods = await foodTypeModel
      .find({ status: true })
      .select("-__v -createdAt -updatedAt -orderCount")
      .sort({ createdAt: -1 })
      .lean();

    // ✅ Get sellers
    const sellers = await Seller.find(sellerQuery)
      .select(
        "storeName image referralCode advertisementImages sellerFreeDeliveryEnabled sellerFreeDeliveryLimit fullAddress foodTypes isVeg",
      )
      .lean();

    // ✅ Ratings
    const ratings = await Rating.find({
      storeId: { $in: sellers.map((s) => s._id) },
    }).lean();

    // ✅ Top product offers
    const sellerIds = sellers.map((s) => s._id);

    // ✅ Top product offers + total items
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

    // ✅ Offer map
    const offerMap = {};
    const itemCountMap = {};

    topOffers.forEach((o) => {
      offerMap[o._id.toString()] = Number(o.maxDiscount.toFixed(1));
      itemCountMap[o._id.toString()] = o.totalItems;
    });

    // ==========================================================
    // ✅ IF 50%off FILTER THEN ONLY 50%+ SELLERS
    // ==========================================================
    let filteredSellers = sellers;

    if (filter === "50%off") {
      filteredSellers = sellers.filter((seller) => {
        const offer = offerMap[seller._id.toString()] || 0;

        return offer >= 50;
      });

      // highest offer first
      filteredSellers.sort((a, b) => {
        const offerA = offerMap[a._id.toString()] || 0;
        const offerB = offerMap[b._id.toString()] || 0;

        return offerB - offerA;
      });
    }

    // ✅ Final response
    const finalFoods = foods.map((food) => {
      const matchedSellers = filteredSellers
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
            averageRating: avg.toFixed(1),
            ratingCount: stats.count,
          };
        })
        // highest offer first
        .sort((a, b) => {
          return (
            Number(b.topProductOffer || 0) - Number(a.topProductOffer || 0)
          );
        });

      return {
        ...food,
        sellers: matchedSellers,
      };
    });

    // ✅ All sellers
    const allSellers = filteredSellers
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
          averageRating: avg.toFixed(1),
          ratingCount: stats.count,
        };
      })
      // highest offer first
      .sort((a, b) => {
        return Number(b.topProductOffer || 0) - Number(a.topProductOffer || 0);
      });

    return res.status(200).json({ finalFoods, allSellers });
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

    if (seller.foodTypes.includes(foodId)) {
      return res
        .status(400)
        .json({ message: "Food type already added to this seller" });
    }

    seller.foodTypes = foodId;
    await seller.save();

    return res
      .status(200)
      .json({ message: "Food type added to seller successfully" });
  } catch (error) {
    console.error("Error adding food type to seller:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.removeFoodFromSeller = async (req, res) => {
  try {
    const { sellerId, foodId } = req.body;

    const seller = await Seller.findOne(sellerId, {
      $or: [{ sellFood: true }, { businessType: "FSSAI" }],
      status: true,
      Authorized_Store: false,
    });
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    if (!seller.foodTypes.includes(foodId)) {
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
