/**
 * Moves shop submissions to the unit record inside the media items: mediaItems[] → units[] → photos / versions / reviews / reworks.
 *   - a shop with the earlier unit record (`boards`): converted as it is (unit decisions, voice notes, rework items kept), then removed
 *   - a shop reviewed the old shop-level way: each shop version becomes a unit version with the shop's OPS / CS decisions
 *   - a shop not submitted yet: its lines become DRAFT units
 * Names: key → mediaKey, name → mediaType (+ name kept), sided → sideType, U1 → unitId (SS-01 / DS-01), answers key → questionId.
 * The field app's flat record (top-level photos, versions, reviews, reworks) is NOT changed.
 *   Dry run:  npx tsx scripts/migrate-recce-units.ts
 *   Apply:    npx tsx scripts/migrate-recce-units.ts --apply
 *   One shop: add --id <submissionId>
 * Safe to run again: shops already moved are skipped.
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { RecceSubmission } from '../src/modules/recce-review/recceReview.model';
import { storedItemsOf, summaryOf } from '../src/modules/recce-review/recceReview.units';

const apply = process.argv.includes('--apply');
const idArg = (() => { const i = process.argv.indexOf('--id'); return i > 0 ? process.argv[i + 1] : undefined; })();

async function main() {
  await connectDb();
  // Not moved yet: an earlier `boards` record, or a media line still in the old shape (no mediaKey).
  const filter: Record<string, unknown> = { $or: [{ boards: { $exists: true } }, { mediaItems: { $elemMatch: { mediaKey: { $exists: false } } } }] };
  if (idArg) filter._id = idArg;
  const cursor = RecceSubmission.find(filter).setOptions({ strictQuery: false }).lean().cursor();
  let seen = 0;
  let written = 0;
  let failed = 0;
  for await (const sub of cursor) {
    seen++;
    try {
      const items = storedItemsOf(sub);
      const s = summaryOf(items);
      const from = (sub as { boards?: unknown[] }).boards?.length ? 'boards' : sub.currentVersion ? 'shop versions' : 'draft';
      console.log(`${String(sub._id)}  status=${sub.status}  v${sub.currentVersion}  from=${from}  media=${items.length}  units=${s.units} (approved ${s.approved}, review ${s.underReview}, rework ${s.rework}, draft ${s.draft})`);
      if (apply) {
        const cas = sub.rev == null ? { rev: { $exists: false } } : { rev: sub.rev };
        const r = await RecceSubmission.updateOne({ _id: sub._id, ...cas }, { $set: { mediaItems: items, summary: s, rev: (sub.rev ?? 0) + 1 }, $unset: { boards: 1 } }, { strict: false });
        if (r.modifiedCount) written++;
        else { failed++; console.warn(`  skipped: ${String(sub._id)} changed meanwhile, run again`); }
      }
    } catch (e) {
      failed++;
      console.error(`  failed: ${String(sub._id)}`, (e as Error).message);
    }
  }
  console.log(`${apply ? 'Applied' : 'Dry run'}: ${seen} shops checked, ${written} written, ${failed} failed/skipped.${apply ? '' : ' Add --apply to save.'}`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
