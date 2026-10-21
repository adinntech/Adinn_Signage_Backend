// utils/deleteFromSpaces.js
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const spacesClient = require('../config/spaces');

const getKeyFromUrl = (fileUrl) => {
  const bucketBase = process.env.DO_SPACES_CDN_BASE;

  if (!fileUrl.startsWith(bucketBase)) {
    // If it's a local URL, we don't delete from Spaces
    if (fileUrl.includes('localhost') || fileUrl.startsWith('http://localhost')) {
      return null;
    }
    throw new Error(`Invalid Spaces URL: ${fileUrl}`);
  }

  return fileUrl.replace(`${bucketBase}/`, '');
};

const deleteFromSpaces = async (fileUrl) => {
  const key = getKeyFromUrl(fileUrl);

  // Skip deletion for local URLs
  if (!key) {
    console.log('Skipping deletion for local file:', fileUrl);
    return;
  }

  const command = new DeleteObjectCommand({
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: key,
  });

  await spacesClient.send(command);
};

/*
 * Best-effort cleanup for a whole record's worth of file URLs at once (e.g.
 * every field on a document being deleted). Never throws — a record delete
 * must still succeed even if one of its file URLs is malformed, already
 * gone, or (for older/legacy rows) hosted somewhere other than this Spaces
 * bucket (e.g. a stray Cloudinary URL), which deleteFromSpaces treats as an
 * error. Falsy/empty entries are skipped silently; every other failure is
 * logged, not thrown, so callers can fire-and-forget this after confirming
 * the DB delete succeeded.
 */
const deleteManyFromSpaces = async (fileUrls) => {
  const urls = (fileUrls || []).filter(Boolean);

  await Promise.all(
    urls.map(async (url) => {
      try {
        await deleteFromSpaces(url);
      } catch (error) {
        console.error('Failed to delete Spaces file:', url, error.message);
      }
    })
  );
};

const isSpaceUrl = (value) => {
  const bucketBase = process.env.DO_SPACES_CDN_BASE;
  return typeof value === 'string' && !!bucketBase && value.startsWith(bucketBase);
};

/*
 * Recursively walks any value (a Mongoose document, a plain object/array,
 * anything) and collects every string that points at this Space bucket.
 * A record like Order has 15+ file-bearing fields scattered across deeply
 * nested sub-schemas and arrays (booking media, gatepass/issue/resolve
 * photos, PO document snapshots/history, the booking-summary PDF, ...) —
 * hand-listing every path is fragile and silently goes stale the moment a
 * new one is added later. Matching on the URL shape itself instead stays
 * correct as the schema grows, at the cost of being unable to tell "this
 * was a file field" from "this string coincidentally looks like one" — in
 * practice nothing but an actual Space upload URL ever starts with
 * DO_SPACES_CDN_BASE, so that's not a real risk in this codebase.
 */
const collectSpaceUrls = (value, seen = new Set()) => {
  if (value == null) return [];

  if (typeof value === 'string') {
    return isSpaceUrl(value) ? [value] : [];
  }

  if (typeof value !== 'object') return [];

  /* Normalizes Mongoose documents/subdocuments, ObjectIds, Dates, etc. to
     their plain JSON form before walking — a raw Mongoose document's own
     enumerable properties include internal bookkeeping (_doc, $__, ...)
     that isn't worth (and isn't safe to) walk directly. An ObjectId/Date's
     toJSON() collapses it to a plain string, which the check above already
     handles on the next call. */
  if (typeof value.toJSON === 'function') {
    value = value.toJSON();
  }

  if (typeof value === 'string') {
    return isSpaceUrl(value) ? [value] : [];
  }

  if (typeof value !== 'object' || value === null) return [];

  // Guards against circular references (Mongoose documents can have them
  // via populated back-references) rather than actually expecting any here.
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSpaceUrls(item, seen));
  }

  return Object.values(value).flatMap((item) => collectSpaceUrls(item, seen));
};

module.exports = deleteFromSpaces;
module.exports.deleteManyFromSpaces = deleteManyFromSpaces;
module.exports.collectSpaceUrls = collectSpaceUrls;