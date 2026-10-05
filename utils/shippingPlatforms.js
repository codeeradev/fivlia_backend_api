// Shipping (third party courier) platforms for GLOBAL orders.
// Stored in admin settings as: shippingPlatforms: [{ name, trackingUrlTemplate, status }]
// trackingUrlTemplate must contain {trackingId}, e.g. https://courier.example.com/track/{trackingId}

const PLACEHOLDER = "{trackingId}";

const isHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
};

// Builds the customer facing tracking link from a platform template.
const buildTrackingUrl = (template, trackingId) => {
  const id = String(trackingId || "").trim();
  if (!template || !id) return "";
  return String(template).split(PLACEHOLDER).join(encodeURIComponent(id));
};

// Case-insensitive lookup of an ACTIVE platform by name.
const findShippingPlatform = (platforms, name) => {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted || !Array.isArray(platforms)) return null;
  return (
    platforms.find(
      (p) =>
        p &&
        p.status !== false &&
        String(p.name || "").trim().toLowerCase() === wanted,
    ) || null
  );
};

// Validates and normalises the list sent from the admin panel.
// Returns { error } or { values }.
const validateShippingPlatforms = (input) => {
  if (!Array.isArray(input)) {
    return { error: "shippingPlatforms must be a list" };
  }
  if (input.length > 50) {
    return { error: "shippingPlatforms can have at most 50 entries" };
  }

  const seen = new Set();
  const values = [];

  for (const row of input) {
    const name = String(row?.name || "").trim();
    const template = String(row?.trackingUrlTemplate || "").trim();

    if (!name) return { error: "Each shipping platform needs a name" };
    if (name.length > 60) return { error: "Platform name is too long" };

    const key = name.toLowerCase();
    if (seen.has(key)) {
      return { error: `Duplicate shipping platform: ${name}` };
    }
    seen.add(key);

    if (template) {
      if (!template.includes(PLACEHOLDER)) {
        return {
          error: `Tracking link of ${name} must contain ${PLACEHOLDER}`,
        };
      }
      if (!isHttpUrl(template.split(PLACEHOLDER).join("TEST"))) {
        return {
          error: `Tracking link of ${name} must be a valid http(s) URL`,
        };
      }
    }

    values.push({
      name,
      trackingUrlTemplate: template,
      status: row?.status !== false,
    });
  }

  return { values };
};

module.exports = {
  buildTrackingUrl,
  findShippingPlatform,
  validateShippingPlatforms,
};
