const { Cart, Discount } = require("../modals/cart");
const { ZoneData } = require("../modals/cityZone");
const Products = require("../modals/Product");
const Store = require("../modals/store");
const User = require("../modals/User");
const stock = require("../modals/StoreStock");
const mongoose = require("mongoose");
const haversine = require("haversine-distance");
const Address = require("../modals/Address");
const { SettingAdmin } = require("../modals/setting");
const {
  getDistanceKm,
  getBillableKm,
  computeDeliveryCharge,
  resolveDeliveryRatesForMode,
} = require("../utils/deliveryCharge");
const {
  filterProductsByRequestedType,
  resolveRequestedTypeId,
} = require("../utils/productTypeFilter");
const {
  isWithinZone,
  getZoneWindowConfig,
  getCurrentZoneWindowMode,
} = require("../config/google");

const getRequestedTypeFilter = (req) => {
  const requestedTypeId = resolveRequestedTypeId(req);

  if (!mongoose.Types.ObjectId.isValid(requestedTypeId)) {
    return {};
  }

  return {
    typeId: new mongoose.Types.ObjectId(requestedTypeId),
  };
};

exports.addCart = async (req, res) => {
  try {
    const userId = req.user;
    const { quantity, productId, storeId, varientId, clearCart } = req.body;

    if (!storeId) {
      return res.status(400).json({ message: "storeId not found." });
    }

    if (!productId || !varientId || !quantity) {
      return res
        .status(400)
        .json({ message: "Missing product or variant info." });
    }

    // Clear cart if requested
    if (clearCart === "true") {
      await Cart.deleteMany({ userId });
    }

    // Get user location
    const user = await User.findOne(userId).lean();
    const userLat = parseFloat(user?.location?.latitude);
    const userLng = parseFloat(user?.location?.longitude);

    if (!userLat || !userLng) {
      return res.status(400).json({ message: "User location not available." });
    }
    // Fetch active zones
    const [zoneDocs, zoneWindowConfig] = await Promise.all([
      ZoneData.find({}),
      getZoneWindowConfig(),
    ]);
    const activeZones = zoneDocs.flatMap((doc) =>
      doc.zones.filter((z) => z.status === true),
    );

    const matchedZone = activeZones.find((zone) =>
      isWithinZone(userLat, userLng, zone, zoneWindowConfig),
    );

    if (!matchedZone) {
      return res
        .status(400)
        .json({ message: "No active zone found for your location." });
    }

    const paymentOption = matchedZone.cashOnDelivery === true;

    // Single-store cart policy
    const cartItems = await Cart.find({ userId }).lean();
    if (cartItems.length > 0) {
      const existingStoreId = cartItems[0].storeId?.toString();
      if (existingStoreId !== storeId) {
        return res.status(200).json({
          message: `You can only add products from one store at a time.`,
          errorType: "multiple_stores_in_cart",
        });
      }
    }

    // Check product
    const product = await Products.findOne({ _id: productId }).lean();
    if (!product) {
      return res.status(400).json({ message: "Product is unavailable." });
    }

    // Check stock entry
    const stockDoc = await stock
      .findOne({
        storeId,
        "stock.productId": productId,
        "stock.variantId": varientId,
      })
      .lean();

    let stockEntry;
    if (stockDoc?.stock?.length) {
      stockEntry = stockDoc.stock.find(
        (s) =>
          s.productId.toString() === productId.toString() &&
          s.variantId.toString() === varientId.toString(),
      );
    }

    if (!stockEntry || stockEntry.quantity < quantity) {
      return res.status(400).json({
        message:
          "Product variant is out of stock or requested quantity is unavailable.",
      });
    }

    const name = product.productName;
    const image = product.productThumbnailUrl;
    const tax = product.tax || "0%"; // fallback if not present
    let price = stockEntry?.price;
    let mrp = stockEntry?.mrp;

    // Fallback to product.variants if price or mrp is missing
    if (!price || !mrp) {
      const matchedVariant = product.variants?.find(
        (v) => v._id?.toString() === varientId?.toString(),
      );

      if (matchedVariant) {
        price = matchedVariant.sell_price;
        mrp = matchedVariant.mrp;
      }
    }

    // Final fallback to avoid undefined values (optional)
    if (!price || !mrp) {
      return res.status(400).json({
        message: "Price/MRP could not be determined for the selected variant.",
      });
    }

    // Remove old cart entry for same product
    await Cart.deleteOne({
      userId,
      productId,
    });

    // Create new cart item
    const cartItem = await Cart.create({
      name,
      image,
      quantity,
      price,
      mrp,
      tax,
      productId,
      varientId,
      userId,
      storeId,
      paymentOption,
    });

    return res.status(200).json({
      message: "Item added to cart.",
      item: cartItem,
    });
  } catch (error) {
    console.error("Error in add to cart", error);
    return res.status(500).json({
      message: "An error occurred!",
      error: error.message,
    });
  }
};

exports.getCart = async (req, res) => {
  try {
    const { id } = req.user;

    // Fetch cart items and user data
    const [items, user] = await Promise.all([
      Cart.find({ userId: id }),
      User.findById(id),
    ]);

    if (!items || items.length === 0) {
      return res.status(204).json({ status: false, message: "Cart Is Empty." });
    }
    if (!user) {
      return res
        .status(404)
        .json({ status: false, message: "User not found." });
    }

    const storeId = items[0]?.storeId;

    let storeZone = await Store.findById(storeId);

    storeZone = storeZone.zone[0];

    const zoneData = await ZoneData.findOne({ "zones._id": storeZone._id });

    const zone = zoneData.zones.find(
      (z) => z._id.toString() === storeZone._id.toString(),
    );

    const cashOnDelivery = zone?.cashOnDelivery || false;
    // Fetch stock data for the store
    const stockDoc = await stock.findOne({ storeId });
    if (!stockDoc) {
      return res.status(200).json({
        status: false,
        message: "No stock data found for the store.",
        items,
      });
    }
    // Map stock data for quick lookup
    const stockMap = new Map();
    stockDoc.stock.forEach((s) => {
      const key = `${s.productId.toString()}_${s.variantId.toString()}`;
      stockMap.set(key, s.quantity);
    });

    // Add stock information to each cart item
    const updatedItems = items.map((cartItem) => {
      const key = `${cartItem.productId}_${cartItem.varientId}`;
      const availableQty = stockMap.get(key) || 0;

      return {
        ...cartItem.toObject(),
        stock: availableQty,
      };
    });

    const settings = await SettingAdmin.findOne().lean();
    let address = null;

    address = await Address.findOne({
      userId: id,
      default: true,
      isDeleted: { $ne: true },
    }).lean();
    if (!address) {
      address = await Address.findOne({
        userId: id,
        isDeleted: { $ne: true },
      })
        .sort({ createdAt: -1 })
        .lean();
    }

    let deliveryCharge = 0;
    let deliveryDistanceKm = 0;
    let billableKm = 0;
    let deliveryChargeMode = "day";

    if (address && items?.length) {
      const storeId = items[0].storeId;
      const store = await Store.findById(storeId, {
        Latitude: 1,
        Longitude: 1,
      }).lean();

      const distanceMeters = Math.round(
        haversine(
          {
            lat: parseFloat(address?.latitude),
            lon: parseFloat(address?.longitude),
          },
          {
            lat: parseFloat(store?.Latitude),
            lon: parseFloat(store?.Longitude),
          },
        ),
      );

      deliveryDistanceKm = Number(getDistanceKm(distanceMeters).toFixed(2));
      billableKm = getBillableKm(distanceMeters);

      const zoneWindowConfig = await getZoneWindowConfig();
      const currentWindowMode = getCurrentZoneWindowMode(zoneWindowConfig);
      const { fixedFirstKm, perKm, appliedMode } = resolveDeliveryRatesForMode({
        settings,
        mode: currentWindowMode,
      });
      deliveryChargeMode = appliedMode;

      deliveryCharge = computeDeliveryCharge({
        distanceMeters,
        fixedFirstKm,
        perKm,
      });

      const itemsTotal = items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      );
      if (itemsTotal >= (settings?.freeDeliveryLimit || 0)) {
        deliveryCharge = 0;
      }
    }

    return res.status(200).json({
      status: true,
      message: "Cart items fetched successfully.",
      items: updatedItems,
      paymentOption: cashOnDelivery,
      StoreID: storeId,
      deliveryCharge,
      deliveryChargeMode,
      deliveryDistanceKm,
      billableKm,
    });
  } catch (error) {
    console.error("❌ Error in getCart:", error);
    return res.status(500).json({
      status: false,
      message: "An error occurred while fetching cart items.",
      error: error.message,
    });
  }
};

exports.discount = async (req, res) => {
  try {
    const { description, value, head } = req.body;
    const newDiscount = await Discount.create({ description, value, head });
    return res.status(200).json({ message: "New Discount:", newDiscount });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occured!", error: error.message });
  }
};
exports.getDicount = async (req, res) => {
  try {
    const discount = await Discount.find();
    return res.status(200).json({ message: "New Discounts:", discount });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occured!", error: error.message });
  }
};
exports.quantity = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    const updated_cart = await Cart.findByIdAndUpdate(
      id,
      { quantity },
      { new: true },
    );

    return res.status(200).json({ message: "New Quantity:", updated_cart });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occured!", error: error.message });
  }
};

exports.deleteCart = async (req, res) => {
  try {
    const { id } = req.params;
    const cart = await Cart.findByIdAndDelete(id);

    return res.status(200).json({ message: "Cart Item Removed:", cart });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occured!", error: error.message });
  }
};

exports.recommedProduct = async (req, res) => {
  try {
    const userId = req.user._id;
    const requestedTypeFilter = getRequestedTypeFilter(req);

    // 1️⃣ Get cart items
    const cartItems = await Cart.find({ userId }).lean();
    if (!cartItems.length) {
      return res.status(404).json({ message: "Cart is empty" });
    }

    const cartProductIds = cartItems.map((c) => c.productId);

    const cartProducts = await Products.find({
      _id: { $in: cartProductIds },
      ...requestedTypeFilter,
    }).lean();

    if (!cartProducts.length) {
      return res.status(200).json({
        message: "No recommended products found",
        relatedProducts: [],
      });
    }

    // 2️⃣ Get seller of first cart item
    const firstCartItem = cartItems[0];
    const seller = await Store.findById(firstCartItem.storeId).lean();
    if (!seller) {
      return res.status(404).json({ message: "Seller not found" });
    }

    // 3️⃣ Extract all allowed category IDs
    let allowedCategoryIds = [];
    if (seller.sellerCategories?.length) {
      const sellerCategoryIds = seller.sellerCategories
        .map((cat) => cat.categoryId.toString())
        .filter(Boolean);

      const filteredCartCategories = cartProducts
        .flatMap((p) => p.category || []) // cart product category array
        .filter((c) => sellerCategoryIds.includes(c._id.toString())) // only seller categories
        .map((c) => c._id.toString());

      allowedCategoryIds = [
        ...new Set(
          filteredCartCategories.map((id) => new mongoose.Types.ObjectId(id)),
        ),
      ];
      // Unofficial sellers: subCategories + subSubCategories
      // allowedCategoryIds = seller.sellerCategories.flatMap(
      //   (cat) =>
      //     cat.subCategories?.flatMap((sub) =>
      //       [
      //         ...(sub.subSubCategories?.map((ssc) => ssc.subSubCategoryId) ||
      //           []),
      //         sub.subCategoryId,
      //       ].filter(Boolean)
      //     ) || []
      // );
    } else if (seller.Category?.length) {
      // Official store: main categories
      allowedCategoryIds = seller.Category;
    }

    if (!allowedCategoryIds.length) {
      return res.status(200).json({
        message: "No recommended products found",
        relatedProducts: [],
      });
    }

    console.log("allowedCategoryIds", allowedCategoryIds);
    // 4️⃣ Build query to exclude products already in cart
    const matchQuery = {
      ...requestedTypeFilter,
      _id: { $nin: cartProductIds },
      $or: [
        // { "subSubCategory._id": { $in: allowedCategoryIds } },
        // { "subCategory._id": { $in: allowedCategoryIds } },
        { "category._id": { $in: allowedCategoryIds } },
      ],
    };
    // 5️⃣ Aggregate recommended products with stock info
    const recommendedProducts = await Products.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "stocks",
          let: { productId: "$_id", variants: "$variants" },
          pipeline: [
            { $match: { storeId: seller._id } },
            { $unwind: "$stock" },
            {
              $match: {
                $expr: {
                  $and: [
                    // { $gt: ["$stock.quantity", 0] }, // only include stock > 0
                    {
                      $or: [
                        {
                          $in: [
                            "$stock.variantId",
                            {
                              $ifNull: [
                                {
                                  $map: {
                                    input: "$$variants",
                                    as: "v",
                                    in: "$$v._id",
                                  },
                                },
                                [],
                              ],
                            },
                          ],
                        },
                        { $eq: ["$stock.productId", "$$productId"] },
                      ],
                    },
                  ],
                },
              },
            },
            {
              $project: {
                _id: "$stock._id",
                variantId: "$stock.variantId",
                quantity: "$stock.quantity",
                price: "$stock.price",
                mrp: "$stock.mrp",
              },
            },
          ],
          as: "inventory",
        },
      },
      {
        $addFields: {
          maxQuantity: { $ifNull: [{ $max: "$inventory.quantity" }, 0] },
          storeId: seller._id,
          storeName: seller.storeName,
        },
      },
      // { $match: { maxQuantity: { $gt: 0 } } }, // filter products with no stock
      { $sort: { maxQuantity: -1 } },
      { $limit: 20 },
      { $project: { maxQuantity: 0 } }, // remove temporary field
    ]);

    const filteredRecommendedProducts = filterProductsByRequestedType(
      recommendedProducts,
      req
    );

    return res.status(200).json({
      message: "Recommended products fetched successfully",
      relatedProducts: filteredRecommendedProducts,
    });
  } catch (error) {
    console.error("❌ Error in recommedProduct:", error);
    return res
      .status(500)
      .json({ message: "An error occurred!", error: error.message });
  }
};


