// The four customer / admin facing order stages.
// Internal orderStatus values (used by the driver app, settlement, dispatch)
// are NOT changed; they are only grouped into a stage for display.
//
//   Pending       -> order placed, not yet accepted
//   In Processing -> accepted / being prepared / driver assigned / ready
//   Shipped       -> global: handed to a third party courier (tracking id)
//                    local : driver picked up and is on the way
//   Delivered     -> delivered
// Cancelled / Rejected are terminal and returned as-is.

const STAGES = ["Pending", "In Processing", "Shipped", "Delivered"];

const clean = (s) => String(s || "").trim().toLowerCase();

const PROCESSING = new Set([
  "accepted",
  "in processing",
  "inprocessing",
  "processing",
  "ready",
  "ready to pickup",
  "going to pickup",
  "picked up",
]);

const SHIPPED = new Set(["shipped", "on the way", "on way", "out for delivery"]);

const getOrderStage = (orderStatus) => {
  const s = clean(orderStatus);
  if (!s || s === "pending") return "Pending";
  if (s === "delivered") return "Delivered";
  if (SHIPPED.has(s)) return "Shipped";
  if (PROCESSING.has(s)) return "In Processing";
  if (s === "cancelled" || s === "canceled" || s === "rejected") {
    return "Cancelled";
  }
  // unknown custom status: keep as is so nothing is hidden
  return String(orderStatus);
};

// Internal status written to the DB when an admin / seller picks a stage.
//   scope: "global" | "city"
const stageToInternalStatus = (stage, scope) => {
  const s = clean(stage);
  if (s === "pending") return "Pending";
  if (s === "in processing" || s === "inprocessing") return "Accepted";
  if (s === "delivered") return "Delivered";
  if (s === "shipped") return scope === "global" ? "Shipped" : "On The Way";
  return null;
};

module.exports = { STAGES, getOrderStage, stageToInternalStatus };
