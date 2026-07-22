const Intro = require("../modals/intro");
const Event = require("../modals/event");
const DownloadApp = require("../modals/appPages");
const moment = require("moment");
exports.intro = async (req, res) => {
  try {
    const { title, description } = req.body;
    const rawImagePath = req.files?.image?.[0]?.key || "";
    const image = rawImagePath ? `/${rawImagePath}` : "";
    const newItem = await Intro.create({ title, description, image });
    return res
      .status(200)
      .json({ message: "intro Added Sucessfully", data: newItem });
  } catch (error) {
    console.error("error=>", error);
    return res.status(500).json({ message: "An Error Occured" });
  }
};
exports.getIntro = async (req, res) => {
  try {
    const intro = await Intro.find();
    return res.json(intro);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An Error Occured" });
  }
};

exports.addEvent = async (req, res) => {
  try {
    const { eventTitle, type, eventStatus, fontColor, startTime, endTime } =
      req.body;
    const image = `/${req.files.image?.[0].key}`;

    const start = moment(`${startTime}`, "YYYY-MM-DD hh:mmA").toDate(); // e.g., 10:00AM → Date object today
    const end = moment(`${endTime}`, "YYYY-MM-DD hh:mmA").toDate();

    const newEvent = await Event.create({
      eventDetails: { eventTitle, fontColor, eventImage: image },
      startTime: start,
      endTime: end,
      type,
      eventStatus,
    });

    return res
      .status(200)
      .json({ message: "Event Added Successfuly", newEvent });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An Error Occured" });
  }
};

exports.getEvent = async (req, res) => {
  try {
    const { lat, long, role } = req.body;
    const now = moment();

    await Event.updateMany(
      { endTime: { $lt: now.toDate() }, eventStatus: true },
      { $set: { eventStatus: false } },
    );

    if (role === "admin") {
      const AllEvent = await Event.find();
      return res.json(AllEvent);
    }

    const activeEvent = await Event.findOne({ eventStatus: true }).sort({
      startTime: 1,
    });

    if (!activeEvent) {
      // No active events
      return res.status(200).json({ eventStatus: false });
    }

    res.status(200).json({
      eventStatus: true,
      eventDetails: {
        eventTitle: activeEvent.eventDetails.eventTitle,
        eventImage: activeEvent.eventDetails.eventImage,
        type: activeEvent.type,
        startTime: activeEvent.startTime,
        endTime: activeEvent.endTime,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An Error Occured" });
  }
};

exports.editEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const { eventTitle, type, eventStatus, fontColor, startTime, endTime } =
      req.body;
    const image = `/${req.files.image?.[0].key}`;

    const start = moment(`${startTime}`, "YYYY-MM-DD hh:mmA").toDate(); // e.g., 10:00AM → Date object today
    const end = moment(`${endTime}`, "YYYY-MM-DD hh:mmA").toDate();

    const updateFields = {};

    if (eventTitle) updateFields["eventDetails.eventTitle"] = eventTitle;
    if (type) updateFields.type = type;
    if (eventStatus) updateFields.eventStatus = eventStatus;
    if (fontColor) updateFields["eventDetails.fontColor"] = fontColor;
    if (startTime) updateFields.startTime = startTime;
    if (endTime) updateFields.endTime = endTime;
    if (req.files?.image?.[0]) {
      updateFields["eventDetails.eventImage"] = `/${req.files.image?.[0].key}`;
    }

    const newEvent = await Event.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true },
    );

    return res
      .status(200)
      .json({ message: "Event Edited Successfuly", newEvent });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "An Error Occured" });
  }
};

exports.addDownloadAppPages = async (req, res) => {
  try {
    const { stream, appName, appLink, description } = req.body;
    const appImage = `/${req.files.image?.[0].key}`;
    const newApp = await DownloadApp.create({
      appImage,
      stream,
      appName,
      appLink,
      description,
    });
    return res.status(200).json({ message: "App page created", newApp });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};

exports.getDownloadAppPages = async (req, res) => {
  try {
    const Apps = await DownloadApp.find();
    return res.json(Apps);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server Error" });
  }
};
