const CLOSED_ORDER_STATUSES = new Set([
  "cancelled",
  "delivered",
  "completed",
  "rejected",
]);

const isRecoverableOrder = (order) =>
  Boolean(
    order &&
      !CLOSED_ORDER_STATUSES.has(
        String(order.orderStatus || "").trim().toLowerCase(),
      ) &&
      !order.driver?.driverId,
  );

async function recoverPendingDriverOffers({
  driverId,
  getPendingOffers,
  findOrderByOrderId,
  removePendingOffer,
  recreateDispatch,
  isSocketConnected = () => true,
  isHandlerReady = () => false,
  isOfferStillEligible = async () => true,
}) {
  if (!driverId) return [];

  const pendingOffers = await getPendingOffers(driverId);
  const recoveredOffers = [];

  for (const offer of pendingOffers) {
    const orderId = offer?.orderId || offer?.order?.orderId;
    const order = orderId ? await findOrderByOrderId(orderId) : null;

    if (!isRecoverableOrder(order)) {
      await removePendingOffer(driverId, orderId);
      continue;
    }

    if (!(await isOfferStillEligible({ driverId, orderId, order }))) {
      await removePendingOffer(driverId, orderId);
      continue;
    }

    if (!isSocketConnected()) break;

    // Wait until the active socket has Accept/Reject handlers before the
    // recovered payload is returned to Flutter. Existing handlers make this
    // handshake idempotent and avoid incrementing dispatch retries on every
    // heartbeat/app-resume registration.
    if (!isHandlerReady(orderId)) {
      await recreateDispatch(order._id);
    }

    const latestOrder = await findOrderByOrderId(orderId);
    if (
      !isRecoverableOrder(latestOrder) ||
      !(await isOfferStillEligible({
        driverId,
        orderId,
        order: latestOrder,
      }))
    ) {
      await removePendingOffer(driverId, orderId);
      continue;
    }

    recoveredOffers.push(offer);
  }

  return recoveredOffers;
}

module.exports = {
  isRecoverableOrder,
  recoverPendingDriverOffers,
};
