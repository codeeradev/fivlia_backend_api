const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const delivery = require("../utils/globalDelivery");
async function checkout(
  pincode,
  paymentMode,
  website = false,
  defaultsAvailable = true,
  storeScope = "global",
) {
  let cartRead = false;
  let counterCalls = 0;
  const ctx = {
    exports: {},
    console: { log() {}, error() {} },
    require(name) {
      if (name === "../utils/globalDelivery") return delivery;
      if (name === "../modals/store")
        return {
          findById: () => ({ lean: async () => ({ serviceScope: storeScope }) }),
        };
      if (name === "../modals/Address")
        return { findById: async () => ({ pincode }) };
      if (name === "../modals/setting")
        return {
          SettingAdmin: {
            findOne: async () => ({
              globalDeliveryRules: [
                {
                  pincode: "110001",
                  shippingCharge: 50,
                  daysMin: 2,
                  daysMax: 4,
                  codAllowed: false,
                },
              ],
              ...(defaultsAvailable
                ? {
                    globalDeliveryDefaults: {
                      shippingCharge: 75,
                      daysMin: 6,
                      daysMax: 9,
                      codAllowed: false,
                    },
                  }
                : {}),
            }),
          },
        };
      if (name === "../modals/cart")
        return {
          Cart: {
            find: async () => {
              cartRead = true;
              return [];
            },
          },
        };
      if (name === "../config/counter")
        return {
          getNextOrderId: async () => {
            counterCalls++;
          },
        };
      return {};
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../controlers/orderControler.js"),
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
  await ctx.exports.placeOrder(
    {
      body: {
        cartIds: ["cart"],
        addressId: "address",
        storeId: "store",
        paymentMode,
      },
      isWebsiteGlobalOrder: website,
    },
    res
  );
  return { res, cartRead, counterCalls };
}
test("checkout rejects unsupported PIN before order side effects", async () => {
  const { res, cartRead, counterCalls } = await checkout("400001", false, false, false);
  assert.equal(res.code, 400);
  assert.equal(res.body.errorType, "global_delivery_unavailable");
  assert.equal(cartRead, false);
  assert.equal(counterCalls, 0);
});
test("checkout rejects COD using the actual selected address rule", async () => {
  const { res, cartRead, counterCalls } = await checkout("110001", true);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /Cash on delivery/);
  assert.equal(cartRead, false);
  assert.equal(counterCalls, 0);
});
test("online payment for a supported PIN passes delivery validation", async () => {
  const { res, cartRead } = await checkout("110001", false);
  assert.equal(cartRead, true);
  assert.match(res.body.message, /Cart item.*not found/);
});
test("website global checkout uses admin defaults for a valid unlisted PIN", async () => {
  const { res, cartRead } = await checkout("400001", false, true);
  assert.equal(cartRead, true);
  assert.match(res.body.message, /Cart item.*not found/);
  assert.notEqual(res.body.errorType, "global_delivery_unavailable");
});
test("website global checkout applies global PIN validation even if store scope is stale", async () => {
  const { res, cartRead } = await checkout("400001", false, true, false, "city");
  assert.equal(res.code, 400);
  assert.equal(res.body.errorType, "global_delivery_unavailable");
  assert.equal(cartRead, false);
});
test("app global checkout uses admin defaults for an unlisted valid PIN", async () => {
  const { res, cartRead } = await checkout("400001", false, false);
  assert.equal(cartRead, true);
  assert.match(res.body.message, /Cart item.*not found/);
  assert.notEqual(res.body.errorType, "global_delivery_unavailable");
});
test("website fallback COD setting is enforced for an unlisted PIN", async () => {
  const { res, cartRead } = await checkout("400001", true, true);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /Cash on delivery/);
  assert.equal(cartRead, false);
});
