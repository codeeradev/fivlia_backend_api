const { PutObjectCommand } = require("@aws-sdk/client-s3");
const PDFDocument = require("pdfkit");
const path = require("path");
const s3 = require("./aws"); // AWS S3 setup
const { v4: uuidv4 } = require("uuid");
const { SettingAdmin } = require("../modals/setting");
const Store = require("../modals/store");
const { Order } = require("../modals/order");
const { shortenUrl } = require("../utils/shortUrl");
const User = require("../modals/User");
const Product = require("../modals/Product"); // Add this line
const request = require("request"); // for msggo.in
const { FeeInvoiceId } = require("./counter");
const moment = require("moment");
const { sendMessages } = require("../utils/sendMessages");

// Generate PDF Thermal Invoice and upload to AWS
exports.generateThermalInvoice = async (orderId) => {
  try {
    const order = await Order.findOne({ orderId })
      .populate("addressId")
      .populate("items.productId");
    if (!order) throw new Error("Order not found");

    const user = order.addressId;
    const store = await require("../modals/store").findById(order.storeId);

    // Calculate totals
    const subtotal = order.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const gstTotal = order.items.reduce((sum, item) => {
      const gstRate = parseFloat(item.gst || 0);
      return sum + (item.price * item.quantity * gstRate) / 100;
    }, 0);

    // Generate PDF invoice
    const pdfBuffer = await generatePDFInvoice(
      order,
      user,
      store,
      subtotal,
      gstTotal,
      { dType: "admin" },
    );

    // Upload to AWS S3
    const fileName = `thermal-invoices/thermal_invoice_${orderId}_${uuidv4()}.pdf`;
    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName,
      Body: pdfBuffer,
      ContentType: "application/pdf",
    };

    await s3.send(new PutObjectCommand(uploadParams));

    // Generate the URL
    const pdfUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

    const shortUrl = await shortenUrl(pdfUrl);

    // Save PDF URL to database
    await Order.findOneAndUpdate(
      { orderId },
      { $set: { thermalInvoice: pdfUrl } },
    );

    console.log(
      "Thermal invoice PDF generated and uploaded for order:",
      orderId,
    );
    return shortUrl;
  } catch (err) {
    console.error("Thermal invoice generation error:", err);
    throw err;
  }
};

exports.generateStoreInvoiceId = async (storeId) => {
  const store = await Store.findById(storeId);
  if (!store) throw new Error("Store not found");

  let prefix = "";
  if (store.Authorized_Store) {
    // field from store document
    return await FeeInvoiceId(true);
  } else {
    prefix = store.invoicePrefix;
  }

  // Find the last order for this store
  const lastOrder = await Order.find({ storeId })
    .sort({ createdAt: -1 })
    .limit(1);

  let lastNumber = 0;
  if (lastOrder.length > 0 && lastOrder[0].storeInvoiceId) {
    const match = lastOrder[0].storeInvoiceId.match(/\d+$/);
    if (match) lastNumber = parseInt(match[0]);
  }

  const newNumber = lastNumber + 1;
  // Pad with leading zeros, e.g., 001, 002, ...
  // const numberPadded = String(newNumber).padStart(3, "0");

  // Pad without leading zeros, e.g., 1, 2, ...
  const numberPadded = String(newNumber);

  return `${prefix}${numberPadded}`;
};

// Generate PDF invoice
async function generatePDFInvoice(
  order,
  user,
  store,
  subtotal,
  gstTotal,
  { dType = "admin" },
) {
  const setting = await SettingAdmin.find().lean();

  // Fetch signature image buffer from AWS URL
  let signatureBuffer;
  let adminSignatreBuffer;
  if (store.sellerSignature) {
    const signatureUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com${store.sellerSignature}`;
    try {
      const signatureResponse = await fetch(signatureUrl);
      if (!signatureResponse.ok) {
        throw new Error(
          `Failed to fetch signature image: ${signatureResponse.statusText}`,
        );
      }
      signatureBuffer = await signatureResponse.arrayBuffer();
    } catch (error) {
      //console.error("Error fetching signature image:", error);
      signatureBuffer = null;
    }
  }

  if (setting[0]?.adminSignature) {
    const signatureUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com${setting[0]?.adminSignature}`;
    try {
      const signatureResponse = await fetch(signatureUrl);
      if (!signatureResponse.ok) {
        throw new Error(
          `Failed to fetch signature image: ${signatureResponse.statusText}`,
        );
      }
      adminSignatreBuffer = await signatureResponse.arrayBuffer();
    } catch (error) {
      //console.error("Error fetching signature image:", error);
      adminSignatreBuffer = null;
    }
  }

  return new Promise((resolve, reject) => {
    try {
      let itemsTotal = 0;
      const doc = new PDFDocument({
        size: [226, 800],
        margins: {
          top: 20,
          bottom: 20,
          left: 10,
          right: 10,
        },
      });

      let buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // Function to create the common header for both invoices
      const createHeader = (headerText) => {
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .text(headerText, { align: "center" });
      };

      const createStoreAndCustomerInfo = (isSecondInvoice) => {
        doc.fontSize(8).font("Helvetica");
        if (isSecondInvoice) {
          doc.text(`Service Provider: ${setting[0]?.Owner_Name || "FIVLIA"}`);
        } else {
          doc.text(`Sold By: ${store.storeName || "FIVLIA"}`);
        }
        if (isSecondInvoice) {
          doc.text(`Invoice Id: ${order.feeInvoiceId}`);
        } else {
          doc.text(`Invoice Id: ${order.storeInvoiceId}`);
        }
        if (isSecondInvoice || store.Authorized_Store === true) {
          doc.text(`GST ID: ${setting[0]?.GST_Number || "N/A"}`);
        } else {
          if (store.gstNumber && store.gstNumber.trim() !== "") {
            // GST Registered Seller
            doc.text(`GST ID: ${store.gstNumber}`);
          } else {
            // Non-GST Seller
            doc.text(`Enrollment ID: ${store.enrollmentId || "N/A"}`);
            doc.text(`FSSAI ID: ${store.fsiNumber || "N/A"}`);
          }
        }
        if (isSecondInvoice) {
          doc.text(`Phone: ${setting[0]?.Owner_Number || "+91-XXXXXXXXXX"}`);
        } else {
          doc.text(`Phone: ${store.PhoneNumber || "+91-XXXXXXXXXX"}`);
        }
        if (!isSecondInvoice) {
          doc.text(`Address: ${store.fullAddress || store.city.name || "N/A"}`);
        }
        doc.text(`Date: ${moment(order.createdAt).format("DD MMM, YYYY")}`);
        doc.text(`Time: ${moment(order.createdAt).format("hh:mm:ss A")}`);
        doc.text(`Order ID: ${order.orderId}`);
        doc.moveDown(0.5);

        // Line separator
        doc.moveTo(10, doc.y).lineTo(216, doc.y).stroke();
        doc.moveDown(0.5);

        // Customer Info
        doc.fontSize(9).font("Helvetica-Bold").text("CUSTOMER DETAILS:");
        doc.fontSize(8).font("Helvetica");
        doc.text(`Name: ${user.fullName || "N/A"}`);
        doc.text(
          `Mobile: ${user.mobileNumber || user.alternateNumber || "N/A"}`,
        );
        doc.text(`Email: ${user.email || "N/A"}`);
        doc.text(`Address: ${user.address || "N/A"}`);
        doc.moveDown(0.5);

        // Line separator
        doc.moveTo(10, doc.y).lineTo(216, doc.y).stroke();
        doc.moveDown(0.5);
      };

      // Create the first invoice: Items + details
      const createItemsInvoice = (signatureBuffer, adminSignatreBuffer) => {
        createHeader("BILLING INVOICE");
        doc.moveDown(0.7);
        createStoreAndCustomerInfo(false);
        doc.fontSize(9).font("Helvetica-Bold").text("ITEMS:");
        doc.moveDown(0.3);
        doc.fontSize(6).font("Helvetica");

        // Define column positions for thermal printer (226pt width)
        const tableLeft = 10;
        const tableRight = 216;
        const columns = {
          name: { x: tableLeft, width: 50 },
          qty: { x: tableLeft + 52, width: 20 },
          gst: { x: tableLeft + 74, width: 32 },
          igst: { x: tableLeft + 108, width: 32 },
          price: { x: tableLeft + 142, width: 40 },
        };

        const tableTop = doc.y;

        // Draw table header
        doc.font("Helvetica-Bold").fontSize(8);
        doc.text("Name", columns.name.x, tableTop, {
          width: columns.name.width,
          align: "left",
          continued: false,
        });
        doc.text("Qty", columns.qty.x, tableTop, {
          width: columns.qty.width,
          align: "center",
          continued: false,
        });
        doc.text("Tax(%)", columns.gst.x, tableTop, {
          width: columns.gst.width,
          align: "center",
          continued: false,
        });
        doc.text("IGST", columns.igst.x, tableTop, {
          width: columns.igst.width,
          align: "right",
          continued: false,
        });
        doc.text("Price", columns.price.x, tableTop, {
          width: columns.price.width,
          align: "right",
          continued: false,
        });

        doc.moveDown(0.4);

        // Line separator
        const lineY = doc.y;
        doc.moveTo(tableLeft, lineY).lineTo(tableRight, lineY).stroke();
        doc.moveDown(0.2);

        // Initialize totals
        let itemsTotalGst = 0;

        doc.font("Helvetica").fontSize(7);

        // Items
        order.items.forEach((item) => {
          const itemName = item.name || "Product";
          const quantity = item.quantity;
          const gstPercent = parseFloat(item.gst) || 0.0;

          // Calculate prices (assuming item.price includes GST)
          const priceWithGst = item.price;
          const basePrice = priceWithGst / (1 + gstPercent / 100);
          const gstPerUnit = priceWithGst - basePrice;
          const totalGstAmount = gstPerUnit * quantity;
          const totalPrice = priceWithGst * quantity;

          itemsTotal += totalPrice;
          itemsTotalGst += totalGstAmount;

          const rowY = doc.y;

          // Name (with wrapping if needed, truncate very long names)
          const truncatedName =
            itemName.length > 50 ? itemName.substring(0, 47) + "..." : itemName;
          doc.text(truncatedName, columns.name.x, rowY, {
            width: columns.name.width,
            align: "left",
            lineBreak: true,
            continued: false,
          });

          // Calculate name height for row spacing
          const nameHeight = doc.heightOfString(truncatedName, {
            width: columns.name.width,
          });

          // Qty (centered, aligned to first line of name)
          doc.text(quantity.toString(), columns.qty.x, rowY, {
            width: columns.qty.width,
            align: "center",
            lineBreak: false,
            continued: false,
          });

          // GST% (centered, aligned to first line)
          doc.text(`${gstPercent}%`, columns.gst.x, rowY, {
            width: columns.gst.width,
            align: "center",
            lineBreak: false,
            continued: false,
          });

          // IGST (right aligned, aligned to first line)
          doc.text(totalGstAmount.toFixed(2), columns.igst.x, rowY, {
            width: columns.igst.width,
            align: "right",
            lineBreak: false,
            continued: false,
          });

          // Price (right aligned, aligned to first line)
          doc.text(totalPrice.toFixed(2), columns.price.x, rowY, {
            width: columns.price.width,
            align: "right",
            lineBreak: false,
            continued: false,
          });

          // Move down based on name height plus small spacing
          doc.y = rowY + nameHeight + 2;
        });

        doc.moveDown(0.1);

        // Line separator
        const bottomLineY = doc.y;
        doc
          .moveTo(tableLeft, bottomLineY)
          .lineTo(tableRight, bottomLineY)
          .stroke();
        doc.moveDown(0.5);

        // Total GST - label on left, value on right
        doc.fontSize(8);
        const gstY = doc.y;
        doc.text("Tax (included):", tableLeft, gstY, {
          width: 80,
          align: "left",
          continued: false,
        });
        doc.text(itemsTotalGst.toFixed(2), tableLeft + 80, gstY, {
          width: tableRight - tableLeft - 80,
          align: "left",
          continued: false,
        });

        doc.moveDown(0.3);

        // Total - label on left, value on right
        doc.font("Helvetica-Bold").fontSize(9);
        const totalY = doc.y;
        doc.text("TOTAL:", tableLeft, totalY, {
          width: 80,
          align: "left",
          continued: false,
        });
        doc.text(itemsTotal.toFixed(2), tableLeft + 80, totalY, {
          width: tableRight - tableLeft - 80,
          align: "left",
          continued: false,
        });

        doc.moveDown(0.8);

        // 1. Show seller-side settlement cuts separately so the new 5% food-seller tax is visible on seller invoice.
        const totalCommission = order.items.reduce((sum, item) => {
          const itemTotal = item.price * item.quantity;
          const commissionAmount = ((item.commision || 0) / 100) * itemTotal;
          return sum + commissionAmount;
        }, 0);
        const foodSellerTaxPercent = Number(order.foodSellerTaxPercent || 0);
        const foodSellerTaxAmount = Number(order.foodSellerTaxAmount || 0);
        const netSellerAmount = Math.max(
          itemsTotal - totalCommission - foodSellerTaxAmount,
          0,
        );

        // 2. Keep settlement details visible only on seller invoice so customer/admin invoice layout stays unchanged.
        if (
          dType === "seller" &&
          !store.Authorized_Store &&
          (totalCommission > 0 || foodSellerTaxAmount > 0)
        ) {
          doc.moveTo(tableLeft, doc.y).lineTo(tableRight, doc.y).stroke();
          doc.moveDown(0.4);
          doc.font("Helvetica-Bold").fontSize(9).text("SELLER SETTLEMENT:");
          doc.moveDown(0.3);
          doc.font("Helvetica").fontSize(8);

          const commissionY = doc.y;
          doc.text("Commission Deduction:", tableLeft, commissionY, {
            width: 120,
            align: "left",
          });
          doc.text(totalCommission.toFixed(2), tableLeft + 120, commissionY, {
            width: tableRight - tableLeft - 120,
            align: "left",
          });

          if (foodSellerTaxAmount > 0) {
            const foodTaxY = doc.y;
            doc.text(
              `Food Seller Tax (${foodSellerTaxPercent}%):`,
              tableLeft,
              foodTaxY,
              {
                width: 120,
                align: "left",
              },
            );
            doc.text(
              foodSellerTaxAmount.toFixed(2),
              tableLeft + 120,
              foodTaxY,
              {
                width: tableRight - tableLeft - 120,
                align: "left",
              },
            );
          }

          doc.moveDown(0.3);
          const netSellerY = doc.y;
          doc.font("Helvetica-Bold").fontSize(9);
          doc.text("Net Amount To Seller:", tableLeft, netSellerY, {
            width: 120,
            align: "left",
          });
          doc.text(netSellerAmount.toFixed(2), tableLeft + 120, netSellerY, {
            width: tableRight - tableLeft - 120,
            align: "left",
          });
          doc.moveDown(0.8);
        }

        // Signature image (if available)
        if (store.Authorized_Store === true && adminSignatreBuffer) {
          doc.fontSize(7).text("Seller Authorized Signature", {
            align: "right",
          });
          doc.image(adminSignatreBuffer, doc.page.width - 110, doc.y, {
            fit: [100, 50],
            align: "right",
          });
          doc.moveDown();
          doc.y += 30;
        } else if (signatureBuffer) {
          doc.fontSize(7).text("Seller Authorized Signature", {
            align: "right",
          });
          doc.image(signatureBuffer, doc.page.width - 110, doc.y, {
            fit: [100, 50],
            align: "right",
          });
          doc.moveDown();
          doc.y += 30;
        }

        doc.moveDown(4);
        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text("DECLARATION", tableLeft, doc.y, {
            width: tableRight - tableLeft,
            align: "left",
          });
        doc.moveDown(0.3);

        // Declaration text - full width justified
        doc
          .fontSize(8)
          .font("Helvetica")
          .text("• Not for resale.", tableLeft, doc.y, {
            width: tableRight - tableLeft,
            align: "left",
            lineBreak: true,
          });

        doc.moveDown(0.3);

        doc
          .fontSize(8)
          .font("Helvetica")
          .text(
            "• Tax invoice issued on behalf of the seller. All tax liabilities are paid by the seller.",
            tableLeft,
            doc.y,
            {
              width: tableRight - tableLeft,
              align: "left",
            },
          );

        doc.moveDown(0.5);
      };

      // Create the second invoice: Delivery & Platform Fees
      const createFeesInvoice = (deliveryGstPer, adminSignatreBuffer) => {
        createHeader("FIVLIA INVOICE");
        doc.moveDown(0.7);
        createStoreAndCustomerInfo(true);
        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text("DELIVERY & PLATFORM FEES", { continued: true })
          .font("Helvetica")
          .fontSize(7)
          .text(` (GST : ${deliveryGstPer}% included)`);
        doc.moveDown(0.5);
        doc.fontSize(7).font("Helvetica");
        let platformTotal = 0;
        let deliveryTotal = 0;

        // Delivery Charges
        if (order.deliveryCharges > 0) {
          const deliveryLine =
            "Delivery Charges:".padEnd(30) +
            order.deliveryCharges.toFixed(2).padStart(12);
          doc.text(deliveryLine);
          deliveryTotal = order.deliveryCharges;
        }

        // Platform Fee
        if (order.platformFee > 0) {
          platformTotal = itemsTotal * (order.platformFee / 100);
          const platformLine =
            "Platform Fee:".padEnd(30) + platformTotal.toFixed(2).padStart(15);
          doc.text(platformLine);
        }

        // **Total GST** for Delivery & Platform Fees
        // Calculate base price (excluding GST) for deliveryTotal and platformTotal
        const deliveryBasePrice = deliveryTotal / (1 + deliveryGstPer / 100);
        const platformBasePrice = platformTotal / (1 + deliveryGstPer / 100);

        // Calculate GST amount for both delivery and platform (based on base price)
        const deliveryGst = (
          deliveryBasePrice *
          (deliveryGstPer / 100)
        ).toFixed(2);
        const platformGst = (
          platformBasePrice *
          (deliveryGstPer / 100)
        ).toFixed(2);

        // Sum the GST amounts for total IGST
        const feeigst = (
          parseFloat(deliveryGst) + parseFloat(platformGst)
        ).toFixed(2);

        const totalFeesGSTLine =
          "GST (included):".padEnd(29) + feeigst.padStart(14);
        doc.text(totalFeesGSTLine);
        doc.moveDown(0.3);
        // **Total** for Delivery & Platform Fees
        const totalFeesLine =
          "TOTAL FEES:".padEnd(26) +
          (deliveryTotal + platformTotal).toFixed(2).padStart(3);
        doc.fontSize(9).font("Helvetica-Bold").text(totalFeesLine);

        doc.moveDown(1.5);
        // Signature image (if available)
        if (adminSignatreBuffer) {
          doc.fontSize(7).text("FIVLIA Authorized Signature", {
            align: "right",
          });
          doc.image(adminSignatreBuffer, doc.page.width - 110, doc.y, {
            fit: [100, 50],
            align: "right",
          });
          doc.moveDown();
          doc.y += 50;
        }
      };

      // Footer for both invoices (same footer in both invoices)
      const footer = () => {
        doc.moveDown(1);
        doc.moveTo(10, doc.y).lineTo(216, doc.y).stroke();
        doc.moveDown(0.5);
        doc
          .fontSize(8)
          .font("Helvetica")
          .text("Thank you for shopping", { align: "center" });
        doc.text("with FIVLIA!", { align: "center" });
        doc.text("www.fivlia.com", { align: "center" });
        doc.moveDown(0.5);
        doc.moveTo(10, doc.y).lineTo(216, doc.y).stroke();
      };

      // Check dType and generate invoices accordingly
      if (dType === "admin") {
        // Admin generates both invoices
        createItemsInvoice(signatureBuffer, adminSignatreBuffer);
        footer();

        // Add page break to separate the two invoices
        doc.addPage();
        createFeesInvoice(
          setting[0]?.Delivery_Charges_Gst || 18,
          adminSignatreBuffer,
        );
        footer();
      } else if (dType === "seller") {
        // Seller generates only the first invoice
        createItemsInvoice(signatureBuffer);
        footer();
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Function to be called when order is delivered - simplified version
exports.generateAndSendThermalInvoice = async (orderId) => {
  try {
    // Generate PDF invoice and get URL
    let pdfUrl = await exports.generateThermalInvoice(orderId);

    if (pdfUrl.startsWith("http://")) {
      pdfUrl = pdfUrl.replace("http://", "");
    } else if (pdfUrl.startsWith("https://")) {
      pdfUrl = pdfUrl.replace("https://", "");
    }

    // Send WhatsApp notification with PDF link
    const order = await Order.findOne({ orderId }).populate("userId");
    const user = order.userId;

    const message = `Your Fivlia order ${orderId} has been delivered! Invoice: ${pdfUrl} Download Invoice: ${order.storeInvoiceId} Total Amount: ${order.totalPrice} Thank you for choosing Fivlia - Delivery in Minutes! Rate your experience on our app!`;

    const response = await sendMessages(
      user.mobileNumber,
      message,
      "1707176060687281700",
    );
    console.log(response, 34783487);
    return {
      success: true,
      message: "Thermal invoice PDF generated and sent via WhatsApp",
      pdfUrl: pdfUrl,
    };
  } catch (err) {
    console.error("Error in generateAndSendThermalInvoice:", err);
    throw err;
  }
};

exports.generatePDFBuffer = async (orderId, dType) => {
  const order = await Order.findOne({ orderId })
    .populate("addressId")
    .populate("items.productId")
    .lean();

  if (!order) throw new Error("Order not found");

  const user = order.addressId;
  const store = await require("../modals/store").findById(order.storeId).lean();

  const subtotal = order.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const gstTotal = order.items.reduce((sum, item) => {
    const gstRate = parseFloat(item.gst || 0);
    return sum + (item.price * item.quantity * gstRate) / 100;
  }, 0);

  // Use existing generatePDFInvoice but return buffer
  return await generatePDFInvoice(order, user, store, subtotal, gstTotal, {
    dType: dType,
  });
};

exports.generateThermalInvoiceController = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { dType } = req.query;
    const pdfBuffer = await exports.generatePDFBuffer(orderId, dType);

    // Send PDF as a download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=thermal_invoice_${orderId}.pdf`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generating thermal invoice:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to generate thermal invoice",
    });
  }
};
