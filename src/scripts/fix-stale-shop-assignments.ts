/**
 * One-time repair for shops that were moved to another vendor / the in-house team before assign() cleared the old login assignment.
 * Such a shop still points (assignedTo) at a login that is not part of its current team, so the new vendor's mobile login cannot see it.
 *
 *   VENDOR shop   : assignedTo must be a login of that same vendor            (else cleared)
 *   IN_HOUSE shop : assignedTo must not be a VENDOR login                      (else cleared)
 *   unallocated   : no assignedTo at all                                       (else cleared)
 *
 * Cleared shops go back to PENDING. Default is a dry run that only prints; add --apply to write.
 * Also lists vendors that share a name (a login may be linked to the other record).
 *
 * Run:  npx tsx src/scripts/fix-stale-shop-assignments.ts [--apply]
 */
import { connectDb, disconnectDb } from '../config/db';
import { Site } from '../modules/sites/site.model';
import { User } from '../modules/users/user.model';
import { Vendor } from '../modules/vendors/vendor.model';

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDb();
  const sites = await Site.find({ assignedTo: { $ne: null }, deletedAt: null }).select('project shopName channel vendor assignedTo status').lean();
  const users = await User.find({ _id: { $in: [...new Set(sites.map((s) => String(s.assignedTo)))] } }).select('role vendorId name').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const stale = sites.filter((s) => {
    const u = byId.get(String(s.assignedTo));
    if (s.channel === 'VENDOR') return !(u?.role === 'VENDOR' && String(u.vendorId) === String(s.vendor));
    if (s.channel === 'IN_HOUSE') return u?.role === 'VENDOR';
    return true;
  });
  console.log(`${sites.length} shop(s) have a login assignment; ${stale.length} are stale.`);
  const perProject = new Map<string, number>();
  for (const s of stale) perProject.set(String(s.project), (perProject.get(String(s.project)) ?? 0) + 1);
  for (const [p, n] of perProject) console.log(`  project ${p}: ${n} shop(s)`);

  if (apply && stale.length) {
    const r = await Site.updateMany({ _id: { $in: stale.map((s) => s._id) } }, { $unset: { assignedTo: 1, assignedToAt: 1, assignedToBy: 1 }, $set: { status: 'PENDING' } });
    console.log(`Cleared ${r.modifiedCount} shop(s).`);
  } else if (stale.length) {
    console.log('Dry run: nothing written. Add --apply to clear them.');
  }

  const vendors = await Vendor.find({ deletedAt: null }).select('name code zohoVendorNo status').lean();
  const groups = new Map<string, typeof vendors>();
  for (const v of vendors) groups.set(v.name.toLowerCase().trim(), [...(groups.get(v.name.toLowerCase().trim()) ?? []), v]);
  const dups = [...groups.values()].filter((g) => g.length > 1);
  console.log(`${dups.length} vendor name(s) appear more than once:`);
  for (const g of dups) {
    console.log(`  ${g[0]!.name}`);
    for (const v of g) {
      const logins = await User.countDocuments({ role: 'VENDOR', vendorId: v._id, deletedAt: null });
      const shops = await Site.countDocuments({ channel: 'VENDOR', vendor: v._id, deletedAt: null });
      console.log(`    ${v.code}  vendorNo=${v.zohoVendorNo ?? '-'}  ${v.status}  logins=${logins}  shops=${shops}`);
    }
  }
  await disconnectDb();
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
