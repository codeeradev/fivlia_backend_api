require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  await db.collection("products").createIndex({ "brand_Name._id": 1 });
  await db.collection("products").createIndex({ "category.0._id": 1 });
  await db.collection("products").createIndex({ "subCategory.0._id": 1 });
  await db.collection("products").createIndex({ "subSubCategory.0._id": 1 });
  await db.collection("stocks").createIndex({ storeId: 1 });
  await db.collection("stocks").createIndex({ "stock.productId": 1 });
  await db.collection("stores").createIndex({ serviceScope: 1, status: 1 });
  await db.collection("brands").createIndex({ typeId: 1, createdAt: -1 });
  console.log("indexes created");
  process.exit(0);
})();
