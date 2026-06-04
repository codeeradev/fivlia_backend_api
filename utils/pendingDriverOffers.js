const { getRedisClient } = require("./redisClient");

const inMemoryOffers = new Map();
const DEFAULT_TTL_SECONDS = Number(process.env.DRIVER_PENDING_OFFER_TTL_SECONDS || 180);

const getDriverOfferKey = (driverId) => `driver:${driverId}:pendingOffers`;

const getNow = () => Date.now();

const pruneMemoryOffers = (driverId) => {
  const driverOffers = inMemoryOffers.get(driverId);
  if (!driverOffers) return;

  const now = getNow();
  for (const [orderId, entry] of driverOffers.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      driverOffers.delete(orderId);
    }
  }

  if (driverOffers.size === 0) {
    inMemoryOffers.delete(driverId);
  }
};

const setInMemoryOffer = (driverId, orderId, payload, ttlSeconds) => {
  const expiresAt = getNow() + ttlSeconds * 1000;
  const driverOffers = inMemoryOffers.get(driverId) || new Map();
  driverOffers.set(orderId, { payload, expiresAt });
  inMemoryOffers.set(driverId, driverOffers);
};

const removeInMemoryOffer = (driverId, orderId) => {
  const driverOffers = inMemoryOffers.get(driverId);
  if (!driverOffers) return;
  driverOffers.delete(orderId);
  if (driverOffers.size === 0) {
    inMemoryOffers.delete(driverId);
  }
};

const getInMemoryOffers = (driverId) => {
  pruneMemoryOffers(driverId);
  const driverOffers = inMemoryOffers.get(driverId);
  if (!driverOffers) return [];
  return Array.from(driverOffers.values()).map((entry) => entry.payload);
};

async function upsertPendingDriverOffer(driverId, orderId, payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const safeDriverId = String(driverId || "");
  const safeOrderId = String(orderId || "");
  if (!safeDriverId || !safeOrderId || !payload) return;

  const redis = await getRedisClient();
  if (!redis) {
    setInMemoryOffer(safeDriverId, safeOrderId, payload, ttlSeconds);
    return;
  }

  try {
    const key = getDriverOfferKey(safeDriverId);
    await redis.hSet(key, safeOrderId, JSON.stringify(payload));
    await redis.expire(key, ttlSeconds);
  } catch (err) {
    console.warn("Failed to cache pending driver offer:", err.message);
    setInMemoryOffer(safeDriverId, safeOrderId, payload, ttlSeconds);
  }
}

async function removePendingDriverOffer(driverId, orderId) {
  const safeDriverId = String(driverId || "");
  const safeOrderId = String(orderId || "");
  if (!safeDriverId || !safeOrderId) return;

  const redis = await getRedisClient();
  if (!redis) {
    removeInMemoryOffer(safeDriverId, safeOrderId);
    return;
  }

  try {
    const key = getDriverOfferKey(safeDriverId);
    await redis.hDel(key, safeOrderId);
  } catch (err) {
    console.warn("Failed to remove pending driver offer:", err.message);
    removeInMemoryOffer(safeDriverId, safeOrderId);
  }
}

async function getPendingDriverOffers(driverId) {
  const safeDriverId = String(driverId || "");
  if (!safeDriverId) return [];

  const redis = await getRedisClient();
  if (!redis) {
    return getInMemoryOffers(safeDriverId);
  }

  try {
    const key = getDriverOfferKey(safeDriverId);
    const raw = await redis.hGetAll(key);
    return Object.values(raw || {})
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn("Failed to read pending driver offers:", err.message);
    return getInMemoryOffers(safeDriverId);
  }
}

module.exports = {
  upsertPendingDriverOffer,
  removePendingDriverOffer,
  getPendingDriverOffers,
};
