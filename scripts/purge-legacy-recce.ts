/**
 * One-off clean-up after recce data moved into ONE document per shop (RecceSubmission with embedded photos, versions, reviews and
 * rework requests). Before that move the same data lived in four more collections: reccephotos, recceversions, reccereviews and
 * reccereworks. There is no migration (test data only); this erases the old recce evidence so the shops start fresh:
 *
 *   1. the stored files (originals and marked copies) of every legacy photo, from local disk or Spaces,
 *   2. the legacy shop documents (no `photos` array) and their timeline entries,
 *   3. the four legacy collections.
 * Projects, shops, vendors, chat and everything else stay. Shops go back to "not started".
 *
 *   Dry run (counts only):  npx tsx scripts/purge-legacy-recce.ts
 *   Delete:                 npx tsx scripts/purge-legacy-recce.ts --apply
 * Refused when NODE_ENV=production.
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import { env } from '../src/config/env';
import { AuditLog } from '../src/modules/audit/auditLog.model';
import { collectStoredFiles, removeStoredFiles } from '../src/modules/files/file.service';
import { RecceSubmission } from '../src/modules/recce-review/recceReview.model';

const LEGACY = ['reccephotos', 'recceversions', 'reccereviews', 'reccereworks'];

async function main() {
  const apply = process.argv.includes('--apply');
  if (env.isProd) throw new Error('This clean-up is refused when NODE_ENV=production');
  await connectDb();
  const db = mongoose.connection.db!;
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const present = LEGACY.filter((n) => existing.has(n));

  const photos = existing.has('reccephotos') ? await db.collection('reccephotos').find({}, { projection: { original: 1, edited: 1 } }).toArray() : [];
  const files = collectStoredFiles(photos.map((p) => ({ o: p.original, e: p.edited })));
  const legacyShops = await RecceSubmission.find({ photos: { $exists: false } }).select('_id').lean();
  const legacyIds = legacyShops.map((s) => s._id);

  console.log(`legacy collections found: ${present.join(', ') || 'none'}`);
  for (const n of present) console.log(`  ${n}: ${await db.collection(n).countDocuments()} documents`);
  console.log(`legacy shop documents (no photos array): ${legacyIds.length}`);
  console.log(`stored photo files to erase: ${files.length}`);
  if (!apply) {
    console.log('Dry run only. Add --apply to delete.');
    await disconnectDb();
    return;
  }

  const { failed } = await removeStoredFiles(files);
  if (failed.length) throw new Error(`Could not erase these files from storage, so nothing was deleted: ${failed.join(', ')}. Try again.`);
  const timeline = await AuditLog.deleteMany({ entity: 'RecceSubmission', entityId: { $in: legacyIds } });
  const shops = await RecceSubmission.deleteMany({ _id: { $in: legacyIds } });
  for (const n of present) await db.collection(n).drop();
  console.log(`erased ${files.length} files, ${shops.deletedCount} shop documents, ${timeline.deletedCount} timeline entries, dropped ${present.length} collections.`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
