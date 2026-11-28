/**
 * One-time update for the "CS OR OPS approval is enough" rule (2026-11-28): shops still under review whose units one stage has
 * already approved are completed (the other stage's pending review becomes "not needed") and the shop status is rolled up again.
 *   Dry run:  npx tsx scripts/recalc-recce-approvals.ts        (lists the shops under review)
 *   Apply:    npx tsx scripts/recalc-recce-approvals.ts --apply
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { RecceSubmission } from '../src/modules/recce-review/recceReview.model';
import { recalcUnits } from '../src/modules/recce-review/recceReview.units';

async function main() {
  await connectDb();
  const apply = process.argv.includes('--apply');
  const subs = await RecceSubmission.find({ status: { $in: ['SUBMITTED', 'UNDER_REVIEW'] } }).select('_id status').lean();
  let changed = 0;
  for (const s of subs) {
    if (!apply) { console.log(`${String(s._id)}  ${s.status}`); continue; }
    if (await recalcUnits(s._id)) { changed++; console.log(`updated ${String(s._id)}`); }
  }
  console.log(apply ? `Done: ${changed} of ${subs.length} shops updated.` : `Dry run: ${subs.length} shops under review. Add --apply to update.`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
