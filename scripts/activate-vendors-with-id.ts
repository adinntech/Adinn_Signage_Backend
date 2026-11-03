/**
 * One-time catch-up: vendors whose registration mail was sent and whose vendor ID was typed BEFORE "vendor ID activates
 * the vendor" existed are still "Pending KYC". This makes them Active, the same as typing the ID does now. Inactive and
 * blacklisted vendors are never touched.
 *   Dry run:   npx tsx scripts/activate-vendors-with-id.ts
 *   Apply:     npx tsx scripts/activate-vendors-with-id.ts --apply
 * Add --code VND-0015 to look at one vendor only.
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { recordAudit } from '../src/modules/audit/audit.service';
import { User } from '../src/modules/users/user.model';
import { Vendor } from '../src/modules/vendors/vendor.model';

async function main() {
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const apply = process.argv.includes('--apply');
  const code = arg('--code')?.trim().toUpperCase();
  await connectDb();
  const list = await Vendor.find({ deletedAt: null, status: 'PENDING_KYC', zohoVendorNo: { $exists: true, $nin: [null, ''] }, 'registration.mailSentAt': { $ne: null }, ...(code ? { code } : {}) }).select('code name zohoVendorNo');
  console.log(`${list.length} vendor(s) have a vendor ID but are still Pending KYC${code ? ` (${code})` : ''}.`);
  for (const v of list) console.log(`  ${v.code} ${v.name} (vendor ID ${v.zohoVendorNo})`);
  if (list.length && !apply) console.log('Dry run only; add --apply to make them Active.');
  if (list.length && apply) {
    const admin = await User.findOne({ role: 'SUPER_ADMIN', deletedAt: null }).select('_id role');
    if (!admin) throw new Error('No super admin found to record the change under');
    for (const v of list) {
      const r = await Vendor.updateOne({ _id: v._id, status: 'PENDING_KYC' }, { $set: { status: 'ACTIVE' }, $unset: { statusReason: '' } });
      if (r.modifiedCount) await recordAudit({ actor: { id: String(admin._id), role: admin.role }, action: 'STATUS_CHANGE', entity: 'Vendor', entityId: v._id, changes: [{ field: 'status', oldValue: 'PENDING_KYC', newValue: 'ACTIVE' }], reason: 'Vendor ID already received (scripts/activate-vendors-with-id.ts)' });
    }
    console.log('Done: they are Active now.');
  }
  await disconnectDb();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
