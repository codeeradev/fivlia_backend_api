const Products = require("../../modals/StoreStock");
const Store = require("../../modals/store");
const mongoose = require("mongoose");
const axios = require("axios");
const Product = require("../../modals/Product");
const Category = require("../../modals/category");
const Stock = require("../../modals/StoreStock");

exports.addCategoryInSeller = async (req, res) => {
  try {
    const { id } = req.params;
    let { sellerCategories, sellerProducts } = req.body;

    // Validation
    if (!sellerCategories || sellerCategories.length === 0) {
      return res.status(400).json({
        message: "At least one main category must be selected.",
      });
    }
    if (!sellerProducts || sellerProducts.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one product must be selected." });
    }

    // 🛠️ Normalize IDs properly
    sellerCategories = sellerCategories.map((cat) => ({
      categoryId:
        cat.categoryId &&
        mongoose.isValidObjectId(cat.categoryId.$oid || cat.categoryId)
          ? new mongoose.Types.ObjectId(cat.categoryId.$oid || cat.categoryId)
          : null,
      subCategories: Array.isArray(cat.subCategories)
        ? cat.subCategories.map((sub) => ({
            subCategoryId:
              sub.subCategoryId &&
              mongoose.isValidObjectId(
                sub.subCategoryId.$oid || sub.subCategoryId
              )
                ? new mongoose.Types.ObjectId(
                    sub.subCategoryId.$oid || sub.subCategoryId
                  )
                : null,
            subSubCategories: Array.isArray(sub.subSubCategories)
              ? sub.subSubCategories
                  .map((ss) => ({
                    subSubCategoryId:
                      ss.subSubCategoryId &&
                      mongoose.isValidObjectId(
                        ss.subSubCategoryId.$oid || ss.subSubCategoryId
                      )
                        ? new mongoose.Types.ObjectId(
                            ss.subSubCategoryId.$oid || ss.subSubCategoryId
                          )
                        : null,
                  }))
                  .filter((ss) => ss.subSubCategoryId !== null)
              : [],
          }))
        : [],
    }));

    const store = await Store.findById(id);
    if (!store) {
      return res.status(404).json({ message: "Store not found" });
    }

    let updatedCategories = [...store.sellerCategories];

    // 🔄 Merge Categories / SubCategories / SubSubCategories
    sellerCategories.forEach((newCat) => {
      if (!newCat.categoryId) return;

      const existingCat = updatedCategories.find(
        (c) => c.categoryId.toString() === newCat.categoryId.toString()
      );

      if (existingCat) {
        // Merge subCategories
        newCat.subCategories.forEach((newSub) => {
          if (!newSub.subCategoryId) return;

          const existingSub = existingCat.subCategories.find(
            (s) =>
              s.subCategoryId &&
              s.subCategoryId.toString() === newSub.subCategoryId.toString()
          );

          if (existingSub) {
            // Merge subSubCategories (skip duplicates)
            newSub.subSubCategories.forEach((ss) => {
              if (
                !existingSub.subSubCategories.find(
                  (ess) =>
                    ess.subSubCategoryId.toString() ===
                    ss.subSubCategoryId.toString()
                )
              ) {
                existingSub.subSubCategories.push(ss);
              }
            });
          } else {
            existingCat.subCategories.push(newSub);
          }
        });
      } else {
        updatedCategories.push(newCat);
      }
    });

    store.sellerCategories = updatedCategories;
    await store.save();

    // ✅ Handle Products (update if exists, else add new)
    let storeStock = await Products.findOne({ storeId: id });
    if (!storeStock) {
      storeStock = await Products.create({ storeId: id, stock: [] });
    }

    if (!Array.isArray(storeStock.stock)) {
      storeStock.stock = [];
    }

    for (const productId of sellerProducts) {
      const pid = productId.$oid || productId;
      if (!mongoose.isValidObjectId(pid)) continue;

      const adminProduct = await Product.findById(pid).lean();
      if (!adminProduct) continue;

      for (const variant of adminProduct.variants) {
        const exists = storeStock.stock.find(
          (s) =>
            s.productId.toString() === pid.toString() &&
            s.variantId.toString() === variant._id.toString()
        );

        if (!exists) {
          storeStock.stock.push({
            productId: pid,
            variantId: variant._id,
            quantity: 0,
            price: variant.sell_price || 0,
            mrp: variant.mrp || 0,
          });
        }
      }
    }
    await storeStock.save();
    return res.status(200).json({
      message: "Seller categories and products updated successfully",
    });
  } catch (err) {
    console.error("Error updating seller categories/products:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.deleteSellerProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const deleteProduct = await Products.findByIdAndDelete(id);
    return res.status(200).json({ message: "Product Deleted", deleteProduct });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ResponseMsg: "An Error Occured" });
  }
};

exports.getDetailsGst = async (req, res) => {
  try {
    const { gst } = req.query; // Expect GST number in query param: /api/gst?gst=XXXX
    if (!gst) {
      return res.status(400).json({ message: "GST number is required" });
    }

    const API_KEY = "9205753778-gst-lil2";
    const url = `https://rappid.in/apis/gst.php?key=${API_KEY}&gst=${gst}`;

    // Make the API request
    const response = await axios.get(url);

    // Return the API response to client
    return res.status(200).json({
      success: true,
      gstDetails: response.data,
    });
  } catch (error) {
    console.error("Error fetching GST details:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch GST details",
      error: error.message,
    });
  }
};

exports.getCategoryProduct = async (req, res) => {
  try {
    let { categories, subCategories, subsubCategories } = req.query;

    // Split IDs from query params
    categories = categories ? categories.split("%") : [];
    subCategories = subCategories ? subCategories.split("%") : [];
    subsubCategories = subsubCategories ? subsubCategories.split("%") : [];

    // Helper to convert to ObjectIds
    const toObjectIdArray = (ids) =>
      ids
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

    const categoryIds = toObjectIdArray(categories);
    const subCategoryIds = toObjectIdArray(subCategories);
    const subsubCategoryIds = toObjectIdArray(subsubCategories);

    // Build query
    const query = {
      $or: [
        { "category._id": { $in: categoryIds } },
        { "subCategory._id": { $in: subCategoryIds } },
        { "subSubCategory._id": { $in: subsubCategoryIds } },
      ],
    };

    const products = await Product.find(query)
      .select(
        "_id productName productThumbnailUrl " +
          "category._id category.name " +
          "subCategory._id subCategory.name " +
          "subSubCategory._id subSubCategory.name "
      )
      .lean();

    res
      .status(200)
      .json({ message: "Products fetched successfully", products });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

exports.getSellerCategoryMapping = async (req, res) => {
  const { id } = req.params;
  try {
    const store = await Store.findById(id).select("sellerCategories");
    if (!store) {
      return res.status(404).json({ message: "Store not found" });
    }
    const products = await Products.find({ sellerId: id }).select("product_id");

    const sellerProducts = products.map((p) => p.product_id);

    // 3. Return both
    return res.status(200).json({
      sellerCategories: store.sellerCategories || [],
      sellerProducts: sellerProducts || [],
    });
  } catch (err) {
    console.error("Error fetching seller mapping:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getSellerCategories = async (req, res) => {
  const { id } = req.params;

  try {
    const store = await Store.findById(id).select("sellerCategories").lean();

    if (
      !store ||
      !store.sellerCategories ||
      store.sellerCategories.length === 0
    ) {
      return res
        .status(404)
        .json({ message: "No seller categories found for this store." });
    }

    // Get all category IDs to fetch from Category collection
    const categoryIds = store.sellerCategories.map((c) => c.categoryId);
    const categories = await Category.find({
      _id: { $in: categoryIds },
    }).lean();

    const result = store.sellerCategories
      .map((storeCat) => {
        const fullCat = categories.find(
          (c) => c._id.toString() === storeCat.categoryId.toString()
        );
        if (!fullCat) return null;

        const subCategories = storeCat.subCategories || [];
        let totalSubSubCategories = 0;

        subCategories.forEach((sub) => {
          totalSubSubCategories += (sub.subSubCategories || []).length;
        });

        return {
          _id: storeCat.categoryId,
          name: fullCat.name || "Unknown",
          image: fullCat.image || null,
          subCategoryCount: subCategories.length,
          subSubCategoryCount: totalSubSubCategories,
        };
      })
      .filter(Boolean); // filter out nulls

    return res.status(200).json({ categories: result });
  } catch (error) {
    console.error("Error in getSellerCategories:", error);
    return res.status(500).json({ message: "Internal server error", error });
  }
};

exports.getSellerProducts = async (req, res) => {
  const { sellerId, page = 1, limit, search = "", category = "" } = req.query;

  try {
    if (!sellerId) {
      return res.status(400).json({ success: false, message: "Missing sellerId" });
    }

    let productMatch = {};
    if (search) {
      productMatch.productName = { $regex: search, $options: "i" };
    }

    if (category) {
      productMatch["category._id"] = new mongoose.Types.ObjectId(category);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    /* ---------------- STOCK ---------------- */
    const stockData = await Stock.findOne({ storeId: sellerId }).lean();
    const stockEntries = stockData?.stock || [];

    const productIds = stockEntries
      .map((s) => s.productId)
      .filter(Boolean)
      .map((id) => new mongoose.Types.ObjectId(id));

    /* ---------------- TOTAL (UNCHANGED LOGIC) ---------------- */
    const total = await Product.countDocuments({ _id: { $in: productIds } });

    /* ---------------- PRODUCTS ---------------- */
    const sellerProducts = await Product.find({
      _id: { $in: productIds },
      ...productMatch,
    })
      .skip(skip)
      .limit(parseInt(limit))
      .select(
        "productName mrp sku sell_price productThumbnailUrl category subCategory subSubCategory variants"
      )
      .lean();

    /* ---------------- CATEGORY PREFETCH (OPTIMIZATION ONLY) ---------------- */
    const categoryIds = [
      ...new Set(
        sellerProducts
          .map((p) => p.category?.[0]?._id?.toString())
          .filter(Boolean)
      ),
    ];

    const categories = await Category.find({ _id: { $in: categoryIds } }).lean();

    const categoryMap = {};
    categories.forEach((cat) => {
      categoryMap[cat._id.toString()] = cat;
    });

    /* ---------------- RESPONSE BUILD (LOGIC PRESERVED) ---------------- */
    const products = await Promise.all(
      sellerProducts.map(async (prod) => {
        const productIdStr = prod._id.toString();

        const subCategoryId = prod.subCategory?.[0]?._id?.toString();
        const subSubCategoryId = prod.subSubCategory?.[0]?._id?.toString();
        const categoryId = prod.category?.[0]?._id?.toString();

        let commission = 0;
        let categoryName = "Uncategorized";

        const fullCategory = categoryMap[categoryId];

        if (fullCategory) {
          categoryName = fullCategory.name ?? "Uncategorized";

          if (fullCategory.subcat && (subSubCategoryId || subCategoryId)) {
            const matchedSubcat = fullCategory.subcat.find(
              (sub) => sub._id.toString() === subCategoryId
            );

            if (matchedSubcat?.subsubcat?.length) {
              const matchedSubSubCat = matchedSubcat.subsubcat.find(
                (ss) => ss._id.toString() === subSubCategoryId
              );
              commission =
                matchedSubSubCat?.commison ??
                matchedSubcat?.commison ??
                0;
            } else {
              commission = matchedSubcat?.commison ?? 0;
            }
          }
        }

        const firstStockEntry = stockEntries.find(
          (s) => s.productId.toString() === productIdStr
        );

        const variantsWithStock = (prod.variants || []).map((variant) => {
          const stockEntry =
            stockEntries.find(
              (s) =>
                s.productId.toString() === productIdStr &&
                s.variantId?.toString() === variant._id.toString()
            ) || null;

          return {
            ...variant,
            stock: stockEntry?.quantity ?? 0,
            mrp: stockEntry?.mrp || variant.mrp,
            sell_price: stockEntry?.price || variant.sell_price,
            status: stockEntry?.status ?? false,
          };
        });

        return {
          sellerProductId: prod._id,
          productId: prod._id,
          productName: prod.productName,
          sku: prod.sku,
          productThumbnailUrl: prod.productThumbnailUrl,
          category: categoryName,
          subCategory: prod.subCategory?.[0]?.name ?? "Uncategorized",
          mrp: prod.mrp == 0 ? prod.mrp : prod.mrp,
          sell_price: prod.sell_price == 0 ? prod.sell_price : prod.sell_price,
          variants: variantsWithStock,
          status: firstStockEntry?.status ?? false,
          commission,
        };
      })
    );

    res.json({
      success: true,
      products,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Error in getSellerProducts:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.updateSellerProducStatus = async (req, res) => {
  const { id } = req.params;
  const { productId, status } = req.body;
  try {
    if (!id || !productId || typeof status !== "boolean") {
      return res.status(400).json({ message: "Invalid request" });
    }

    // find and update product for this seller
    const updated = await Products.findOneAndUpdate(
      { "stock.productId": productId, storeId: id },
      { $set: { "stock.$.status": status } },
      { new: true }
    );
    console.log("updated", updated);
    if (!updated) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(200).json({
      message: "Product status updated successfully",
    });
  } catch (err) {
    // console.error("Error updating product status:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getSellerCategoryList = async (req, res) => {
  try {
    const { id } = req.params;
    const store = await Store.findOne({ _id: id }).lean();
    if (!store) {
      return res.status(404).json({ message: "Store not found" });
    }
    const categoryIds = store.sellerCategories.map((c) => c.categoryId);
    const categories = await Category.find({
      _id: { $in: categoryIds },
    }).lean();
    return res.status(200).json({
      message: "Categories fetched successfully",
      categories,
    });
  } catch (err) {
    //console.error("Error fetching seller categories:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getExistingProductList = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 3) {
      return res
        .status(400)
        .json({ message: "Search term must be at least 3 characters" });
    }

    const regex = new RegExp(q, "i");

    const matchedProducts = await Product.find({
      $or: [
        { productName: regex },
        { description: regex },
        { "brand_Name.name": regex },
        { "category.name": regex },
        { "subCategory.name": regex },
        { "subSubCategory.name": regex },
      ], sellerProductStatus: {
    $nin: [
      "pending_admin_approval",
      "request_brand_approval",
      "submit_brand_approval",
      "rejected"
    ]
  }

    })
      .select(
        "productName productThumbnailUrl sku brand_Name category subCategory subSubCategory"
      )
      .lean();

    const products = await Promise.all(
      matchedProducts.map(async (prod) => {
        const subCategoryId = prod.subCategory?.[0]?._id?.toString();
        const subSubCategoryId = prod.subSubCategory?.[0]?._id?.toString();
        const categoryId = prod.category?.[0]?._id;

        let commission = 0;
        let categoryName = "Uncategorized";
        let subCategoryName = prod.subCategory?.[0]?.name || "";
        let subSubCategoryName = prod.subSubCategory?.[0]?.name || "";
        let brandName = prod.brand_Name?.name || "";

        if (categoryId) {
          const fullCategory = await Category.findById(categoryId).lean();
          categoryName = fullCategory?.name ?? "Uncategorized";

          if (fullCategory?.subcat && (subSubCategoryId || subCategoryId)) {
            const matchedSubcat = fullCategory.subcat.find(
              (sub) => sub._id.toString() === subCategoryId
            );

            if (matchedSubcat && Array.isArray(matchedSubcat.subsubcat)) {
              const matchedSubSubCat = matchedSubcat.subsubcat.find(
                (subsub) => subsub._id.toString() === subSubCategoryId
              );
              commission =
                matchedSubSubCat?.commison ?? matchedSubcat?.commison ?? 0;
            } else {
              commission = matchedSubcat?.commison ?? 0;
            }
          }
        }

        return {
          productId: prod._id,
          productName: prod.productName,
          sku: prod.sku,
          image: prod.productThumbnailUrl,
          brand: brandName,
          category: categoryName,
          subCategory: subCategoryName,
          subSubCategory: subSubCategoryName,
          categoryId: prod.category?.[0]?._id ?? null,
          subCategoryId: prod.subCategory?.[0]?._id ?? null,
          subSubCategoryId: prod.subSubCategory?.[0]?._id ?? null,
          commission,
        };
      })
    );

    return res.status(200).json({ success: true, products });
  } catch (error) {
    console.error("Search product error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

exports.removeCategory = async (req, res) => {
  try {
    const { storeId, categoryId } = req.body;
    const result = await Store.findByIdAndUpdate(
      storeId,
      {
        $pull: {
          sellerCategories: { categoryId: categoryId },
        },
      },
      { new: true }
    );

    const stockDoc = await Stock.findOne({ storeId });

    const productsInCategory = await Product.find({
      "category._id": categoryId,
    }).select("_id");
    const productIdsToRemove = productsInCategory.map((p) => p._id.toString());

    // 4️⃣ Filter stock array (remove all products in that category)
    const filteredStock = stockDoc.stock.filter(
      (item) => !productIdsToRemove.includes(item.productId.toString())
    );

    // 5️⃣ Save updated stock
    stockDoc.stock = filteredStock;

    const updatedStock = await stockDoc.save();

    return res.status(200).json({
      success: true,
      message: "Categories removed successfully",
      store: result,
    });
  } catch (error) {
    console.error("Search product error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

exports.removeProduct = async (req, res) => {
  try {
    const { storeId, productId } = req.body;
    const result = await Stock.findOneAndUpdate(
      { storeId: storeId },
      {
        $pull: {
          stock: { productId: productId },
        },
      },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Product removed successfully",
      store: result,
    });
  } catch (error) {
    console.error("Search product error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

exports.getUnapprovedProducts = async (req, res) => {
  try {
    const sellerId = req.query.sellerId;
    const search = req.query.search || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;

    if (!sellerId || !mongoose.Types.ObjectId.isValid(sellerId)) {
      return res.status(400).json({ message: "Invalid sellerId" });
    }

    const query = {
      addedBy: sellerId,
      sellerProductStatus: { $ne: "approved" },
      productName: { $regex: search, $options: "i" },
    };
    const total = await Product.countDocuments(query);

    const products = await Product.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.status(200).json({
      total,
      page,
      limit,
      products,
    });
  } catch (error) {
    console.error("Error fetching unapproved products:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.saveBrandApprovelDocument = async (req, res) => {
  try {
    const { productId, description } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });
    if (req.files.brandDocument) {
      const image = `/${req.files.brandDocument?.[0].key}`;
      console.log(image, 34873784);
      product.brandApprovalDocument = image;
    }
    if (description) {
      product.brandApprovelDescription = description;
    }
    product.sellerProductStatus = "submit_brand_approval";
    await product.save();
    res.status(200).json({ message: "Brand approval updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Something went wrong" });
  }
};
