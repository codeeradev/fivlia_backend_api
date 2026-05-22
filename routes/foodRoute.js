const express = require("express");
const upload = require("../midllerware/multer");
const router = express.Router();
const verifyToken = require("../midllerware/authToken");
const typeCategoryResolver = require("../midllerware/typeChecker.js");

//admin api 
const { addFood, getActiveFoods, getAllFoods, updateFood, deleteFood, getFoodSeller, addFoodToSeller, removeFoodFromSeller } = require("../controlers/foodControler");
//


router.post("/add-food", upload, addFood);
router.get("/get-all-food", getAllFoods);
router.get("/get-active-food", getActiveFoods);
router.post("/update-food/:id", upload, updateFood);
router.delete("/delete-food/:id", deleteFood);
router.get("/get-food-seller", getFoodSeller);
router.post("/add-food-to-seller", addFoodToSeller);
router.post("/remove-food-from-seller", removeFoodFromSeller);

module.exports = router;
