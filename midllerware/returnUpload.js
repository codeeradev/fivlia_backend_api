// NEW FILE: midllerware/returnUpload.js
// Upload of return photos (field name: "images", up to RETURN_MAX_IMAGES, images only).
// Separate from the shared multer.js so the limits only apply to returns.
// Files go to S3 under ReturnImages/. Use it AFTER verifyToken so only
// logged-in customers can upload.

const multer = require("multer");
const multerS3 = require("multer-s3");
const path = require("path");
const s3 = require("../config/aws");
const {
  RETURN_MAX_IMAGES,
  RETURN_IMAGE_MAX_MB,
} = require("../utils/returnPolicy");

const ALLOWED_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

const fileFilter = (req, file, cb) => {
  const okExt = ALLOWED_EXT.test(path.extname(file.originalname || ""));
  const okMime = /^image\/(jpeg|png|webp|gif|avif)$/i.test(file.mimetype || "");
  if (okExt && okMime) return cb(null, true);
  const err = new Error("INVALID_IMAGE_TYPE");
  err.code = "INVALID_IMAGE_TYPE";
  cb(err);
};

const uploader = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const rand = Math.random().toString(36).slice(2, 8);
      cb(null, `ReturnImages/${Date.now()}-${rand}${ext}`);
    },
  }),
  fileFilter,
  limits: {
    fileSize: RETURN_IMAGE_MAX_MB * 1024 * 1024,
    files: RETURN_MAX_IMAGES,
  },
}).array("images", RETURN_MAX_IMAGES);

module.exports = (req, res, next) => {
  uploader(req, res, (err) => {
    if (!err) return next();

    let message = "Image upload failed";
    if (err.code === "LIMIT_FILE_SIZE") {
      message = `Each image must be ${RETURN_IMAGE_MAX_MB} MB or smaller`;
    } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      message = `You can upload up to ${RETURN_MAX_IMAGES} images (form field name: images)`;
    } else if (err.code === "INVALID_IMAGE_TYPE") {
      message = "Only JPG, PNG, WEBP, GIF or AVIF images are allowed";
    } else {
      console.error("returnUpload error:", err.message);
    }
    return res.status(400).json({ status: false, message });
  });
};
