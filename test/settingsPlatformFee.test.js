const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const fee = require('../utils/platformFee');

async function run({ userId = { id: 'user-1' }, missingUser = false } = {}) {
  const stored = { Platform_Fee: 3, Platform_Fee_Fixed: 12 };
  const ctx = {
    exports: {},
    console,
    require(name) {
      if (name === '../utils/platformFee') return fee;
      if (name === '../modals/setting') {
        return { SettingAdmin: { findOne: () => ({ lean: async () => stored }) } };
      }
      if (name === '../modals/User') {
        return {
          findById: (id) => {
            assert.equal(id, 'user-1');
            return { lean: async () => (missingUser ? null : { mobileNumber: 'test' }) };
          },
        };
      }
      if (name === '../modals/pages') return { find: () => ({ lean: async () => [] }) };
      if (name === '../utils/globalDelivery') {
        return { withGlobalSettingDefaults: (settings) => ({ ...settings }) };
      }
      if (name === '../utils/shippingPlatforms') return { validateShippingPlatforms: (value) => ({ values: value }) };
      return {};
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../controlers/settingControler.js'), 'utf8'),
    ctx,
  );
  const res = {
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await ctx.exports.settings({ user: userId }, res);
  return { res, stored };
}

test('settings API returns configured fee values without cart-specific calculations', async () => {
  const { res, stored } = await run();
  assert.equal(res.code, 200);
  assert.equal(res.body.settings.Platform_Fee, 3);
  assert.equal(res.body.settings.Platform_Fee_Fixed, 12);
  assert.equal(stored.Platform_Fee, 3);
});

test('backend calculates the percentage plus fixed platform fee in rupees', () => {
  assert.deepEqual(fee.getLocalPlatformFee(100, {
    Platform_Fee: 3,
    Platform_Fee_Fixed: 12,
  }), { amount: 15, percent: 15 });
  assert.equal(fee.getLocalPlatformFee(280, {
    Platform_Fee: 2.5,
    Platform_Fee_Fixed: 12,
  }).amount, 19);
  assert.equal(fee.getLocalPlatformFee(100, {
    Platform_Fee: 3.25,
    Platform_Fee_Fixed: 1.25,
  }).amount, 5);
  assert.equal(fee.getLocalPlatformFee(108, {
    Platform_Fee: 2.5,
    Platform_Fee_Fixed: 12,
  }).amount, 15);
});

test('settings API preserves configured values for authenticated user id shapes', async () => {
  for (const userId of [{ _id: 'user-1' }, 'user-1']) {
    const { res } = await run({ userId });
    assert.equal(res.code, 200);
    assert.equal(res.body.settings.Platform_Fee, 3);
    assert.equal(res.body.settings.Platform_Fee_Fixed, 12);
  }
});

test('missing authenticated user still returns 404', async () => {
  const { res } = await run({ missingUser: true });
  assert.equal(res.code, 404);
});
