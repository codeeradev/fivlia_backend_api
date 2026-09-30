const jwt = require("jsonwebtoken");
const Store = require("../modals/store");
const AdminStaff = require("../modals/roleBase/adminStaff");

// Accepts a Bearer token issued to a seller (payload _id = Store _id) or to an
// admin/staff user (payload _id = AdminStaff _id).
// Sets req.auth = { role: "seller", storeId } or { role: "admin", staffId }.
module.exports = async function sellerOrAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

    if (!token) {
      return res
        .status(401)
        .json({ status: false, message: "A token is required for authorization" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.jwtSecretKey);
    } catch (err) {
      return res.status(401).json({ status: false, message: "Invalid Token" });
    }

    const id = decoded?._id;
    if (!id) {
      return res.status(401).json({ status: false, message: "Invalid Token" });
    }

    const store = await Store.findById(id).select("_id").lean();
    if (store) {
      req.auth = { role: "seller", storeId: String(store._id) };
      return next();
    }

    const staff = await AdminStaff.findById(id).select("_id").lean();
    if (staff) {
      req.auth = { role: "admin", staffId: String(staff._id) };
      return next();
    }

    return res.status(401).json({ status: false, message: "Account not found" });
  } catch (err) {
    console.error("sellerOrAdminAuth error:", err.message);
    return res.status(500).json({ status: false, message: "Authentication failed" });
  }
};
