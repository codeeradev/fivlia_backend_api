const mongoose = require("mongoose");
const MenuCard = require("../../modals/MenuCard");
const Store = require("../../modals/store");
const Stock = require("../../modals/StoreStock");

const parseProducts = (products) => {
  if (!products) return [];

  let parsed = products;
  if (typeof products === "string") {
    try {
      parsed = JSON.parse(products);
    } catch {
      parsed = products.split(",");
    }
  }

  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((product) => product?._id || product?.productId || product)
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
};

const populateMenuCard = (query) =>
  query.populate({
    path: "products",
    select: "productName productThumbnailUrl sku",
  });

const populateMenuCardDocument = (menuCard) =>
  menuCard.populate({
    path: "products",
    select: "productName productThumbnailUrl sku",
  });

const validateMenuCardPayload = async (req, res, existingMenuCard = null) => {
  const { sellerId, title } = req.body;
  const products = parseProducts(req.body.products);

  if (!sellerId || !mongoose.Types.ObjectId.isValid(sellerId)) {
    res.status(400).json({ message: "Valid sellerId is required" });
    return null;
  }

  if (!title || !title.trim()) {
    res.status(400).json({ message: "Title is required" });
    return null;
  }

  if (!products.length) {
    res.status(400).json({ message: "Select at least one product" });
    return null;
  }

  const seller = await Store.findById(sellerId).select("_id").lean();
  if (!seller) {
    res.status(404).json({ message: "Seller not found" });
    return null;
  }

  const stockData = await Stock.findOne({ storeId: sellerId }).lean();
  const sellerProductIds = new Set(
    (stockData?.stock || [])
      .map((stock) => stock.productId?.toString())
      .filter(Boolean),
  );
  const invalidProduct = products.find(
    (productId) => !sellerProductIds.has(productId.toString()),
  );

  if (invalidProduct) {
    res
      .status(400)
      .json({ message: "Selected products must belong to this seller" });
    return null;
  }

  const image = req.files?.image?.[0]?.key
    ? `/${req.files.image[0].key}`
    : existingMenuCard?.image;

  if (!image) {
    res.status(400).json({ message: "Image is required" });
    return null;
  }

  return {
    sellerId,
    title: title.trim(),
    image,
    products,
  };
};

exports.upsertMenuCard = async (req, res) => {
  try {
    const payload = await validateMenuCardPayload(req, res);
    if (!payload) return;

    const createdMenuCard = await MenuCard.create(payload);
    const menuCard = await populateMenuCardDocument(createdMenuCard);

    return res.status(201).json({
      success: true,
      message: "Menu card created successfully",
      menuCard,
    });
  } catch (error) {
    console.error("Menu card create error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.editMenuCard = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Valid menu card ID is required" });
    }

    const existingMenuCard = await MenuCard.findById(id);
    if (!existingMenuCard) {
      return res.status(404).json({ message: "Menu card not found" });
    }

    req.body.sellerId = existingMenuCard.sellerId.toString();
    const payload = await validateMenuCardPayload(req, res, existingMenuCard);
    if (!payload) return;

    const menuCard = await populateMenuCard(
      MenuCard.findByIdAndUpdate(id, payload, {
        new: true,
        runValidators: true,
      }),
    );

    return res.status(200).json({
      success: true,
      message: "Menu card updated successfully",
      menuCard,
    });
  } catch (error) {
    console.error("Menu card edit error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getMenuCard = async (req, res) => {
  try {
    const { sellerId } = req.query;

    if (!sellerId || !mongoose.Types.ObjectId.isValid(sellerId)) {
      return res.status(400).json({ message: "Valid sellerId is required" });
    }

    const menuCards = await populateMenuCard(
      MenuCard.find({ sellerId }).sort({ createdAt: -1 }).lean(),
    );
    const menuCardsWithCount = menuCards.map((menuCard) => ({
      ...menuCard,
      itemCount: menuCard.products?.length || 0,
    }));

    return res.status(200).json({
      success: true,
      menuCards: menuCardsWithCount,
      menuCard: menuCardsWithCount[0] || null,
    });
  } catch (error) {
    console.error("Menu card fetch error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.deleteMenuCard = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Valid menu card ID is required" });
    }

    const deletedMenuCard = await MenuCard.findByIdAndDelete(id);
    if (!deletedMenuCard) {
      return res.status(404).json({ message: "Menu card not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Menu card deleted successfully",
    });
  } catch (error) {
    console.error("Menu card delete error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
