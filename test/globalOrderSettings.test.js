const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const delivery = require("../utils/globalDelivery");
const platforms = require("../utils/shippingPlatforms");
const rule = {
  pincode: "110001",
  shippingCharge: 50,
  daysMin: 2,
  daysMax: 4,
  codAllowed: false,
};
async function save(body) {
  let update;
  const stored = {
    globalShippingCharge: 75,
    globalDeliveryRules: [rule],
    shippingPlatforms: [{ name: "Existing courier", status: true }],
  };
  const ctx = {
    exports: {},
    console,
    require(name) {
      if (name === "../utils/globalDelivery") return delivery;
      if (name === "../utils/shippingPlatforms") return platforms;
      if (name === "../utils/platformFee")
        return { validatePlatformFeeSettings: () => null };
      if (name === "../modals/setting")
        return {
          SettingAdmin: {
            findOne: () => ({ lean: async () => stored }),
            findOneAndUpdate: async (_, value) => {
              update = value.$set;
              return { ...stored, ...update };
            },
          },
        };
      return {};
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../controlers/settingControler.js"),
      "utf8"
    ),
    ctx
  );
  const res = {
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await ctx.exports.adminSetting({ body, files: {} }, res);
  return { res, update };
}
test("new rules save through admin API without replacing shipping platforms", async () => {
  const { res, update } = await save({
    globalDeliveryRules: [{ ...rule, shippingCharge: 90 }],
  });
  assert.equal(res.code, 200);
  assert.equal(update.globalDeliveryRules[0].shippingCharge, 90);
  assert.equal(res.body.settings.shippingPlatforms[0].name, "Existing courier");
});
test("default delivery values save through admin API", async () => {
  const defaults = {
    shippingCharge: "25.5",
    daysMin: "3",
    daysMax: "7",
    codAllowed: true,
  };
  const { res, update } = await save({ globalDeliveryDefaults: defaults });
  assert.equal(res.code, 200);
  assert.deepEqual(update.globalDeliveryDefaults, {
    shippingCharge: 25.5,
    daysMin: 3,
    daysMax: 7,
    codAllowed: true,
  });
});
test("invalid rule rejects entire update before database mutation", async () => {
  const { res, update } = await save({
    globalDeliveryRules: [rule, rule],
    shippingPlatforms: [],
  });
  assert.equal(res.code, 400);
  assert.equal(update, undefined);
});
test("ordinary order settings updates preserve PIN-code rules", async () => {
  const { res, update } = await save({
    minPrice: 100,
    globalShippingCharge: 0,
  });
  assert.equal(res.code, 200);
  assert.equal(update.globalShippingCharge, undefined);
  assert.equal(update.globalDeliveryRules, undefined);
  assert.equal(res.body.settings.globalDeliveryRules[0].shippingCharge, 50);
});
test("removing all PIN codes persists an empty list", async () => {
  const { res } = await save({ globalDeliveryRules: [] });
  assert.equal(res.code, 200);
  assert.equal(res.body.settings.globalDeliveryRules.length, 0);
});

test("saving rules does not recreate retired fields", async () => {
  const { update } = await save({ globalDeliveryRules: [rule] });
  for (const key of ["globalShippingCharge", "globalFreeShippingLimit", "globalDeliveryDaysMin", "globalDeliveryDaysMax", "globalCodAllowed"]) {
    assert.equal(update[key], undefined);
  }
});
