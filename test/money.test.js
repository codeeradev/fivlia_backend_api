const test = require("node:test");
const assert = require("node:assert/strict");
const { calculatePayableTotal } = require("../utils/money");

test("payable total includes subtotal, platform fee and global delivery charge", () => {
  assert.equal(calculatePayableTotal(45, 13, 50), 108);
});

test("payable total rounds the complete amount to paise", () => {
  assert.equal(calculatePayableTotal(45.125, 13, 12.5), 70.63);
});
