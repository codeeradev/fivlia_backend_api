const test = require("node:test");
const assert = require("node:assert/strict");
const { SettingAdmin } = require("../modals/setting");
const { checkDelivery, deliveryRules } = require("../globalWebsite/controller");

test("website delivery endpoint returns configured defaults for an unlisted PIN", async () => {
  const originalFindOne = SettingAdmin.findOne;
  const defaults = {
    shippingCharge: 12,
    daysMin: 6,
    daysMax: 9,
    codAllowed: true,
  };
  let selectedFilter;
  SettingAdmin.findOne = (filter) => ({
    async lean() {
      selectedFilter = filter;
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
    assert.deepEqual(selectedFilter, { "globalDeliveryRules.pincode": "125037" });
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

test("public delivery rules endpoint returns searchable PIN charges and estimates", async () => {
  const originalFindOne = SettingAdmin.findOne;
  SettingAdmin.findOne = () => ({
    select() {
      return this;
    },
    async lean() {
      return {
        globalDeliveryRules: [
          { pincode: "127046", shippingCharge: 101, daysMin: 5, daysMax: 6, codAllowed: true },
          { pincode: "110001", shippingCharge: 50, daysMin: 2, daysMax: 3, codAllowed: false },
        ],
        globalDeliveryDefaults: {
          shippingCharge: 120,
          daysMin: 6,
          daysMax: 9,
          codAllowed: false,
        },
      };
    },
  });

  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await deliveryRules({ query: { search: "127" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, true);
    assert.equal(res.body.count, 1);
    assert.deepEqual(res.body.rules, [{
      pincode: "127046",
      shippingCharge: 101,
      daysMin: 5,
      daysMax: 6,
      deliveryDays: "5-6",
      estimatedDeliveryText: "5-6 days",
      codAllowed: true,
      ruleSource: "pincode",
    }]);
    assert.deepEqual(res.body.defaultRule, {
      shippingCharge: 120,
      daysMin: 6,
      daysMax: 9,
      deliveryDays: "6-9",
      estimatedDeliveryText: "6-9 days",
      codAllowed: false,
      ruleSource: "default",
    });
  } finally {
    SettingAdmin.findOne = originalFindOne;
  }
});
