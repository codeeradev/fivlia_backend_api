const { SettingAdmin } = require("../modals/setting");
const Order = require("../modals/order");
const User = require("../modals/User");
const Tax = require("../modals/tax");
const Page = require("../modals/pages");
exports.getSettings = async (req, res) => {
  try {
    const settings = await SettingAdmin.findOne().lean();
    if (!settings) {
      return res.status(404).json({ message: "Settings not found" });
    }

    return res.status(200).json({ message: "Settings", settings });
  } catch (error) {
    console.error("Get User Settings Error =>", error);
    return res
      .status(500)
      .json({ message: "Error getting settings", error: error.message });
  }
};

exports.settings = async (req, res) => {
  try {
    const userId = req.user;

    // Get the settings document (full, with all fields)
    const settings = await SettingAdmin.findOne().lean();
    if (!settings) {
      return res.status(404).json({ message: "Settings not found" });
    }

    const pages = await Page.find({
      pageSlug: {
        $in: ["about-us", "privacy", "terms"],
      },
    }).lean();

    const aboutUs = pages.find((p) => p.pageSlug === "about-us");
    const privacyPolicy = pages.find((p) => p.pageSlug === "privacy");
    const termsAndConditions = pages.find((p) => p.pageSlug === "terms");

    settings.links = {
      ...settings.links,

      about_us: aboutUs
        ? {
            title: aboutUs.pageSlug,
            _id: aboutUs._id,
            data: aboutUs.pageContent,
          }
        : null,

      privacy_Policy: privacyPolicy
        ? {
            title: privacyPolicy.pageSlug,
            _id: privacyPolicy._id,
            data: privacyPolicy.pageContent,
          }
        : null,

      termAndCondition: termsAndConditions
        ? {
            title: termsAndConditions.pageSlug,
            _id: termsAndConditions._id,
            data: termsAndConditions.pageContent,
          }
        : null,
    };

    // Get user data (including addresses)
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "Settings",
      mobileNumber: user.mobileNumber,
      settings,
    });
  } catch (error) {
    console.error("Get User Settings Error =>", error);
    return res
      .status(500)
      .json({ message: "Error getting settings", error: error.message });
  }
};

exports.getSmsType = async (req, res) => {
  try {
    const setting = await SettingAdmin.find();
    return res.status(200).json({ message: "Setting", setting });
  } catch {
    console.error("Get User Settings Error =>", error);
    return res
      .status(500)
      .json({ message: "Error getting settings", error: error.message });
  }
};

exports.adminSetting = async (req, res) => {
  try {
    let updateFields = req.body;

    if (req.body.payload) {
      updateFields = JSON.parse(req.body.payload);
    }

    if (updateFields.Map_Api && updateFields.Map_Api[0]) {
      const mapApi = updateFields.Map_Api[0];

      console.log(updateFields);
      const currentSettings = await SettingAdmin.findOne().lean();
      const currentMapApi = currentSettings?.Map_Api?.[0] || {};
      if (req.files?.image?.[0]) {
        updateFields.adminSignature = `/${req.files.image?.[0].key}`;
      }
      const finalMapApi = {
        google: { ...currentMapApi.google, ...mapApi.google },
        apple: { ...currentMapApi.apple, ...mapApi.apple },
        ola: { ...currentMapApi.ola, ...mapApi.ola },
      };

      if (mapApi.google?.status || mapApi.apple?.status || mapApi.ola?.status) {
        finalMapApi.google = { ...finalMapApi.google, status: false };
        finalMapApi.apple = { ...finalMapApi.apple, status: false };
        finalMapApi.ola = { ...finalMapApi.ola, status: false };

        if (mapApi.google?.status) finalMapApi.google.status = true;
        if (mapApi.apple?.status) finalMapApi.apple.status = true;
        if (mapApi.ola?.status) finalMapApi.ola.status = true;
      }

      updateFields.Map_Api = [finalMapApi];
    }

    const updatedSetting = await SettingAdmin.findOneAndUpdate(
      {},
      { $set: updateFields },
      { new: true, upsert: true },
    );

    return res.status(200).json({
      message: "Admin settings updated successfully",
      settings: updatedSetting,
    });
  } catch (error) {
    console.error("Admin Settings Error =>", error);
    return res.status(500).json({
      message: "Error updating settings",
      error: error.message,
    });
  }
};

exports.getTax = async (req, res) => {
  try {
    const result = await Tax.find();
    return res.status(200).json({ message: "Success", result });
  } catch {
    console.error("Get User Settings Error =>", error);
    return res
      .status(500)
      .json({ message: "Error getting settings", error: error.message });
  }
};
