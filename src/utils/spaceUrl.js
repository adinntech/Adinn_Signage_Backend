// Utils/spaceUrl.js
// Builds complete, valid HTTPS DigitalOcean Spaces URLs from an object key.

const path = require("path");

const CDN_BASE = process.env.DO_SPACES_CDN_BASE || "";
const CDN_URL = process.env.DO_SPACES_CDN_URL || "";
const BUCKET = process.env.DO_SPACES_BUCKET || "adinn-space";
const REGION = process.env.DO_SPACES_REGION || "sgp1";

// Canonical Spaces base URL: https://<bucket>.<region>.digitaloceanspaces.com
const getSpaceBaseUrl = () => {
  const base = CDN_BASE || CDN_URL;
  if (base) return String(base).replace(/\/+$/, "");
  return `https://${BUCKET}.${REGION}.digitaloceanspaces.com`;
};

// Build a complete HTTPS Spaces URL from an object key (handles stray slashes).
const buildSpaceUrl = (key) => {
  const raw = String(key || "").replace(/^\/+|\/+$/g, "");
  const cleanKey = raw.replace(/\/{2,}/g, "/");
  if (!cleanKey) return "";
  return `${getSpaceBaseUrl()}/${cleanKey}`;
};

/**
 * Resolve a multer upload file (or an already-stored string) to a storage URL.
 * - STORAGE_TYPE=space  -> canonical https://... Spaces URL built from the key
 * - STORAGE_TYPE=local  -> /uploads/<basename> (unchanged existing behavior)
 */
const resolveStoredUrl = (fileOrPath) => {
  if (!fileOrPath) return "";

  // A plain string: pass through full https URLs, otherwise a local path.
  if (typeof fileOrPath === "string") {
    if (/^https?:\/\//i.test(fileOrPath)) return fileOrPath;
    return fileOrPath;
  }

  const file = fileOrPath;

  if (process.env.STORAGE_TYPE === "space") {
    // Prefer the object key for a canonical URL; fall back to a valid existing
    // full location only when no key is present (e.g. already-uploaded records).
    if (file.key) return buildSpaceUrl(file.key);
    if (file.location && /^https?:\/\//i.test(file.location)) return file.location;
    return "";
  }

  // Local storage — preserve existing behavior exactly.
  return file.path ? `/uploads/${path.basename(file.path)}` : "";
};

module.exports = { buildSpaceUrl, getSpaceBaseUrl, resolveStoredUrl };
