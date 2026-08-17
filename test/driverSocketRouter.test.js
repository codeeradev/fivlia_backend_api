const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDriverSocketRouter,
  setDriverSocketRouterModelProviderForTests,
} = require("../socket/driverSocketRouter");

class FakeSocket {
  constructor() {
    this.handlers = new Map();
  }
  on(event, handler) {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  once(event, handler) {
    this.on(event, handler);
  }
  off(event, handler) {
    const handlers = this.handlers.get(event) || [];
    this.handlers.set(
      event,
      handlers.filter((candidate) => candidate !== handler),
    );
  }
  listenerCount(event) {
    return (this.handlers.get(event) || []).length;
  }
  async receive(event, ...args) {
    const results = (this.handlers.get(event) || []).map((handler) =>
      handler(...args),
    );
    await Promise.all(results);
  }
}

const query = (value) => ({
  select() {
    return this;
  },
  async lean() {
    return value;
  },
});

test.afterEach(() => {
  setDriverSocketRouterModelProviderForTests();
});

test("registers one accept/reject listener and cleans both", () => {
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  assert.equal(socket.listenerCount("acceptOrder"), 1);
  assert.equal(socket.listenerCount("rejectOrder"), 1);
  router.destroy();
  assert.equal(socket.listenerCount("acceptOrder"), 0);
  assert.equal(socket.listenerCount("rejectOrder"), 0);
});

test("logout clears pending handlers without duplicating socket listeners", () => {
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  router.register("O-1", { accept: async () => {} });
  assert.equal(router.has("O-1"), true);
  router.clear();
  assert.equal(router.has("O-1"), false);
  assert.equal(socket.listenerCount("acceptOrder"), 1);
  assert.equal(socket.listenerCount("rejectOrder"), 1);
  router.destroy();
});

test("routes registered accept exactly once", async () => {
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  let calls = 0;
  router.register("O-1", {
    accept: async (_, ack) => {
      calls += 1;
      ack({ status: true, success: true, orderId: "O-1" });
    },
  });
  let response;
  await socket.receive(
    "acceptOrder",
    { orderId: "O-1", driverId: "D-1" },
    (ack) => (response = ack),
  );
  assert.equal(calls, 1);
  assert.equal(response.success, true);
  router.destroy();
});

test("routes registered reject with an ACK exactly once", async () => {
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  let calls = 0;
  router.register("O-1", {
    reject: async (_, ack) => {
      calls += 1;
      ack({
        status: true,
        success: true,
        reason: "REJECTED",
        orderId: "O-1",
      });
    },
  });
  let response;
  await socket.receive(
    "rejectOrder",
    { orderId: "O-1", driverId: "D-1" },
    (ack) => (response = ack),
  );
  assert.equal(calls, 1);
  assert.equal(response.reason, "REJECTED");
  router.destroy();
});

test("lost accept ACK recovers as idempotent success", async () => {
  setDriverSocketRouterModelProviderForTests(() => ({
    Order: {
      findOne: () =>
        query({
          orderStatus: "Going to Pickup",
          driver: { driverId: "D-1" },
        }),
    },
    Assign: { findOne: () => query(null) },
  }));
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  let response;
  await socket.receive(
    "acceptOrder",
    { orderId: "O-1", driverId: "D-1" },
    (ack) => (response = ack),
  );
  assert.equal(response.success, true);
  assert.equal(response.reason, "ALREADY_ACCEPTED_BY_DRIVER");
  router.destroy();
});

test("a second driver cannot recover another driver's order", async () => {
  setDriverSocketRouterModelProviderForTests(() => ({
    Order: {
      findOne: () =>
        query({
          orderStatus: "Going to Pickup",
          driver: { driverId: "D-1" },
        }),
    },
    Assign: { findOne: () => query(null) },
  }));
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  let response;
  await socket.receive(
    "acceptOrder",
    { orderId: "O-1", driverId: "D-2" },
    (ack) => (response = ack),
  );
  assert.equal(response.success, false);
  assert.equal(response.reason, "ALREADY_ACCEPTED");
  router.destroy();
});

test("duplicate reject recovers as idempotent success", async () => {
  setDriverSocketRouterModelProviderForTests(() => ({
    Order: { findOne: () => query(null) },
    Assign: { findOne: () => query({ _id: "assignment" }) },
  }));
  const socket = new FakeSocket();
  const router = getDriverSocketRouter(socket);
  let response;
  await socket.receive(
    "rejectOrder",
    { orderId: "O-1", driverId: "D-1" },
    (ack) => (response = ack),
  );
  assert.equal(response.success, true);
  assert.equal(response.reason, "ALREADY_REJECTED");
  router.destroy();
});
