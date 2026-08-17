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

  // Always mirror Redis state in process memory. If Redis drops after a
  // successful write, recovery must not suddenly return an empty offer list.
  setInMemoryOffer(safeDriverId, safeOrderId, payload, ttlSeconds);

  const redis = await getRedisClient();
  if (!redis) return;

  try {
    const key = getDriverOfferKey(safeDriverId);
    await redis.hSet(key, safeOrderId, JSON.stringify(payload));
    await redis.expire(key, ttlSeconds);
  } catch (err) {
    console.warn("Failed to cache pending driver offer:", err.message);
  }
}

async function removePendingDriverOffer(driverId, orderId) {
  const safeDriverId = String(driverId || "");
  const safeOrderId = String(orderId || "");
  if (!safeDriverId || !safeOrderId) return;

  removeInMemoryOffer(safeDriverId, safeOrderId);

  const redis = await getRedisClient();
  if (!redis) return;

  try {
    const key = getDriverOfferKey(safeDriverId);
    await redis.hDel(key, safeOrderId);
  } catch (err) {
    console.warn("Failed to remove pending driver offer:", err.message);
  }
}

async function getPendingDriverOffers(driverId) {
  const safeDriverId = String(driverId || "");
  if (!safeDriverId) return [];

  const memoryOffers = getInMemoryOffers(safeDriverId);

  const redis = await getRedisClient();
  if (!redis) return memoryOffers;

  try {
    const key = getDriverOfferKey(safeDriverId);
    const raw = await redis.hGetAll(key);
    const redisOffers = Object.values(raw || {})
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Redis is authoritative across processes, while memory protects this
    // process during an outage. Merge by order id so reconnects stay stable.
    const merged = new Map();
    for (const offer of [...memoryOffers, ...redisOffers]) {
      const orderId = String(offer?.orderId || offer?.order?.orderId || "");
      if (orderId) merged.set(orderId, offer);
    }
    return Array.from(merged.values());
  } catch (err) {
    console.warn("Failed to read pending driver offers:", err.message);
    return memoryOffers;
  }
}

module.exports = {
  upsertPendingDriverOffer,
  removePendingDriverOffer,
  getPendingDriverOffers,
};
