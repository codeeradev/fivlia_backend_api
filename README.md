ok bro before going to any conclusion first understand everything

so driver apna refrel code se seller ko register karwae ga ->referralCode ye
so seller ke document mai ye refrel code hai driver ka

exports.getDriverReferralSeller = async (req, res) => {
  try {
    const { driverId } = req.body;
    let driverData = null;

    if (mongoose.Types.ObjectId.isValid(driverId)) {
      driverData = await driver.findById(driverId);
    } else {
      driverData = await driver.findOne({ driverId: driverId });
    }

    if (!driverData) {
      return res.status(404).json({ message: "Driver not found" });
    }

    // Fetch referral amount from settings
    const settings = await SettingAdmin.findOne();
    const referralAmount = settings?.referralAmount || 0;

    const stores = await Store.find({ referralCode: driverData.driverId })
      .select(
        "storeName email PhoneNumber city approveStatus status referralClaimed referralClaimedAt referralAmount",
      )
      .lean();
    if (!stores.length) {
      return res
        .status(204)
        .json({ message: "No users found with this referral code." });
    }
    // Add a commission field to each store
    const storesWithCommission = stores.map((store) => ({
      ...store,
      city: store.city?.name || null,
      commission: referralAmount,
      isClaimed: store.referralClaimed || false,
      claimedAt: store.referralClaimedAt || null,
      claimedAmount: store.referralAmount || 0,
    }));

    res.status(200).json({
      message: Found ${storesWithCommission.length} store(s) with this referral code.,
      stores: storesWithCommission,
      referralAmount,
    });
  } catch (error) {
    console.error("Error fetching stores:", error);
    res.status(500).json({
      message: "Server error while fetching stores",
      error: error.message,
    });
  }
};

<- is api se apa driver ko dikhaye ge ki uske refrel ye itne ban chuke hai jo dikhane ka hai driver ko claim krne ke jis se apa like driver ke wallet pe paise dale ge admin walle wallet se kaat ke.

getDriverReferralSeller ---> is api mai bas apa like uski earning show kre ge only

logic ye rahega seller ke profit ka me se apa ne 1% per order ka driver ko dena hai 
baar-2 calculation na krna pade bcs api slow hoje gi apa ammount seller ke document mai save krte rahega apa and claim ke time apa us ammount ko seller document se kaat dege and bro ek driver multiple seller ko refrels kar skta hai to multiple dimag mai leke chalna

orderStatus wali api mai dalde new key banake driver claims and only if refrel code exist or not invalid