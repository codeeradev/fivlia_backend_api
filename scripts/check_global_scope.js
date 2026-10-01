// Run this on the BACKEND laptop (no mobile app needed):
//
//   node scripts/check_global_scope.js <mobileNumber | userId> [typeId] [baseUrl]
//
// It uses the same MONGO_URI / jwtSecretKey as the server, reads the database,
// and prints exactly what the mobile app would get for that user from
// GET /getMainCategory, and WHY. It only reads; it never writes.
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../modals/User");
const Store = require("../modals/store");
const Category = require("../modals/category");
const { getStoresWithinRadius } = require("../config/google");
const { resolveGlobalOnlyScope } = require("../utils/locationCategories");

const line = (...a) => console.log(...a);
const head = (t) => { line(); line("=== " + t + " ==="); };

async function findUser(idOrPhone) {
  if (/^[a-f0-9]{24}$/i.test(idOrPhone)) return User.findById(idOrPhone).lean();
  const last10 = String(idOrPhone).replace(/\D/g, "").slice(-10);
  return User.findOne({ mobileNumber: { $regex: last10 + "$" } }).lean();
}

async function run(idOrPhone, typeId, baseUrl = "http://localhost:" + (process.env.PORT || 8080)) {
  head("1. USER");
  const user = await findUser(idOrPhone);
  if (!user) { line("RESULT: user not found. Use the mobile number or the _id from the Login collection."); return; }
  line("name:", user.name, "| mobile:", user.mobileNumber, "| _id:", String(user._id));
  const lat = user.location?.latitude, lng = user.location?.longitude;
  line("saved location:", lat, lng, "| city:", user.location?.city, "| zone:", user.location?.zone);
  if (!lat || !lng) {
    line("RESULT: this user has NO saved location, so the filter is skipped (old behaviour).");
    line("FIX: the app must call POST /location for this user.");
    return;
  }

  head("2. SERVICE MODE for that location");
  const r = await getStoresWithinRadius(lat, lng);
  line("zoneAvailable:", r.zoneAvailable, "| hasLocalStores:", r.hasLocalStores, "| hasGlobalStores:", r.hasGlobalStores);
  line("serviceMode:", r.serviceMode);
  if (r.serviceMode !== "global_only") {
    line("RESULT: serviceMode is '" + r.serviceMode + "', the filter ONLY applies for 'global_only'.");
    if (r.serviceMode === "local" || r.serviceMode === "mixed")
      line("WHY: this user's saved location is INSIDE a service zone. Test with a user/location outside every zone.");
    if (r.serviceMode === "none")
      line("WHY: no active+open global store, and no zone covers this location (see section 3).");
  }

  head("3. ALL GLOBAL STORES IN THE DATABASE");
  const globals = await Store.find({ serviceScope: "global" }).lean();
  if (!globals.length) line("none found. Create a store with serviceScope 'global'.");
  for (const s of globals) {
    const cats = await Category.find({ _id: { $in: s.Category || [] } }, { name: 1 }).lean();
    line("-", s.storeName, "| _id:", String(s._id));
    line("    status:", s.status, s.status ? "" : "  <-- NOT ACTIVE, store is ignored");
    line("    openTime/closeTime:", s.openTime || "-", "/", s.closeTime || "-");
    line("    Category:", cats.length ? cats.map((c) => c.name).join(", ") : "(empty)",
         "| sellerCategories:", (s.sellerCategories || []).length);
  }

  head("4. WHAT THE APP GETS from GET /getMainCategory (token minted for this user)");
  const token = jwt.sign({ _id: user._id }, process.env.jwtSecretKey);
  const fakeReq = { headers: { authorization: "Bearer " + token }, query: {} };
  const scope = await resolveGlobalOnlyScope(fakeReq);
  if (!scope) {
    line("Filter applies: NO  -> the app receives ALL categories (old behaviour).");
  } else {
    const cats = await Category.find({ _id: { $in: scope.mainCategoryIds } }, { name: 1 }).lean();
    line("Filter applies: YES -> the app receives ONLY:", cats.length ? cats.map((c) => c.name).join(", ") : "(empty list)");
  }

  head("5. TEST THE LIVE SERVER (run from any laptop)");
  const q = typeId ? "?typeId=" + typeId : "";
  line("curl -i \"" + baseUrl + "/getMainCategory" + q + "\" -H \"Authorization: Bearer " + token + "\"");
  line();
  line("Tip: set GLOBAL_SCOPE_DEBUG=1 in the server .env and restart: the response then");
  line("contains \"globalScopeDebug\" (and an X-Global-Scope header) saying why.");
  line("If curl shows the filtered list but the app does not, the app is not sending the token.");
}

module.exports = { run };

if (require.main === module) {
  const [idOrPhone, typeId, baseUrl] = process.argv.slice(2);
  if (!idOrPhone) {
    console.log("Usage: node scripts/check_global_scope.js <mobileNumber | userId> [typeId] [baseUrl]");
    process.exit(1);
  }
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    try { await run(idOrPhone, typeId, baseUrl || "http://localhost:" + (process.env.PORT || 8080)); }
    catch (e) { console.error("script error:", e); }
    await mongoose.disconnect();
  })();
}
