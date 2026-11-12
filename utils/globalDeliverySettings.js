const { isValidPincode, normalizePincode } = require("./globalDelivery");

const findOneLean = async (SettingAdmin, filter) => {
  let query = SettingAdmin.findOne(filter);
  if (query && typeof query.lean === "function") query = query.lean();
  return query;
};

// Prefer the settings document that explicitly contains this PIN rule. This
// keeps cart quotes and checkout pricing consistent if the database contains
// more than one settings document. Unlisted PINs still use the default rule.
const getSettingsForGlobalDelivery = async (SettingAdmin, pincode) => {
  const pin = normalizePincode(pincode);
  if (isValidPincode(pin)) {
    const pinSettings = await findOneLean(SettingAdmin, {
      "globalDeliveryRules.pincode": pin,
    });
    if (pinSettings) return pinSettings;
  }

  return findOneLean(SettingAdmin, {});
};

module.exports = { getSettingsForGlobalDelivery };
