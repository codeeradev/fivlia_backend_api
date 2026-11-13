const axios = require("axios");
const crypto = require("crypto");

// Cashfree's current Payments API version as documented at
// https://www.cashfree.com/docs/api-reference/payments/latest/.
const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || "2026-01-01";

const getCashfreeCredentials = (paymentGateways, mode) => {
  const selectedMode = mode === "test" ? "test" : "live";
  const credentials = paymentGateways?.Cashfree?.[selectedMode] || {};
  const configuredEnvironment = String(process.env.CASHFREE_ENV || "").trim().toLowerCase();
  const environmentMatchesMode = selectedMode === "test"
    ? ["sandbox", "test"].includes(configuredEnvironment)
    : ["production", "prod", "live"].includes(configuredEnvironment);
  const clientId = String(
    credentials.clientId || (environmentMatchesMode ? process.env.CASHFREE_APP_ID : "") || "",
  ).trim();
  const clientSecret = String(
    credentials.clientSecret || (environmentMatchesMode ? process.env.CASHFREE_SECRET_KEY : "") || "",
  ).trim();

  if (!clientId || !clientSecret) {
    throw new Error(`Cashfree ${selectedMode} credentials are not configured`);
  }

  return { clientId, clientSecret, mode: selectedMode };
};

const getCashfreeBaseUrl = (mode) =>
  mode === "test" ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg";

const getCashfreeHeaders = (credentials, idempotencyKey) => ({
  "x-api-version": CASHFREE_API_VERSION,
  "x-client-id": credentials.clientId,
  "x-client-secret": credentials.clientSecret,
  ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
  "x-request-id": crypto.randomUUID(),
  "Content-Type": "application/json",
  Accept: "application/json",
});

const createCashfreeOrder = async (credentials, orderPayload, idempotencyKey) => {
  const response = await axios.post(
    `${getCashfreeBaseUrl(credentials.mode)}/orders`,
    orderPayload,
    { headers: getCashfreeHeaders(credentials, idempotencyKey), timeout: 20000 },
  );
  return response.data;
};

const fetchCashfreeOrder = async (credentials, orderId) => {
  const response = await axios.get(
    `${getCashfreeBaseUrl(credentials.mode)}/orders/${encodeURIComponent(orderId)}`,
    { headers: getCashfreeHeaders(credentials), timeout: 15000 },
  );
  return response.data;
};

const createCashfreeVendor = async (credentials, vendorPayload, idempotencyKey) => {
  const response = await axios.post(
    `${getCashfreeBaseUrl(credentials.mode)}/easy-split/vendors`,
    vendorPayload,
    { headers: getCashfreeHeaders(credentials, idempotencyKey), timeout: 20000 },
  );
  return response.data;
};

const updateCashfreeVendor = async (credentials, vendorId, vendorPayload, idempotencyKey) => {
  const response = await axios.patch(
    `${getCashfreeBaseUrl(credentials.mode)}/easy-split/vendors/${encodeURIComponent(vendorId)}`,
    vendorPayload,
    { headers: getCashfreeHeaders(credentials, idempotencyKey), timeout: 20000 },
  );
  return response.data;
};

const fetchCashfreeVendor = async (credentials, vendorId) => {
  const response = await axios.get(
    `${getCashfreeBaseUrl(credentials.mode)}/easy-split/vendors/${encodeURIComponent(vendorId)}`,
    { headers: getCashfreeHeaders(credentials), timeout: 15000 },
  );
  return response.data;
};

const fetchCashfreeSplitDetails = async (credentials, orderId) => {
  const response = await axios.get(
    `${getCashfreeBaseUrl(credentials.mode)}/easy-split/orders/${encodeURIComponent(orderId)}`,
    { headers: getCashfreeHeaders(credentials), timeout: 15000 },
  );
  return response.data;
};

const createCashfreeRefund = async (credentials, orderId, refundPayload, idempotencyKey) => {
  const response = await axios.post(
    `${getCashfreeBaseUrl(credentials.mode)}/orders/${encodeURIComponent(orderId)}/refunds`,
    refundPayload,
    { headers: getCashfreeHeaders(credentials, idempotencyKey), timeout: 20000 },
  );
  return response.data;
};

const createCashfreeOnDemandTransfer = async (credentials, vendorId, transferPayload, idempotencyKey) => {
  const response = await axios.post(
    `${getCashfreeBaseUrl(credentials.mode)}/easy-split/vendors/${encodeURIComponent(vendorId)}/transfer`,
    transferPayload,
    { headers: getCashfreeHeaders(credentials, idempotencyKey), timeout: 20000 },
  );
  return response.data;
};

const fetchCashfreeVendorReconciliation = async (credentials, payload) => {
  const response = await axios.post(
    `${getCashfreeBaseUrl(credentials.mode)}/recon/vendor`,
    payload,
    { headers: getCashfreeHeaders(credentials), timeout: 30000 },
  );
  return response.data;
};

const stableIdempotencyKey = (value) => {
  const bytes = crypto.createHash("sha1").update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const isCashfreeOrderPaid = (order, expectedAmount) => {
  const paidAmount = Number(order?.order_amount);
  const amountMatches =
    Number.isFinite(paidAmount) &&
    Math.round(paidAmount * 100) === Math.round(Number(expectedAmount) * 100);

  return (
    String(order?.order_status || "").toUpperCase() === "PAID" &&
    String(order?.order_currency || "").toUpperCase() === "INR" &&
    amountMatches
  );
};

const verifyCashfreeWebhookSignature = ({ rawBody, timestamp, signature, secret }) => {
  if (!rawBody || !timestamp || !signature || !secret) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(String(timestamp)), body]))
    .digest();

  const provided = Buffer.from(String(signature), "base64");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};

const normalizeCashfreePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.length > 10 ? `+${digits}` : digits;
};

module.exports = {
  CASHFREE_API_VERSION,
  createCashfreeOnDemandTransfer,
  createCashfreeRefund,
  createCashfreeOrder,
  createCashfreeVendor,
  fetchCashfreeSplitDetails,
  fetchCashfreeOrder,
  fetchCashfreeVendor,
  fetchCashfreeVendorReconciliation,
  getCashfreeBaseUrl,
  getCashfreeCredentials,
  isCashfreeOrderPaid,
  normalizeCashfreePhone,
  stableIdempotencyKey,
  updateCashfreeVendor,
  verifyCashfreeWebhookSignature,
};
