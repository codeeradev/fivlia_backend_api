const foodTypeModel = require("../modals/foodType");
const Seller = require("../modals/store");
const Rating = require("../modals/rating");

exports.addFood = async (req, res) => {
  try {
    const { name, description } = req.body;
    const image = `/${req.files?.image?.[0]?.key}`;

    const newFood = await foodTypeModel.create({
      name,
      description,
      image,
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
    const { name, description } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (description) updateData.description = description;
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
    console.log("Fetching foods with sellers...");

    // ✅ Get all active foods
    const foods = await foodTypeModel
      .find({ status: true })
      .select("-__v -createdAt -updatedAt -orderCount")
      .sort({ createdAt: -1 })
      .lean();

    // ✅ Get sellers
    const sellers = await Seller.find({
      $or: [{ sellFood: true }, { businessType: "FSSAI" }],
      status: true,
      Authorized_Store: false,
    })
      .select(
        "storeName image referralCode advertisementImages sellerFreeDeliveryEnabled sellerFreeDeliveryLimit fullAddress foodTypes",
      )
      .lean();

    // ✅ Ratings
    const ratings = await Rating.find({
      storeId: { $in: sellers.map((s) => s._id) },
    }).lean();

    // ✅ Rating map
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

    // ✅ Final response
    const finalFoods = foods.map((food) => {
      const matchedSellers = sellers
        .filter((seller) =>
          seller.foodTypes?.some(
            (id) => id.toString() === food._id.toString(),
          ),
        )
        .map((store) => {
          const stats = ratingsByStore[store._id.toString()] || {
            total: 0,
            count: 0,
          };

          const avg = stats.count
            ? stats.total / stats.count
            : 0;

          return {
            storeId: store._id,
            storeName: store.storeName,
            image: store.image,
            referralCode: store.referralCode,
            advertisementImages:
              store.advertisementImages,
            sellerFreeDeliveryEnabled:
              store.sellerFreeDeliveryEnabled,
            sellerFreeDeliveryLimit:
              store.sellerFreeDeliveryLimit,
            fullAddress: store.fullAddress,
            averageRating: avg.toFixed(1),
            ratingCount: stats.count,
          };
        });

      return {
        ...food,
        sellers: matchedSellers,
      };
    });

    return res.status(200).json(finalFoods);
  } catch (error) {
    console.error(
      "Error fetching foods with sellers:",
      error,
    );

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
