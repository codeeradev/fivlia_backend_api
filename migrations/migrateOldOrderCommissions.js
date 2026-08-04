const mongoose = require("mongoose");
const { Order } = require("../modals/order");
const Store = require("../modals/store");
const driver = require("../modals/driver");
const DriverReferralCommission = require("../modals/driverReferralCommission");
const admin_transaction = require("../modals/adminTranaction");
const store_transaction = require("../modals/storeTransaction");
const { SettingAdmin } = require("../modals/setting");
require("dotenv").config();

/**
 * Migration script to calculate and track driver referral commissions for old delivered orders
 * Run this once to backfill commission data
 */

const migrateOldOrderCommissions = async () => {
  try {
    console.log("🚀 Starting migration for old order commissions...\n");

    // Connect to database
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB\n");

    // Fetch settings
    const settings = await SettingAdmin.findOne().lean();
    const foodSellerTaxPercent = Number(settings?.foodSellerTaxPercent || 5);

    // Get all delivered orders that don't have commission records
    const existingCommissionOrderIds = await DriverReferralCommission.distinct(
      "orderId"
    );

    const deliveredOrders = await Order.find({
      orderStatus: "Delivered",
      deliverStatus: true,
      orderId: { $nin: existingCommissionOrderIds },
    })
      .select("orderId _id storeId items")
      .lean();

    console.log(
      `📦 Found ${deliveredOrders.length} delivered orders without commission tracking\n`
    );

    if (deliveredOrders.length === 0) {
      console.log("✅ No orders to migrate. All orders are already tracked.\n");
      await mongoose.connection.close();
      return;
    }

    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Process each order
    for (let i = 0; i < deliveredOrders.length; i++) {
      const order = deliveredOrders[i];
      
      try {
        console.log(
          `[${i + 1}/${deliveredOrders.length}] Processing order: ${order.orderId}`
        );

        // Get store details
        const store = await Store.findById(order.storeId).lean();
        
        if (!store) {
          console.log(`  ⚠️  Store not found for order ${order.orderId}`);
          skippedCount++;
          continue;
        }

        // Check if store has referral code
        if (!store.referralCode) {
          console.log(`  ⏭️  No referral code for store ${store.storeName}`);
          skippedCount++;
          continue;
        }

        // Find referring driver by driverId string (like "FV001")
        const referringDriver = await driver.findOne({
          driverId: store.referralCode,
        }).lean();

        if (!referringDriver) {
          console.log(
            `  ⚠️  Driver not found for referral code: ${store.referralCode}`
          );
          skippedCount++;
          continue;
        }

        // Calculate seller profit (same logic as order delivery)
        const itemTotal = order.items.reduce((sum, item) => {
          return sum + item.price * item.quantity;
        }, 0);

        // Calculate commission
        const totalCommission = order.items.reduce((sum, item) => {
          const itemTotal = item.price * item.quantity;
          const commissionAmount = ((item.commision || 0) / 100) * itemTotal;
          return sum + commissionAmount;
        }, 0);

        // Calculate food seller tax
        const foodItemsTotal = order.items.reduce((sum, item) => {
          const typeName = String(item.typeName || "")
            .trim()
            .toLowerCase();
          if (typeName === "food") {
            return sum + item.price * item.quantity;
          }
          return sum;
        }, 0);

        const foodSellerTaxAmount = !store.Authorized_Store
          ? (foodItemsTotal * foodSellerTaxPercent) / 100
          : 0;

        const totalAdminDeduction = totalCommission + foodSellerTaxAmount;

        // Calculate creditToStore (seller profit)
        let creditToStore = itemTotal;
        if (!store.Authorized_Store) {
          creditToStore = itemTotal - totalAdminDeduction;
        }

        // Handle seller-sponsored delivery
        const sellerSponsoredPayout =
          order.sellerSponsoredDeliveryPayout || 0;
        if (sellerSponsoredPayout > 0) {
          creditToStore = creditToStore - sellerSponsoredPayout;
        }

        if (creditToStore <= 0) {
          console.log(
            `  ⏭️  No profit to commission (creditToStore: ${creditToStore})`
          );
          skippedCount++;
          continue;
        }

        // Calculate 1% commission
        const commissionPercentage = 1;
        const commissionAmount = (creditToStore * commissionPercentage) / 100;

        // Create commission record
        await DriverReferralCommission.create({
          driverId: referringDriver._id,
          storeId: order.storeId,
          orderId: order.orderId,
          orderObjectId: order._id,
          sellerProfit: creditToStore,
          commissionAmount,
          commissionPercentage,
          status: "pending",
        });

        console.log(
          `  ✅ Commission tracked: ₹${commissionAmount.toFixed(2)} (Seller Profit: ₹${creditToStore.toFixed(2)})`
        );
        successCount++;
      } catch (err) {
        console.error(
          `  ❌ Error processing order ${order.orderId}:`,
          err.message
        );
        errorCount++;
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📊 Migration Summary:");
    console.log("=".repeat(60));
    console.log(`✅ Successfully tracked: ${successCount} orders`);
    console.log(`⏭️  Skipped: ${skippedCount} orders`);
    console.log(`❌ Errors: ${errorCount} orders`);
    console.log(`📦 Total processed: ${deliveredOrders.length} orders`);
    console.log("=".repeat(60) + "\n");

    // Show total pending commissions
    const totalPendingCommissions = await DriverReferralCommission.aggregate([
      { $match: { status: "pending" } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$commissionAmount" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    if (totalPendingCommissions.length > 0) {
      console.log("💰 Total Pending Commissions:");
      console.log(
        `   Amount: ₹${totalPendingCommissions[0].totalAmount.toFixed(2)}`
      );
      console.log(`   Orders: ${totalPendingCommissions[0].totalOrders}`);
      console.log();
    }

    console.log("✅ Migration completed successfully!\n");

    await mongoose.connection.close();
    console.log("🔌 Database connection closed\n");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run migration if called directly
if (require.main === module) {
  migrateOldOrderCommissions();
}

module.exports = migrateOldOrderCommissions;
