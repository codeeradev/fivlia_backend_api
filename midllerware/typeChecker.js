// middleware/typeCategoryResolver.js

const mongoose = require("mongoose");
const Category = require("../modals/category");

const typeCategoryResolver = async (req, res, next) => {
  try {
    const { typeId } = req.query;

    if (!typeId) return next();

    if (!mongoose.Types.ObjectId.isValid(typeId)) {
      return res.status(400).json({
        message: "Invalid typeId",
      });
    }

    const category = await Category.findOne({
      typeId: typeId,
      status: true,
    }).lean();

    if (!category) {
      return res.status(400).json({
        message: "Category not found",
      });
    }

    const categoryIds = new Set();
    const subCategoryIds = new Set();
    const allCategoryIds = new Set();

    // main category
    categoryIds.add(category._id.toString());
    allCategoryIds.add(category._id.toString());

    // sub categories
    (category.subcat || []).forEach((sub) => {
      if (sub?._id) {
        subCategoryIds.add(sub._id.toString());
        allCategoryIds.add(sub._id.toString());
      }

      // subsub categories
      (sub.subsubcat || []).forEach((subsub) => {
        if (subsub?._id) {
          allCategoryIds.add(subsub._id.toString());
        }
      });
    });

    req.typeId = typeId;
    req.categoryIds = [...categoryIds];
    req.subCategoryIds = [...subCategoryIds];
    req.allCategoryIds = [...allCategoryIds];

    next();
  } catch (error) {
    return res.status(500).json({
      message: "Type resolver error",
      error: error.message,
    });
  }
};

module.exports = typeCategoryResolver;