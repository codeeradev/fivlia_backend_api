const appTelegramLog = require("../utils/app_telegram_logs");

exports.sendAppLog = async (req, res) => {
    try {
        const { title, data } = req.body;

        await appTelegramLog(title, data);

        return res.status(200).json({
            success: true,
            message: "Log sent successfully"
        });

    } catch (err) {
        console.error(err);

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};