exports.getBanner = async (req, res) => {
  const totalStart = Date.now();

  try {
    const { type } = req.query;
    const userId = req.user;

    console.time("1. User Query");
    const user = await User.findById(userId).lean();
    console.timeEnd("1. User Query");

    if (!user || !user.location?.latitude || !user.location?.longitude) {
      return res.status(400).json({ message: "User location not found" });
    }

    const userLat = user.location.latitude;
    const userLng = user.location.longitude;

    console.time("4. Active Zones");
    const zoneDocs = await ZoneData.find({ status: true }, "zones").lean();
    console.timeEnd("4. Active Zones");

    console.time("5. Zone Processing");
    const activeZoneIds = [];
    zoneDocs.forEach((doc) => {
      (doc.zones || []).forEach((zone) => {
        if (zone.status && zone._id) {
          activeZoneIds.push(zone._id.toString());
        }
      });
    });
    console.timeEnd("5. Zone Processing");

    console.time("6. Brand Query");
    const brandIds = req.typeId
      ? (
          await brand.find({ typeId: req.typeId })
            .select("_id")
            .lean()
        ).map((b) => b._id)
      : [];
    console.timeEnd("6. Brand Query");

    console.time("7. Category ObjectIds");
    const categoryObjectIds = (req.categoryIds || []).map(
      (id) => new mongoose.Types.ObjectId(id)
    );

    const allCategoryObjectIds = (
      req.allCategoryIds ||
      req.categoryIds ||
      []
    ).map((id) => new mongoose.Types.ObjectId(id));
    console.timeEnd("7. Category ObjectIds");

    console.time("8. Banner Scope");
    const bannerScope = [];

    if (req.typeId) {
      bannerScope.push(
        {
          type2: {
            $in: ["Category", "SubCategory", "Sub Sub-Category"],
          },
          $or: [
            { "mainCategory._id": { $in: categoryObjectIds } },
            { "subCategory._id": { $in: allCategoryObjectIds } },
            { "subSubCategory._id": { $in: allCategoryObjectIds } },
          ],
        },
        {
          type2: "Brand",
          "brand._id": { $in: brandIds },
        },
        {
          type2: "Store",
        },
        {
          type2: "NO",
        }
      );
    }
    console.timeEnd("8. Banner Scope");

    console.time("9. Banner Query");
    const allBanners = await Banner.find({
      status: { $ne: false },
      ...(req.typeId && {
        typeId: new mongoose.Types.ObjectId(req.typeId),
      }),
      ...(type && { type }),
      ...(bannerScope.length && { $or: bannerScope }),
    })
      .sort({ createdAt: -1 })
      .lean();
    console.timeEnd("9. Banner Query");

    console.log("Banner Count:", allBanners.length);

    console.time("10. Banner Radius Filter");
    const matchedBanners = await getBannersWithinRadius(
      userLat,
      userLng,
      allBanners
    );
    console.timeEnd("10. Banner Radius Filter");

    let finalBanners = [...matchedBanners];

    const now = new Date();

    console.time("11. Stores Radius");
    const storeResult = await getStoresWithinRadius(
      userLat,
      userLng
    );
    console.timeEnd("11. Stores Radius");

    if (storeResult?.matchedStores?.length) {
      const nearbyStoreIds = storeResult.matchedStores.map(
        (s) => s._id
      );

      console.log(
        "Nearby Stores:",
        nearbyStoreIds.length
      );

      console.time("12. Coupon Aggregate");
      const sellerCoupons = await Coupon.aggregate([
        {
          $match: {
            storeId: { $in: nearbyStoreIds },
            status: true,
            approvalStatus: "approved",
            fromTo: { $lte: now },
            expireDate: { $gte: now },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$storeId",
            coupon: { $first: "$$ROOT" },
          },
        },
        {
          $replaceRoot: {
            newRoot: "$coupon",
          },
        },
      ]);
      console.timeEnd("12. Coupon Aggregate");

      console.log(
        "Seller Coupons:",
        sellerCoupons.length
      );

      console.time("13. Coupon Mapping");
      const sellerOfferBanners = sellerCoupons.map((c) => ({
        _id: c._id,
        image: c.image,
        title: c.title,
        storeId: c.storeId,
        offer: Number(c.offer),
        type: "offer",
        type2: "Store",
        source: "seller",
        createdAt: c.createdAt,
      }));
      console.timeEnd("13. Coupon Mapping");

      console.time("14. Admin Banner Mapping");
      finalBanners = finalBanners.map((b) => ({
        ...b,
        source: "admin",
      }));
      console.timeEnd("14. Admin Banner Mapping");

      console.time("15. Final Merge");
      finalBanners = [
        ...sellerOfferBanners,
        ...finalBanners,
      ];
      console.timeEnd("15. Final Merge");
    }

    console.log(
      `🚀 TOTAL API TIME: ${Date.now() - totalStart}ms`
    );

    return res.status(200).json({
      message: "Banners fetched successfully.",
      count: finalBanners.length,
      data: finalBanners,
    });
  } catch (error) {
    console.error(error);
  }
};



https://automation.codeeratech.in/webhook/692bc3d3-5d86-4c8a-8770-334b5cd660e8
EAAOJp6sTKowBRhxjZBsipBI7V6U8M4O9FK6Ge4cMGWRK0tGsnd3lJjbpLrIDElYZBewUI9WoOOghdIyDZAJu1Xw2qfEpOncdredpYvFJ5K0Ukzx3arFdM3dloPx0rRtu3DnIe21DZBK5bkA7PG5AXg1YoSZCX3NfUvgqLER0ureOR5fzeIEFqeNg01xEmJhhkQ0EHcJfE