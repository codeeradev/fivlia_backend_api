let createClient;

try {
  ({ createClient } = require("redis"));
} catch (err) {
  if (process.env.REDIS_URL) {
    console.warn("Redis package is not installed. Redis cache is disabled.");
  }
}

let client;
let connectPromise;

const getRedisClient = async () => {
  if (!createClient || !process.env.REDIS_URL) return null;

  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => {
      console.error("Redis client error:", err.message);
    });
  }

  if (client.isOpen) return client;

  if (!connectPromise) {
    connectPromise = client
      .connect()
      .catch((err) => {
        console.error("Redis connection failed:", err.message);
        return null;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  await connectPromise;
  return client.isOpen ? client : null;
};

module.exports = { getRedisClient };
