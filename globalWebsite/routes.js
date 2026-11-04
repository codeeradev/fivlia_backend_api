const express = require("express");
const controller = require("./controller");
const router = express.Router();

router.get("/delivery/:pincode", controller.checkDelivery);
router.get("/banners", controller.banners);
router.get("/categories", controller.categories);
router.get("/brands", controller.brands);
router.get("/stores", controller.stores);
router.get("/counts", controller.productCounts);
router.get("/products", controller.products);
router.get("/featured", (req, res) => { req.query.featured = "true"; return controller.products(req, res); });
router.get("/search", controller.products);
router.get("/product/:slug", controller.productBySlug);
router.get("/related/:id", controller.relatedProducts);
router.get("/recommended", controller.recommendedProducts);
router.get("/seller", controller.seller);
router.post("/inquiry", controller.submitInquiry);

module.exports = router;

