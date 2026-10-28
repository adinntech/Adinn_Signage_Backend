/**
 * Demo data for the vendor mobile app: one project of 13 shops given to two vendors (8 and 5), each with one vendor login.
 *   Dry run:  npx tsx scripts/seed-vendor-demo.ts
 *   Apply:    npx tsx scripts/seed-vendor-demo.ts --apply
 * Safe to run again (nothing is duplicated). Remove the project with: npx tsx scripts/purge-projects.ts --code DEMO-VENDOR-001 --apply
 * (the vendors and logins stay; delete them from the web app if you no longer want them). Demo logins use MPIN 2580.
 */
import { connectDb, disconnectDb } from '../src/config/db';
import { hashMpin } from '../src/modules/auth/auth.service';
import { Client } from '../src/modules/clients/client.model';
import { Project } from '../src/modules/projects/project.model';
import { Site } from '../src/modules/sites/site.model';
import { User } from '../src/modules/users/user.model';
import { Vendor } from '../src/modules/vendors/vendor.model';

const PROJECT_CODE = 'DEMO-VENDOR-001';
const MPIN = '2580';
const TEAMS = [
  { code: 'VND-DEMO1', name: 'Ravi Signage Works', person: 'Ravi', phone: '9000000001', email: 'ravi.vendor@demo.invalid', shops: 8 },
  { code: 'VND-DEMO2', name: 'Kumar Recce Services', person: 'Kumar', phone: '9000000002', email: 'kumar.vendor@demo.invalid', shops: 5 },
];
const AREAS: [string, string, string][] = [
  ['Madurai', 'Anna Nagar', '625020'],
  ['Madurai', 'Thirunagar', '625006'],
  ['Theni', 'Periyakulam', '625601'],
  ['Dindigul', 'Palani Road', '624001'],
];

async function main() {
  if (!process.argv.includes('--apply')) {
    console.log(`Dry run. Would create project ${PROJECT_CODE} with 13 shops, vendors ${TEAMS.map((t) => t.name).join(' and ')} and logins ${TEAMS.map((t) => t.phone).join(', ')} (MPIN ${MPIN}). Add --apply to save.`);
    return;
  }
  await connectDb();
  const client = (await Client.findOne({ code: 'DEMO' })) ?? (await Client.create({ name: 'Demo Client', code: 'DEMO', clientType: 'EXISTING' }));
  const project =
    (await Project.findOne({ code: PROJECT_CODE })) ??
    (await Project.create({ code: PROJECT_CODE, name: 'Demo vendor recce', client: client._id, requirementType: 'SHOP_MEASUREMENT', status: 'IN_PROGRESS', expectedShops: 13 }));
  let seq = 0;
  for (const t of TEAMS) {
    const vendor =
      (await Vendor.findOne({ code: t.code })) ??
      (await Vendor.create({ code: t.code, name: t.name, nameKey: t.name.toLowerCase(), type: 'ORGANIZATION', mobile: t.phone, district: 'Madurai', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true, verifiedAt: new Date() } }));
    if (!(await User.exists({ email: t.email }))) {
      await User.create({ name: t.person, email: t.email, phone: t.phone, role: 'VENDOR', vendorId: vendor._id, authMethod: 'MPIN', mpinHash: await hashMpin(MPIN) });
    }
    for (let i = 0; i < t.shops; i++) {
      seq++;
      const [district, location, pincode] = AREAS[seq % AREAS.length]!;
      await Site.updateOne(
        { siteCode: `${PROJECT_CODE}-S${String(seq).padStart(3, '0')}` },
        {
          $setOnInsert: {
            project: project._id, seq, scenario: 'MEASUREMENT_REQUIRED', shopName: `Demo Shop ${seq}`, dealerName: `Dealer ${seq}`,
            district, location, pincode, mobile: `98400${10000 + seq}`, address1: `${seq}, Main Road`,
            channel: 'VENDOR', vendor: vendor._id, allocatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }
  await Project.updateOne({ _id: project._id }, { siteCount: await Site.countDocuments({ project: project._id, deletedAt: null }) });
  console.log(`Done. Vendor logins: ${TEAMS.map((t) => `${t.person} ${t.phone}`).join(', ')} | MPIN ${MPIN}`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
