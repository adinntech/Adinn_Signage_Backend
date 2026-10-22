/**
 * Finds records (notifications, chat, shops, audit ...) whose project was deleted, and stored files (local folder, or the Spaces bucket under this app's prefix) that no project records, for example
 * after data was deleted straight from MongoDB. Lists them; deletes only with --apply. Files newer than
 * STORAGE_ORPHAN_GRACE_MINUTES are skipped (pass --now to include them).
 *   Dry run:  npx tsx scripts/clean-orphan-files.ts
 *   Delete:   npx tsx scripts/clean-orphan-files.ts --apply
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { env } from '../src/config/env';
import { sweepOrphans } from '../src/modules/files/orphans';
import { sweepOrphanRecords } from '../src/modules/projects/project.cascade';

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb();
  const graceMs = process.argv.includes('--now') ? 0 : env.STORAGE_ORPHAN_GRACE_MINUTES * 60_000;
  const records = await sweepOrphanRecords(apply);
  console.log(`${apply ? 'deleted' : 'orphan'} records of deleted projects:`, records);
  const found = await sweepOrphans({ apply, graceMs });
  for (const k of found) console.log(`${apply ? 'deleted' : 'orphan'}: ${k}`);
  console.log(`${found.length} orphan file(s) ${apply ? 'deleted' : 'found (dry run, add --apply to delete)'}`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
