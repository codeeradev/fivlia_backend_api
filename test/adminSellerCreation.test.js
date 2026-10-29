const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { isTruthyFlag } = require('../utils/sellerDelivery');

async function create(body) {
  let saved;
  const store = { create: async (data) => { saved = data; return { _id: 'new-store', ...data }; } };
  const context = {
    exports: {}, console: { log() {}, error() {} },
    require: (name) => {
      if (name === '../modals/store') return store;
      if (name === '../modals/Product') return { find: async () => [] };
      if (name === '../utils/sellerDelivery') return { isTruthyFlag };
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controlers/storeControler.js'), 'utf8'), context);
  const response = { status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
  await context.exports.createStore({ body: { storeName: 'Test Seller', serviceScope: 'global', ...body } }, response);
  assert.equal(response.code, 201, JSON.stringify(response.body));
  return saved;
}

for (const value of ['false', false]) {
  test(`admin seller (${JSON.stringify(value)}) enters approval queue without being active or verified`, async () => {
    const saved = await create({ isAuthorized: value, Category: '[]', status: true });
    assert.equal(saved.Authorized_Store, false);
    assert.equal(saved.approveStatus, 'pending_admin_approval');
    assert.equal(saved.status, false);
    assert.equal(saved.emailVerified, false);
    assert.notEqual(saved.phoneNumberVerified, true);
  });
}

test('seller without category selection can be created for approval', async () => {
  const saved = await create({ isAuthorized: 'false' });
  assert.equal(saved.Category.length, 0);
  assert.equal(saved.approveStatus, 'pending_admin_approval');
});

for (const value of ['true', true, undefined]) {
  test(`authorized store (${JSON.stringify(value)}) preserves legacy behavior`, async () => {
    const saved = await create({ isAuthorized: value, Category: '[]', status: true });
    assert.equal(saved.Authorized_Store, true);
    assert.equal(saved.status, true);
    assert.equal(saved.approveStatus, undefined);
  });
}
