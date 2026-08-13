const Counter = require("../modals/counter");

async function getNextOrderId(increment = true, session = null) {
  if (increment) {
    const counter = await Counter.findOneAndUpdate(
      { _id: "orderId" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, session },
    );
    return `OID${counter.seq.toString().padStart(3, "0")}`;
  } else {
    const counter = await Counter.findById("orderId");
    const seq = counter ? counter.seq + 1 : 1;
    return `OID${seq.toString().padStart(3, "0")}`;
  }
}

async function FeeInvoiceId(increment = true, session = null) {
  if (increment) {
    const counter = await Counter.findOneAndUpdate(
      { _id: "feeInvoiceId" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, session },
    );
    return `${counter.seq}`;
  } else {
    const counter = await Counter.findById("feeInvoiceId");
    const seq = counter ? counter.seq + 1 : 1;
    // return `FIV${seq}`;
    return `${seq}`;
  }
}

async function requestId(increment = true, session = null) {
  if (increment) {
    const counter = await Counter.findOneAndUpdate(
      { _id: "requestId" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, session },
    );
    return `REQ${counter.seq.toString().padStart(3, "0")}`;
  } else {
    const counter = await Counter.findById("feeInvoiceId");
    const seq = counter ? counter.seq + 1 : 1;
    return `REQ${seq.toString().padStart(3, "0")}`;
  }
}

async function getNextDriverId(increment = true, session = null) {
  if (increment) {
    const counter = await Counter.findOneAndUpdate(
      { _id: "driverId" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, session },
    );
    return `FV${counter.seq.toString().padStart(3, "0")}`;
  } else {
    const counter = await Counter.findById("orderId");
    const seq = counter ? counter.seq + 1 : 1;
    return `FV${seq.toString().padStart(3, "0")}`;
  }
}

async function generateSKU(session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "product_sku" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `FIV${String(counter.seq).padStart(3, "0")}`;
}

async function getNextCategoryId(increment = true, session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "categoryId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `CAT${String(counter.seq).padStart(2, "0")}`;
}

async function getNextSubCategoryId(increment = true, session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "subCategoryId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `SUB${String(counter.seq).padStart(2, "0")}`;
}

async function getNextSubbCategoryId(increment = true, session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "subSubCategoryId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `SUBB${String(counter.seq).padStart(2, "0")}`;
}

async function getNextBrandId(increment = true, session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "brandId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `BRD${String(counter.seq).padStart(2, "0")}`;
}

async function getNextAttributeId(increment = true, session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "attributeId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `ATR${String(counter.seq).padStart(2, "0")}`;
}

async function getNextVariantId(increment = true, session = null) {
  const counter = await Counter.findOneAndUpdate(
    { _id: "variantId" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );

  return `VAR${String(counter.seq).padStart(2, "0")}`;
}

module.exports = {
  getNextOrderId,
  FeeInvoiceId,
  requestId,
  getNextDriverId,
  generateSKU,
  getNextCategoryId,
  getNextSubCategoryId,
  getNextSubbCategoryId,
  getNextBrandId,
  getNextAttributeId,
  getNextVariantId,
};
