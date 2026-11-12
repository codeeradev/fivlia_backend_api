const test = require("node:test");
const assert = require("node:assert/strict");
const { getSettingsForGlobalDelivery } = require("../utils/globalDeliverySettings");

const createSettingsModel = (settingsByPin, fallback) => {
  const queries = [];
  return {
    queries,
    findOne(filter = {}) {
      queries.push(filter);
      return {
        lean: async () =>
          filter["globalDeliveryRules.pincode"]
            ? settingsByPin[filter["globalDeliveryRules.pincode"]] || null
            : fallback,
      };
    },
  };
};

test("global delivery settings prefer the document matching the checkout PIN", async () => {
  const pinSettings = {
    globalDeliveryRules: [{ pincode: "127046", shippingCharge: 101 }],
  };
  const model = createSettingsModel({ "127046": pinSettings }, { globalDeliveryRules: [] });

  const settings = await getSettingsForGlobalDelivery(model, "127046");

  assert.equal(settings, pinSettings);
  assert.deepEqual(model.queries, [{ "globalDeliveryRules.pincode": "127046" }]);
});

test("global delivery settings fall back to defaults for an unlisted valid PIN", async () => {
  const defaults = { globalDeliveryDefaults: { shippingCharge: 44 } };
  const model = createSettingsModel({}, defaults);

  const settings = await getSettingsForGlobalDelivery(model, "127046");

  assert.equal(settings, defaults);
  assert.deepEqual(model.queries, [
    { "globalDeliveryRules.pincode": "127046" },
    {},
  ]);
});
