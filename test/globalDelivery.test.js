const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateGlobalSettings,
  getGlobalSettings,
  getGlobalDeliveryRule,
  computeGlobalShippingCharge,
  isGlobalCodAllowed,
  formatGlobalDeliveryText,
  buildGlobalEstimateEntry,
  getWebsiteGlobalSettings,
  buildWebsiteGlobalEstimateEntry,
  withGlobalSettingDefaults,
} = require("../utils/globalDelivery");
const first = {
  pincode: "110001",
  shippingCharge: 50,
  daysMin: 2,
  daysMax: 4,
  codAllowed: true,
};
const second = {
  pincode: "400001",
  shippingCharge: 80,
  daysMin: 3,
  daysMax: 3,
  codAllowed: false,
};
const settings = {
  globalDeliveryRules: [first, second],
  globalShippingCharge: 1,
  globalCodAllowed: true,
};
test("each PIN code has its own charge, days and COD regardless of cart total", () => {
  assert.equal(computeGlobalShippingCharge(10, settings, "110001"), 50);
  assert.equal(computeGlobalShippingCharge(10000, settings, "400001"), 80);
  assert.equal(formatGlobalDeliveryText(settings, "110001"), "2-4 days");
  assert.equal(formatGlobalDeliveryText(settings, "400001"), "3 days");
  assert.equal(isGlobalCodAllowed(settings, "110001"), true);
  assert.equal(isGlobalCodAllowed(settings, "400001"), false);
});
test("unconfigured/missing PIN codes never fall back to legacy charges or COD", () => {
  for (const pin of ["560001", undefined, "", "011001"]) {
    assert.equal(getGlobalSettings(settings, pin), null);
    assert.equal(isGlobalCodAllowed(settings, pin), false);
    assert.equal(formatGlobalDeliveryText(settings, pin), null);
    assert.equal(buildGlobalEstimateEntry({ _id: "s" }, settings, pin), null);
    assert.throws(
      () => computeGlobalShippingCharge(100, settings, pin),
      /not available/
    );
  }
});
test("website uses exact PIN rules first and admin defaults for other valid PINs", () => {
  const withDefaults = {
    ...settings,
    globalDeliveryDefaults: {
      shippingCharge: 30,
      daysMin: 5,
      daysMax: 8,
      codAllowed: true,
    },
  };
  assert.equal(getWebsiteGlobalSettings(withDefaults, "110001").shippingCharge, 50);
  assert.equal(getWebsiteGlobalSettings(withDefaults, "110001").source, "pincode");
  assert.equal(computeGlobalShippingCharge(
    100,
    withDefaults,
    "110001",
    getWebsiteGlobalSettings(withDefaults, "110001"),
  ), 50);
  assert.deepEqual(getWebsiteGlobalSettings(withDefaults, "560001"), {
    ...withDefaults.globalDeliveryDefaults,
    pincode: "560001",
    source: "default",
  });
  assert.equal(getWebsiteGlobalSettings(withDefaults, "011001"), null);
  const defaultRule = getWebsiteGlobalSettings(withDefaults, "560001");
  assert.equal(computeGlobalShippingCharge(100, withDefaults, "560001", defaultRule), 30);
  assert.equal(isGlobalCodAllowed(withDefaults, "560001", defaultRule), true);
  const entry = buildWebsiteGlobalEstimateEntry({ _id: "s", storeName: "Global" }, withDefaults, "560001");
  assert.equal(entry.duration, "5-8 days");
  assert.equal(entry.estimatedDeliveryText, "5-8 days");
  assert.equal(entry.deliveryCharge, 30);
  assert.equal(entry.raw.deliveryRuleSource, "default");
});
test("all global delivery callers use PIN rules first, then the admin defaults", () => {
  const withDefaults = {
    ...settings,
    globalDeliveryDefaults: {
      shippingCharge: 30,
      daysMin: 5,
      daysMax: 8,
      codAllowed: true,
    },
  };

  const exactRule = getGlobalDeliveryRule(withDefaults, "110001");
  assert.equal(exactRule.shippingCharge, 50);
  assert.equal(exactRule.source, "pincode");
  assert.equal(computeGlobalShippingCharge(100, withDefaults, "110001"), 50);
  assert.equal(formatGlobalDeliveryText(withDefaults, "110001"), "2-4 days");

  const defaultRule = getGlobalDeliveryRule(withDefaults, "560001");
  assert.equal(defaultRule.shippingCharge, 30);
  assert.equal(defaultRule.source, "default");
  assert.equal(computeGlobalShippingCharge(100, withDefaults, "560001"), 30);
  assert.equal(formatGlobalDeliveryText(withDefaults, "560001"), "5-8 days");
  assert.equal(isGlobalCodAllowed(withDefaults, "560001"), true);

  const estimate = buildGlobalEstimateEntry(
    { _id: "s", storeName: "Global" },
    withDefaults,
    "560001",
  );
  assert.equal(estimate.duration, "5-8 days");
  assert.equal(estimate.estimatedDeliveryText, "5-8 days");
  assert.equal(estimate.deliveryCharge, 30);
  assert.equal(estimate.raw.deliveryRuleSource, "default");
  assert.equal(getGlobalDeliveryRule(withDefaults, "011001"), null);
});
test("rules normalize numeric inputs and PIN whitespace; an empty list disables delivery", () => {
  assert.deepEqual(
    validateGlobalSettings({
      globalDeliveryRules: [
        { ...first, pincode: " 110001 ", shippingCharge: "50", daysMin: "2" },
      ],
    }).values.globalDeliveryRules,
    [first]
  );
  assert.deepEqual(validateGlobalSettings({ globalDeliveryRules: [] }), {
    values: { globalDeliveryRules: [] },
  });
  assert.deepEqual(validateGlobalSettings({ shippingPlatforms: [] }), {
    values: {},
  });
  assert.equal(withGlobalSettingDefaults({ globalShippingCharge: 50 }).globalShippingCharge, undefined);
  assert.equal(withGlobalSettingDefaults({}).globalDeliveryDaysMin, undefined);
  assert.equal(withGlobalSettingDefaults({}).globalDeliveryDefaults, null);
  assert.deepEqual(
    withGlobalSettingDefaults({ globalDeliveryDefaults: first }).globalDeliveryDefaults,
    first,
  );
});
test("default delivery values validate and normalize for unlisted PIN fallback", () => {
  assert.deepEqual(
    validateGlobalSettings({
      globalDeliveryDefaults: {
        shippingCharge: "25.5",
        daysMin: "3",
        daysMax: 7,
        codAllowed: true,
      },
    }).values.globalDeliveryDefaults,
    { shippingCharge: 25.5, daysMin: 3, daysMax: 7, codAllowed: true },
  );
  assert.equal(
    validateGlobalSettings({ globalDeliveryDefaults: null }).values.globalDeliveryDefaults,
    null,
  );
  for (const patch of [
    { shippingCharge: -1 },
    { daysMin: 1.5 },
    { daysMax: 2, daysMin: 3 },
    { codAllowed: "false" },
  ]) {
    assert.ok(
      validateGlobalSettings({
        globalDeliveryDefaults: {
          shippingCharge: 10,
          daysMin: 2,
          daysMax: 4,
          codAllowed: true,
          ...patch,
        },
      }).error,
      JSON.stringify(patch),
    );
  }
});
test("invalid rules and duplicate PIN codes are rejected", () => {
  for (const patch of [
    { pincode: "12345" },
    { pincode: "abcdef" },
    { shippingCharge: -1 },
    { shippingCharge: "" },
    { shippingCharge: null },
    { shippingCharge: true },
    { daysMin: 1.5 },
    { daysMax: 1 },
    { daysMax: Infinity },
    { codAllowed: "false" },
  ]) {
    assert.ok(
      validateGlobalSettings({ globalDeliveryRules: [{ ...first, ...patch }] })
        .error,
      JSON.stringify(patch)
    );
  }
  for (const rules of [
    null,
    {},
    [null],
    [first, { ...first, pincode: " 110001 " }],
  ]) {
    assert.ok(validateGlobalSettings({ globalDeliveryRules: rules }).error);
  }
});
