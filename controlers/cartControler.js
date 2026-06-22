const { Cart, Discount } = require("../modals/cart");
const { ZoneData } = require("../modals/cityZone");
const Products = require("../modals/Product");
const Store = require("../modals/store");
const User = require("../modals/User");
const stock = require("../modals/StoreStock");
const mongoose = require("mongoose");
const haversine = require("haversine-distance");
const Address = require("../modals/Address");
const Coupon = require("../modals/sellerCoupon");
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

const {
  getActiveStoreOffers,
  getAppliedOfferContext,
  isOfferActive,
  isOfferEligibleForCart,
  getOfferMinimumAmount,
  calculateCartSubtotal,
  buildCartDiscountBreakdown,
  buildOfferPreviewText,
  resolveOfferPercent,
  resolveFreeProductItem,
} = require("../utils/storeOffer");

const { resolveSellerDeliveryPricing } = require("../utils/sellerDelivery");

const getRequestedTypeFilter = (req) => {
  const requestedTypeId = resolveRequestedTypeId(req);

  if (!mongoose.Types.ObjectId.isValid(requestedTypeId)) {
    return {};
  }

  return {
    typeId: new mongoose.Types.ObjectId(requestedTypeId),
  };
};

const getOfferContext = async (cartItems, storeId, now = new Date()) => {
  return getAppliedOfferContext(cartItems, storeId, now);
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
    if (price == null || mrp == null) {
      return res.status(400).json({
        message: "Price/MRP could not be determined for the selected variant.",
      });
    }

    const finalPrice = Math.round(Number(price));

    if (finalPrice == null) {
      return res.status(400).json({
        message: "Price could not be determined for the selected variant.",
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
      price: finalPrice,
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

    const now = new Date();
    const offerContext = await getOfferContext(updatedItems, storeId, now);
    const offerItems = offerContext.cartDiscount.items.map((item) => ({
      ...item,
      price: item.isFreeProduct ? 0 : item.baseUnitPrice,
      finalPrice: item.isFreeProduct ? 0 : item.finalUnitPrice,
      discountAmount: item.lineDiscount,
      savings: item.lineDiscount,
    }));
    const freeProductItem = offerContext.freeProductItem;

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
    let deliveryBaseCharge = 0;
    let freeDeliveryApplied = false;
    let freeDeliverySource = null;
    let freeDeliveryThreshold = 0;
    let sellerSponsoredDeliveryPayout = 0;
    let sellerFreeDeliveryEnabled = false;
    let sellerFreeDeliveryLimit = 0;

    if (address && items?.length) {
      const storeId = items[0].storeId;
      const store = await Store.findById(storeId, {
        Latitude: 1,
        Longitude: 1,
        sellerFreeDeliveryEnabled: 1,
        sellerFreeDeliveryLimit: 1,
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

      deliveryBaseCharge = deliveryCharge;

      const itemsTotal = offerContext.cartDiscount.items.reduce(
        (sum, item) => sum + item.finalUnitPrice * item.quantity,
        0,
      );

      const deliveryGstPercent = Number(settings?.Delivery_Charges_Gst || 0);

      const deliveryPayout =
        deliveryBaseCharge > 0
          ? deliveryBaseCharge / (1 + deliveryGstPercent / 100)
          : 0;

      const deliveryPricing = resolveSellerDeliveryPricing({
        itemsTotal,
        settings,
        store,
        deliveryChargeRaw: deliveryBaseCharge,
        deliveryPayout,
      });

      deliveryCharge = deliveryPricing.customerDeliveryCharge;
      deliveryBaseCharge = deliveryPricing.deliveryBaseCharge;
      freeDeliveryApplied = deliveryPricing.freeDeliveryApplied;
      freeDeliverySource = deliveryPricing.freeDeliverySource;
      freeDeliveryThreshold = deliveryPricing.freeDeliveryThreshold;
      sellerSponsoredDeliveryPayout =
        deliveryPricing.sellerSponsoredDeliveryPayout;
      sellerFreeDeliveryEnabled = deliveryPricing.sellerFreeDeliveryEnabled;
      sellerFreeDeliveryLimit = deliveryPricing.sellerFreeDeliveryLimit;
    }

    return res.status(200).json({
      status: true,
      message: "Cart items fetched successfully.",
      items: offerItems,
      freeItems: freeProductItem ? [freeProductItem] : [],
      offerSummary: {
        cartDiscount: offerContext.cartDiscount.offer
          ? {
              _id: offerContext.cartDiscount.offer._id,
              title: offerContext.cartDiscount.offer.title,
              previewText: buildOfferPreviewText(
                offerContext.cartDiscount.offer,
              ),
              offerType: offerContext.cartDiscount.offer.offerType,
              discountScope: offerContext.cartDiscount.offer.discountScope,
              percent: offerContext.cartDiscount.percent,
              savings: offerContext.cartDiscount.discountAmount,
              subtotal: offerContext.cartDiscount.subtotal,
              finalSubtotal: offerContext.cartDiscount.finalSubtotal,
            }
          : null,
        freeProduct: freeProductItem
          ? {
              _id: offerContext.freeProductOffer._id,
              title: offerContext.freeProductOffer.title,
              previewText: buildOfferPreviewText(offerContext.freeProductOffer),
              freeProductName: freeProductItem.name,
              freeProductQuantity: freeProductItem.quantity,
              savings: freeProductItem.freeProductSavings,
            }
          : null,
        subtotal: offerContext.cartDiscount.subtotal,
        discountSavings: offerContext.cartDiscount.discountAmount,
        freeProductSavings: freeProductItem?.freeProductSavings || 0,
        totalSavings:
          offerContext.cartDiscount.discountAmount +
          (freeProductItem?.freeProductSavings || 0),
        finalSubtotal: offerContext.cartDiscount.finalSubtotal,
      },
      paymentOption: cashOnDelivery,
      StoreID: storeId,
      deliveryCharge,
      deliveryBaseCharge,
      deliveryChargeMode,
      deliveryDistanceKm,
      billableKm,

      freeDeliveryApplied,
      freeDeliverySource,
      freeDeliveryThreshold,
      sellerSponsoredDeliveryPayout,
      sellerFreeDeliveryEnabled,
      sellerFreeDeliveryLimit,
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

    const cart = await Cart.findById(id);

    if (!cart) {
      return res.status(404).json({ message: "Cart item not found" });
    }

    const couponId = cart.couponId;
    const userId = cart.userId;
    const storeId = cart.storeId;

    await Cart.findByIdAndDelete(id);

    if (cart.isFreeProduct) {
      await Cart.updateMany(
        {
          userId: cart.userId,
          storeId: cart.storeId,
          couponId: cart.couponId,
        },
        {
          $unset: {
            couponId: 1,
            originalPrice: 1,
          },
          $set: {
            isCouponApplied: false,
            discountAmount: 0,
          },
        },
      );
      return res.status(200).json({
        message: "Cart Item Removed",
      });
    }
    // If coupon applied, check remaining eligible items
    if (couponId) {
      const remainingItems = await Cart.find({
        userId,
        storeId,
        isFreeProduct: false,
      });

      // No paid items left -> remove free products
      if (remainingItems.length === 0) {
        await Cart.deleteMany({
          userId,
          storeId,
          couponId,
          isFreeProduct: true,
        });
      } else {
        const coupon = await Coupon.findById(couponId);

        if (!coupon) {
          await Cart.deleteMany({
            userId,
            storeId,
            couponId,
            isFreeProduct: true,
          });
        } else {
          const subtotal = calculateCartSubtotal(remainingItems);

          const eligibility = isOfferEligibleForCart(
            coupon,
            remainingItems,
            subtotal,
            new Date(),
          );

          if (!eligibility.eligible) {
            await Cart.deleteMany({
              userId,
              storeId,
              couponId,
              isFreeProduct: true,
            });

            await Cart.updateMany(
              {
                userId,
                storeId,
                couponId,
              },
              {
                $unset: {
                  couponId: 1,
                  originalPrice: 1,
                },
                $set: {
                  isCouponApplied: false,
                  discountAmount: 0,
                },
              },
            );
          }
        }
      }
    }

    return res.status(200).json({
      message: "Cart Item Removed",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "An error occured!",
      error: error.message,
    });
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
                    { $gt: ["$stock.quantity", 0] }, // only include stock > 0
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
      { $match: { maxQuantity: { $gt: 0 } } }, // filter products with no stock
      { $sort: { maxQuantity: -1 } },
      { $limit: 20 },
      { $project: { maxQuantity: 0 } }, // remove temporary field
    ]);

    const filteredRecommendedProducts = filterProductsByRequestedType(
      recommendedProducts,
      req,
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

exports.getOffers = async (req, res) => {
  try {
    const { cartIds, userId } = req.body;

    if (!userId && (!Array.isArray(cartIds) || cartIds.length === 0)) {
      return res
        .status(400)
        .json({ message: "userId or cartIds array required" });
    }

    const cartQuery = userId ? { userId } : { _id: { $in: cartIds } };
    const carts = await Cart.find(cartQuery).lean();

    if (!carts.length) {
      return res.status(404).json({ message: "No carts found" });
    }

    const storeId = carts[0].storeId;
    const now = new Date();
    const offers = await getActiveStoreOffers(storeId, now);
    const subtotal = calculateCartSubtotal(carts);
    const appliedOfferId =
      carts.find((cart) => cart.couponId)?.couponId?.toString() || null;

    const serializeOffer = (offer) => {
      const eligibility = isOfferEligibleForCart(offer, carts, subtotal, now);
      const breakdown =
        offer.offerType === "cart_discount"
          ? buildCartDiscountBreakdown(carts, offer)
          : null;

      return {
        _id: offer._id,
        title: offer.title,
        offerType: offer.offerType,
        discountScope: offer.discountScope,
        offer: resolveOfferPercent(offer, subtotal),
        minimumOrderAmount: getOfferMinimumAmount(offer),
        limit: getOfferMinimumAmount(offer),
        previewText: buildOfferPreviewText(offer),
        productId: offer.productId || [],
        freeProductId: offer.freeProductId || null,
        freeProductQuantity: offer.freeProductQuantity || 1,
        isApplicable: eligibility.eligible,
        ineligibilityReason: eligibility.reason,
        isApplied: appliedOfferId === offer._id.toString(),
        estimatedSavings: eligibility.eligible
          ? breakdown?.discountAmount || 0
          : 0,
        finalSubtotal:
          eligibility.eligible && breakdown
            ? breakdown.finalSubtotal
            : subtotal,
      };
    };
    const serializedOffers = offers.map(serializeOffer);
    const serializedOfferById = new Map(
      serializedOffers.map((offer) => [offer._id.toString(), offer]),
    );
    const appliedOffer = appliedOfferId
      ? serializedOfferById.get(appliedOfferId)
      : null;

    const offerMap = {};
    offers.forEach((offer) => {
      if (offer.offerType !== "cart_discount") return;

      const productIds = Array.isArray(offer.productId)
        ? offer.productId.map((pid) => pid.toString())
        : [];

      if (offer.discountScope === "selected_products" && !productIds.length) {
        return;
      }

      carts.forEach((cart) => {
        const cartProductId = cart.productId.toString();

        if (
          offer.discountScope === "selected_products" &&
          !productIds.includes(cartProductId)
        ) {
          return;
        }

        if (!offerMap[cartProductId]) offerMap[cartProductId] = [];
        offerMap[cartProductId].push(
          serializedOfferById.get(offer._id.toString()),
        );
      });
    });

    return res.status(200).json({
      message: "Offers fetched successfully",
      isCouponApplied: carts.some((cart) => cart.isCouponApplied === true),
      noOffer: !offers.length,
      storeId,
      subtotal,
      appliedOfferId,
      storeOffers: serializedOffers,
      offerSummary: {
        subtotal,
        appliedOfferId,
        appliedOffer: appliedOffer || null,
        totalSavings: appliedOffer?.estimatedSavings || 0,
      },

      carts: carts.map((cart) => ({
        cartId: cart._id,
        productId: cart.productId,
        cartCoupon: cart.couponId || null,
        isCouponApplied: cart.isCouponApplied || false,
        offers: offerMap[cart.productId.toString()] || [],
      })),
    });
  } catch (error) {
    console.error("❌ Error in getOffers:", error);
    return res.status(500).json({
      message: "An error occurred!",
      error: error.message,
    });
  }
};

exports.applyCoupon = async (req, res) => {
  try {
    const { removeOffer } = req.query;
    const { cartIds, couponId, userId } = req.body;

    console.log(req.body, "applyCoupon request body");
    if (!userId && (!Array.isArray(cartIds) || cartIds.length === 0)) {
      return res
        .status(400)
        .json({ message: "userId or cartIds array required" });
    }

    const cartQuery = userId ? { userId } : { _id: { $in: cartIds } };
    const carts = await Cart.find(cartQuery);

    if (!carts.length) {
      return res.status(404).json({ message: "No carts found" });
    }

    // 🔴 REMOVE FLOW
    if (removeOffer === "true" || removeOffer === true) {
      for (let cart of carts) {
        cart.couponId = null;
        cart.discountAmount = 0;
        cart.price = cart.originalPrice || cart.price;
        cart.originalPrice = null;
        cart.isCouponApplied = false;
        await cart.save();
      }

      await Cart.deleteMany({
        userId: carts[0].userId,
        _id: {
          $in: carts.map((c) => c._id),
        },
        isFreeProduct: true,
      });

      return res.status(200).json({
        message: "Offers removed successfully",
        carts,
      });
    }

    if (!couponId) {
      return res.status(400).json({ message: "couponId is required" });
    }

    const coupon = await Coupon.findById(couponId);
    const now = new Date();

    if (!coupon || !isOfferActive(coupon, now)) {
      return res.status(400).json({ message: "Invalid offer" });
    }

    if (coupon.storeId?.toString() !== carts[0].storeId?.toString()) {
      return res
        .status(400)
        .json({ message: "Offer does not belong to this cart store" });
    }

    const subtotal = calculateCartSubtotal(carts);
    const eligibility = isOfferEligibleForCart(coupon, carts, subtotal, now);
    if (!eligibility.eligible) {
      return res
        .status(400)
        .json({ message: eligibility.reason || "Offer is not applicable" });
    }

    const freeProductItem =
      coupon.offerType === "free_product"
        ? await resolveFreeProductItem({
            offer: coupon,
            storeId: carts[0].storeId,
          })
        : null;

    if (coupon.offerType === "free_product" && !freeProductItem) {
      return res
        .status(400)
        .json({ message: "Free product is not available in stock" });
    }

    if (coupon.offerType === "free_product" && freeProductItem) {
      const existingFreeItem = await Cart.findOne({
        userId: carts[0].userId,
        storeId: carts[0].storeId,
        couponId: coupon._id,
        isFreeProduct: true,
        productId: freeProductItem.productId,
        varientId: freeProductItem.varientId,
      });

      if (!existingFreeItem) {
        await Cart.create({
          image: freeProductItem.image,
          price: 0,
          mrp: freeProductItem.mrp,
          tax: freeProductItem.tax,
          name: freeProductItem.name,
          quantity: freeProductItem.quantity,
          productId: freeProductItem.productId,
          storeId: carts[0].storeId,
          varientId: freeProductItem.varientId,
          userId: carts[0].userId,
          paymentOption: false,
          isFreeProduct: true,

          couponId: coupon._id,
          isCouponApplied: true,

          originalPrice: freeProductItem.basePrice,
          discountAmount: freeProductItem.basePrice * freeProductItem.quantity,
          finalPrice: 0,
        });
      }
    }

    const breakdown =
      coupon.offerType === "cart_discount"
        ? buildCartDiscountBreakdown(carts, coupon)
        : buildCartDiscountBreakdown(carts, null);
    const updatedCarts = [];
    const skipped = [];

    for (let index = 0; index < carts.length; index += 1) {
      const cart = carts[index];
      const item = breakdown.items[index];

      if (coupon.offerType === "cart_discount" && !item?.isOfferApplied) {
        cart.couponId = null;
        cart.discountAmount = 0;
        cart.price = cart.originalPrice || cart.price;
        cart.originalPrice = null;
        cart.isCouponApplied = false;
        await cart.save();
        skipped.push(cart._id);
        continue;
      }

      cart.couponId = coupon._id;
      cart.discountAmount =
        coupon.offerType === "cart_discount" ? item.lineDiscount : 0;
      cart.originalPrice = cart.originalPrice || item.baseUnitPrice;
      cart.price =
        coupon.offerType === "cart_discount"
          ? item.finalUnitPrice
          : item.baseUnitPrice;
      cart.isCouponApplied = true;

      await cart.save();
      updatedCarts.push(cart);
    }

    return res.status(200).json({
      message: "Offer applied successfully",
      appliedOn: updatedCarts.map((c) => c._id),
      skipped,
      carts: updatedCarts,
      offerSummary: {
        offerId: coupon._id,
        title: coupon.title,
        previewText: buildOfferPreviewText(coupon),
        offerType: coupon.offerType,
        discountAmount: breakdown.discountAmount,
        subtotal: breakdown.subtotal,
        finalSubtotal: breakdown.finalSubtotal,
        freeProduct: freeProductItem
          ? {
              name: freeProductItem.name,
              quantity: freeProductItem.quantity,
              savings: freeProductItem.freeProductSavings,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("❌ Error applying offer:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
