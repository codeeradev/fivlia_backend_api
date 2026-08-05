exports.getOrderDetails = async (req, res) => {
  try {
    const userId = req.user;

    const userOrders = await Order.find({ userId })
      .sort({ createdAt: -1 })
      .lean();
    const results = [];

    const settings = await SettingAdmin.findOne();

    for (const order of userOrders) {
      // 1. Fetch address
      const address = await Address.findById(order.addressId).lean();

      // 2. Fetch driver details if driverId exists
      let driverInfo = {};
      if (order.driver && order.driver.driverId) {
        driverInfo = await driver
          .findOne({ _id: order.driver.driverId })
          .lean();

        let avgRating = null;
        let totalRatings = 0;

        if (driverInfo) {
          const ratingStats = await DriverRating.aggregate([
            { $match: { driverId: driverInfo._id } },
            {
              $group: {
                _id: "$driverId",
                average: { $avg: "$rating" },
                totalRatings: { $sum: 1 },
              },
            },
          ]);
          if (ratingStats.length) {
            avgRating = Number(ratingStats[0].average.toFixed(1));
            totalRatings = ratingStats[0].totalRatings;
          }

          driverInfo = {
            driverId: driverInfo.driverId || "",
            Id: driverInfo._id || "",
            name: driverInfo.driverName || "",
            mobileNo: driverInfo.address?.mobileNo || "",
            averageRating: avgRating || 0,
            totalRatings: totalRatings,
          };
        }
      }
      let storeLocation = null;
      if (order.storeId) {
        const storeData = await Store.findById(order.storeId, {
          Latitude: 1,
          Longitude: 1,
          storeName: 1,
        }).lean();

        if (storeData) {
          storeLocation = storeData.location || {
            Latitude: storeData.Latitude || null,
            Longitude: storeData.Longitude || null,
          };
          storeName = storeData.storeName;
        }
      }

      if (settings && order.totalPrice > settings.freeDeliveryLimit) {
        order.deliveryCharges = 0;
      }

      const subtotal = order.items.reduce((total, item) => {
        return total + Number(item.price) * Number(item.quantity);
      }, 0);

      const platformFee = Number(
        ((subtotal * settings.Platform_Fee) / 100).toFixed(2),
      );

      const itemsWithDetails = await Promise.all(
        order.items.map(async (item) => {
          const product = await Products.findById(item.productId).lean();
          return {
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            image: item.image,
            gst: item.gst,
            storeId: order.storeId,
            productId: item.productId,
            varientId: item.varientId,
            productDetails: {
              title: product?.title,
              description: product?.description,
              brand: product?.brand,
              images: product?.images,
            },
          };
        }),
      );
      // 4. Push combined data
      results.push({
        id: order._id,
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        totalPrice: order.totalPrice,
        cashOnDelivery: order.cashOnDelivery,
        deliveryCharges: order.deliveryCharges,
        platformFee,
        transactionId: order.transactionId || "",
        items: itemsWithDetails,
        address,
        driver: driverInfo,
        storeLocation,
        storeName,
        createdAt: order.createdAt,
      });
    }

    return res.status(200).json({
      message: "Orders fetched successfully",
      orders: results,
    });
  } catch (error) {
    console.error("Get orders error:", error.message);
    return res
      .status(500)
      .json({ message: "Server Error", error: error.message });
  }
};