const test = require("node:test");
const assert = require("node:assert/strict");
const { SettingAdmin } = require("../modals/setting");
const { checkDelivery } = require("../globalWebsite/controller");

test("website delivery endpoint returns configured defaults for an unlisted PIN", async () => {
  const originalFindOne = SettingAdmin.findOne;
  const defaults = {
    shippingCharge: 12,
    daysMin: 6,
    daysMax: 9,
    codAllowed: true,
  };
  let selectedFields;
  SettingAdmin.findOne = () => ({
    select(fields) {
      selectedFields = fields;
      return this;
    },
    async lean() {
      return { globalDeliveryRules: [], globalDeliveryDefaults: defaults };
    },
  });

  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await checkDelivery({ params: { pincode: "125037" } }, res);
    assert.equal(selectedFields, "globalDeliveryRules globalDeliveryDefaults");
    assert.equal(res.body.available, true);
    assert.equal(res.body.pincode, "125037");
    assert.equal(res.body.shippingCharge, 12);
    assert.equal(res.body.deliveryCharge, 12);
    assert.equal(res.body.daysMin, 6);
    assert.equal(res.body.daysMax, 9);
    assert.equal(res.body.deliveryDays, "6-9");
    assert.equal(res.body.estimatedDeliveryText, "6-9 days");
    assert.equal(res.body.codAllowed, true);
    assert.equal(res.body.ruleSource, "default");
  } finally {
    SettingAdmin.findOne = originalFindOne;
  }
});
