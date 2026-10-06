// NEW FILE: midllerware/returnUpload.js
// Upload of return photos (field name: "images", up to RETURN_MAX_IMAGES, see ALLOWED_TYPES for the accepted formats).
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

// Allowed formats: extension -> accepted MIME types sent by the client.
// Mobile apps / Postman often send "application/octet-stream" for HEIC, RAW,
// PSD, EPS and TIFF files, so the generic types are accepted as long as the
// file extension is on this list.
const GENERIC_MIME = ["application/octet-stream", "binary/octet-stream"];
const RAW_MIME = [
  "image/x-raw",
  "image/x-canon-cr2",
  "image/x-canon-cr3",
  "image/x-nikon-nef",
  "image/x-sony-arw",
  "image/x-adobe-dng",
  "image/dng",
  "image/x-olympus-orf",
  "image/x-panasonic-rw2",
  "image/x-fuji-raf",
  "image/x-samsung-srw",
  "image/x-pentax-pef",
];
const PHOTOSHOP_MIME = [
  "image/vnd.adobe.photoshop",
  "image/x-photoshop",
  "image/psd",
  "application/photoshop",
  "application/x-photoshop",
];

const ALLOWED_TYPES = {
  ".jpg": ["image/jpeg", "image/pjpeg"],
  ".jpeg": ["image/jpeg", "image/pjpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".avif": ["image/avif"],
  ".gif": ["image/gif"],
  ".svg": ["image/svg+xml"],
  ".bmp": ["image/bmp", "image/x-ms-bmp", "image/x-bmp"],
  ".tif": ["image/tiff", "image/x-tiff"],
  ".tiff": ["image/tiff", "image/x-tiff"],
  ".heic": ["image/heic", "image/heic-sequence", "image/heif"],
  ".heif": ["image/heif", "image/heif-sequence", "image/heic"],
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon", "image/ico", "image/icon"],
  ".raw": RAW_MIME,
  ".cr2": RAW_MIME,
  ".cr3": RAW_MIME,
  ".nef": RAW_MIME,
  ".arw": RAW_MIME,
  ".dng": RAW_MIME,
  ".orf": RAW_MIME,
  ".rw2": RAW_MIME,
  ".raf": RAW_MIME,
  ".srw": RAW_MIME,
  ".pef": RAW_MIME,
  ".psd": PHOTOSHOP_MIME,
  ".eps": ["application/postscript", "application/eps", "application/x-eps", "image/eps", "image/x-eps"],
  ".pdf": ["application/pdf"],
};

const ALLOWED_LABEL =
  "JPG, JPEG, PNG, WEBP, AVIF, GIF, SVG, BMP, TIF/TIFF, HEIC/HEIF, ICO, RAW (CR2, CR3, NEF, ARW, DNG...), PSD, EPS or PDF";

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  const okMimes = ALLOWED_TYPES[ext];
  if (okMimes && (okMimes.includes(mime) || GENERIC_MIME.includes(mime))) {
    return cb(null, true);
  }
  const err = new Error("INVALID_IMAGE_TYPE");
  err.code = "INVALID_IMAGE_TYPE";
  cb(err);
};

const uploader = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    // SVG can contain scripts - force download instead of opening inline in the browser
    contentDisposition: (req, file, cb) =>
      cb(
        null,
        path.extname(file.originalname || "").toLowerCase() === ".svg"
          ? "attachment"
          : "inline",
      ),
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
      message = `Only these formats are allowed: ${ALLOWED_LABEL}`;
    } else {
      console.error("returnUpload error:", err.message);
    }
    return res.status(400).json({ status: false, message });
  });
};
