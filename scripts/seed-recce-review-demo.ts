/**
 * Dev data for MANUAL recce review testing: five projects with shops split between vendors (60%) and in-house staff (40%).
 *   DEMO-RECCE-001  20 shops  submitted        DEMO-RECCE-002  30 shops  submitted
 *   DEMO-RECCE-003  10 shops  submitted        DEMO-RECCE-004  20 shops  submitted
 *   DEMO-RECCE-005  10 shops  not started (allocated only, no recce submission)
 * Every submitted shop is version 1 waiting for OPS and CS (nothing is approved or rejected here: that is done by hand).
 * Each shop has 1–3 media lines (GSP single, GSP double, Vinyl), each unit with width / height, installation type, six answers
 * and seven GPS-tagged photos. The data goes the same way as a field submit: flat field record → real unit sync
 * (syncAfterSubmit) → `reccesubmissions.mediaItems[].units[]` with versions and pending reviews. Timeline events go to AuditLog.
 *   Dry run:  npx tsx scripts/seed-recce-review-demo.ts --cs <client-servicing-email> --ops <operations-email>
 *   Apply:    add --apply
 *   Re-seed:  add --reset (removes ONLY these five demo projects' shops, submissions and timeline first)
 * Projects are created by the CS login and assigned to the OPS login, so both see them in Project Approval / Recce Review.
 * Seven small PNG files are stored once and shared by every demo photo. Field logins: review.vendor1..6 / review.staff1..4
 * @demo.invalid, MPIN 2580. Remove a project with: npx tsx scripts/purge-projects.ts --code DEMO-RECCE-00X --apply
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db';
import { hashMpin } from '../src/modules/auth/auth.service';
import { AuditLog } from '../src/modules/audit/auditLog.model';
import { Client } from '../src/modules/clients/client.model';
import { getStorage } from '../src/modules/files/storage';
import { Project } from '../src/modules/projects/project.model';
import { mergeFieldItems, type MediaItem } from '../src/modules/recce-review/recceReview.common';
import { RecceSubmission, UNIT_PHOTO_CATEGORIES } from '../src/modules/recce-review/recceReview.model';
import { syncAfterSubmit } from '../src/modules/recce-review/recceReview.units';
import { Site } from '../src/modules/sites/site.model';
import { User } from '../src/modules/users/user.model';
import { Vendor } from '../src/modules/vendors/vendor.model';

const MPIN = '2580';
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (name: string) => process.argv.includes(name);

type Plan = { code: string; name: string; district: string; areas: [string, string, number, number][]; shops: number; submitted: boolean };
const PROJECTS: Plan[] = [
  { code: 'DEMO-RECCE-001', name: 'Demo Retail – Madurai', district: 'Madurai', shops: 20, submitted: true, areas: [['Anna Nagar', '625020', 9.9195, 78.1424], ['KK Nagar', '625020', 9.9312, 78.1376], ['Simmakkal', '625001', 9.9252, 78.1198]] },
  { code: 'DEMO-RECCE-002', name: 'Demo Mobiles – Chennai', district: 'Chennai', shops: 30, submitted: true, areas: [['T.Nagar', '600017', 13.0418, 80.2341], ['Velachery', '600042', 12.9815, 80.218], ['Anna Nagar', '600040', 13.085, 80.2101]] },
  { code: 'DEMO-RECCE-003', name: 'Demo Paints – Coimbatore', district: 'Coimbatore', shops: 10, submitted: true, areas: [['RS Puram', '641002', 11.0081, 76.9497], ['Gandhipuram', '641012', 11.0183, 76.9725]] },
  { code: 'DEMO-RECCE-004', name: 'Demo Electricals – Trichy', district: 'Tiruchirappalli', shops: 20, submitted: true, areas: [['Thillai Nagar', '620018', 10.8269, 78.6845], ['Srirangam', '620006', 10.8624, 78.6898]] },
  { code: 'DEMO-RECCE-005', name: 'Demo Hardware – Salem', district: 'Salem', shops: 10, submitted: false, areas: [['Fairlands', '636016', 11.6729, 78.1385], ['Hasthampatti', '636007', 11.6696, 78.1532]] },
];

/* ---------------- deterministic random ---------------- */
let seed = 51208833;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

/* ---------------- tiny PNG (two-tone placeholder per photo category) ---------------- */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w: number, h: number, top: number[], bottom: number[], band: number[]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const inBoard = y > h * 0.38 && y < h * 0.5 && x > w * 0.15 && x < w * 0.85;
      raw.set(inBoard ? band : y < h * 0.35 ? top : bottom, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TONES: [number[], number[], number[]][] = [
  [[147, 197, 253], [120, 113, 108], [220, 38, 38]], [[186, 230, 253], [87, 83, 78], [37, 99, 235]], [[165, 180, 252], [168, 162, 158], [5, 150, 105]],
  [[191, 219, 254], [113, 113, 122], [217, 119, 6]], [[224, 242, 254], [64, 64, 64], [147, 51, 234]], [[203, 213, 225], [120, 53, 15], [220, 38, 38]], [[134, 239, 172], [82, 82, 91], [13, 148, 136]],
];

/* ---------------- demo content ---------------- */
const VENDORS = ['Ravi Signage Works', 'Kumar Recce Services', 'Sri Murugan Ads', 'Bright Boards', 'Velan Media', 'Annai Flex Works'];
const STAFF = ['Karthi R', 'Suresh K', 'Priya M', 'Arun S'];
const SHOPS = ['Sri Balaji Stores', 'Lakshmi Traders', 'Annai Supermarket', 'Murugan Agencies', 'Royal Paints', 'Kaveri Hardware', 'Selvam Electricals', 'New Star Mobiles', 'Ganesh Stores', 'Vetri Enterprises', 'Vinayaka Traders', 'Saravana Textiles'];
const QUESTIONS: [string, string, string[]][] = [
  ['existing_board', 'Is there an existing board at this position?', ['Yes', 'No']],
  ['mounting_surface', 'Mounting surface', ['Brick wall', 'Concrete', 'Glass', 'Metal sheet']],
  ['power_available', 'Is power available within 5 ft?', ['Yes', 'No']],
  ['visibility', 'Board visibility from the road', ['Clear', 'Partly blocked']],
  ['ladder_height', 'Installation height (ft)', ['8', '10', '12', '14']],
  ['remarks', 'Remarks', ['Shop owner agreed', 'Needs owner permission', 'No issues']],
];

async function main() {
  const csEmail = arg('--cs');
  const opsEmail = arg('--ops');
  if (!csEmail || !opsEmail) throw new Error('Pass both logins: --cs <client-servicing-email> --ops <operations-email>');
  if (!has('--apply')) {
    for (const p of PROJECTS) console.log(`${p.code}  ${p.shops} shops (${vendorShare(p.shops)} vendor / ${p.shops - vendorShare(p.shops)} in-house)  ${p.submitted ? 'submitted V1, OPS + CS pending' : 'not started'}`);
    console.log(`Dry run. Add --apply to save${has('--reset') ? ' (after removing the old demo data of these projects)' : ''}.`);
    return;
  }
  await connectDb();
  const cs = await User.findOne({ email: csEmail.toLowerCase(), role: 'CLIENT_SERVICING' });
  if (!cs) throw new Error(`No Client Servicing login with email ${csEmail}`);
  const ops = await User.findOne({ email: opsEmail.toLowerCase(), role: { $in: ['OPERATIONS', 'RECCE_COORDINATOR'] } });
  if (!ops) throw new Error(`No Operations login with email ${opsEmail}`);

  const client = (await Client.findOne({ code: 'DEMO' })) ?? (await Client.create({ name: 'Demo Client', code: 'DEMO', clientType: 'EXISTING' }));

  // Seven shared placeholder photos (one per unit photo category).
  const storage = getStorage();
  const files = new Map<string, Record<string, unknown>>();
  for (const [i, cat] of UNIT_PHOTO_CATEGORIES.entries()) {
    const [a, b, c] = TONES[i]!;
    const buf = png(480, 320, a, b, c);
    const key = `Recce_Review/Demo_Client/DEMO-RECCE/Photos/demo-${cat.toLowerCase()}.png`;
    await storage.put(key, buf, 'image/png');
    files.set(cat, { key, storage: storage.type, name: `demo-${cat.toLowerCase()}.png`, size: buf.length, mimeType: 'image/png', kind: 'image', sha256: createHash('sha256').update(buf).digest('hex') });
  }

  // Field teams shared by the projects: six vendor companies (one mobile login each) and four in-house recce executives.
  const hash = await hashMpin(MPIN);
  const vendors: { vendor: Types.ObjectId; login: Types.ObjectId }[] = [];
  for (const [i, name] of VENDORS.entries()) {
    const code = `VND-RVW${i + 1}`;
    const v = (await Vendor.findOne({ code })) ?? (await Vendor.create({ code, name, nameKey: name.toLowerCase(), type: 'ORGANIZATION', mobile: `90000300${String(i + 1).padStart(2, '0')}`, district: 'Chennai', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true, verifiedAt: new Date() } }));
    const email = `review.vendor${i + 1}@demo.invalid`;
    const u = (await User.findOne({ email })) ?? (await User.create({ name: `${name.split(' ')[0]} (login)`, email, phone: `90000300${String(i + 1).padStart(2, '0')}`, role: 'VENDOR', vendorId: v._id, authMethod: 'MPIN', mpinHash: hash }));
    vendors.push({ vendor: v._id, login: u._id });
  }
  const staff: Types.ObjectId[] = [];
  for (const [i, name] of STAFF.entries()) {
    const email = `review.staff${i + 1}@demo.invalid`;
    const u = (await User.findOne({ email })) ?? (await User.create({ name, email, phone: `90000400${String(i + 1).padStart(2, '0')}`, role: 'RECCE_EXECUTIVE', authMethod: 'MPIN', mpinHash: hash }));
    staff.push(u._id);
  }

  for (const [pi, plan] of PROJECTS.entries()) {
    let project = await Project.findOne({ code: plan.code });
    if (project && has('--reset')) {
      const subs = await RecceSubmission.find({ project: project._id }).select('_id').lean();
      await AuditLog.deleteMany({ entity: 'RecceSubmission', entityId: { $in: subs.map((s) => s._id) } });
      await RecceSubmission.deleteMany({ project: project._id });
      await Site.deleteMany({ project: project._id });
      console.log(`${plan.code}: old demo shops, submissions and timeline removed.`);
    } else if (project && (await Site.exists({ project: project._id }))) {
      console.log(`${plan.code} already has shops, skipped. Run with --reset to seed it again.`);
      continue;
    }
    const start = new Date(Date.now() - int(6, 14) * 86400_000);
    project ??= await Project.create({ code: plan.code, name: plan.name, client: client._id, requirementType: 'SHOP_MEASUREMENT', status: 'IN_PROGRESS', startDate: start, district: plan.district, createdBy: cs._id, assignedTo: ops._id, expectedShops: plan.shops });
    await Project.updateOne({ _id: project._id }, { $set: { createdBy: cs._id, assignedTo: ops._id, startDate: start, expectedShops: plan.shops } });

    // 60% vendor shops over three vendors, 40% in-house over two staff (a different pair per project).
    const vShops = vendorShare(plan.shops);
    const teamOf = (n: number): { channel: 'VENDOR' | 'IN_HOUSE'; vendor?: Types.ObjectId; login: Types.ObjectId } => {
      if (n < vShops) { const v = vendors[(pi * 3 + (n % 3)) % vendors.length]!; return { channel: 'VENDOR', vendor: v.vendor, login: v.login }; }
      return { channel: 'IN_HOUSE', login: staff[(pi * 2 + (n % 2)) % staff.length]! };
    };
    const logs: Record<string, unknown>[] = [];
    let submitted = 0;
    let units = 0;
    for (let n = 0; n < plan.shops; n++) {
      const seq = n + 1;
      const t = teamOf(n);
      const [location, pincode, lat0, lng0] = plan.areas[n % plan.areas.length]!;
      const allocatedAt = new Date(start.getTime() + int(0, 2) * 86400_000 + int(1, 8) * 3600_000);
      const lat = +(lat0 + (rnd() - 0.5) * 0.01).toFixed(6);
      const lng = +(lng0 + (rnd() - 0.5) * 0.01).toFixed(6);
      const site = await Site.create({
        project: project._id, seq, siteCode: `${plan.code}-S${String(seq).padStart(3, '0')}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `${pick(SHOPS)} ${seq}`, dealerName: `Dealer ${seq}`,
        district: plan.district, location, pincode, address1: `${int(1, 120)}, ${location} Main Road`, lat, lng, geoQuality: 'GPS', boardType: 'GSP Board',
        channel: t.channel, ...(t.vendor ? { vendor: t.vendor } : {}), allocatedAt, allocatedBy: ops._id, assignedTo: t.login, assignedToAt: allocatedAt, assignedToBy: ops._id,
      });
      if (!plan.submitted) continue;
      units += await seedSubmission({ projectId: project._id, site: site._id, siteCode: `${plan.code}-S${String(seq).padStart(3, '0')}`, channel: t.channel, vendor: t.vendor, assignee: t.login, files, lat, lng, from: allocatedAt, logs });
      submitted++;
    }
    if (logs.length) await AuditLog.insertMany(logs);
    await Project.updateOne({ _id: project._id }, { siteCount: plan.shops });
    console.log(`${plan.code}: ${plan.shops} shops (${vShops} vendor / ${plan.shops - vShops} in-house), ${submitted} submitted, ${units} units waiting for OPS + CS.`);
  }
  console.log(`Done. Review as ${csEmail} (CS) and ${opsEmail} (OPS). Field logins: review.vendor1..6 / review.staff1..4 @demo.invalid, MPIN ${MPIN}.`);
  await disconnectDb();
}

const vendorShare = (shops: number) => Math.round(shops * 0.6);

/* ---------------- one shop: flat field record (V1 submitted) → real unit sync ---------------- */
type Ctx = { projectId: Types.ObjectId; site: Types.ObjectId; siteCode: string; channel: string; vendor?: Types.ObjectId | undefined; assignee: Types.ObjectId; files: Map<string, Record<string, unknown>>; lat: number; lng: number; from: Date; logs: Record<string, unknown>[] };

async function seedSubmission(c: Ctx): Promise<number> {
  const subId = new Types.ObjectId();
  const hour = 3600_000;
  let clock = c.from.getTime() + int(4, 20) * hour;
  const at = (plusHours: number) => new Date((clock += plusHours * hour));
  const fieldRole = c.channel === 'VENDOR' ? 'VENDOR' : 'RECCE_EXECUTIVE';
  const log = (action: string, when: Date, version: number | null) =>
    c.logs.push({ user: c.assignee, role: fieldRole, action, entity: 'RecceSubmission', entityId: subId, project: c.projectId, changes: [], meta: { site: c.site, mediaKey: null, photo: null, version, visibility: 'ALL' }, at: when });

  // Media lines as the field app sends them: GSP single always, GSP double and Vinyl on some shops; one unit per quantity.
  const lines: { key: string; name: string; qty: number; sided: 'SINGLE' | 'DOUBLE'; vinyl: boolean }[] = [{ key: 'm1', name: 'GSP Board', qty: int(1, 2), sided: 'SINGLE', vinyl: false }];
  if (rnd() < 0.5) lines.push({ key: 'm2', name: 'GSP Board', qty: 1, sided: 'DOUBLE', vinyl: false });
  if (rnd() < 0.5) lines.push({ key: 'm3', name: 'Vinyl', qty: int(1, 2), sided: 'SINGLE', vinyl: true });
  const flat = lines.map((l) => {
    const units = Array.from({ length: l.qty }, (_, i) => ({
      key: `${l.key}-u${i + 1}`, unitNo: i + 1, width: l.vinyl ? pick([3, 4, 5, 6]) : pick([6, 8, 10, 12]), height: l.vinyl ? pick([2, 3]) : pick([2, 3, 4]), unit: 'FT',
      answers: QUESTIONS.map(([key, question, opts]) => ({ key, question, answer: l.vinyl && key === 'mounting_surface' ? pick(['Glass', 'Concrete']) : pick(opts) })),
    }));
    return { key: l.key, name: l.name, quantity: l.qty, width: units[0]!.width, height: units[0]!.height, unit: 'FT', sided: l.sided, condition: 'PROPOSED', units };
  });
  // The stored draft (units), with the installation type the reviewer sees.
  const stored = mergeFieldItems([], flat as MediaItem[]);
  for (const m of stored) for (const u of m.units) u.installationType = m.mediaType === 'VINYL' ? pick(['GLASS_PASTING', 'WALL_PASTING']) : m.sideType === 'DOUBLE' ? 'PROJECTION_MOUNT' : pick(['WALL_MOUNT', 'WALL_MOUNT', 'ROOF_TOP']);

  const started = at(0);
  log('SHOP_VISIT_STARTED', started, null);
  const photos: Record<string, unknown>[] = [];
  let order = 0;
  for (const m of flat) for (const u of m.units) for (const category of UNIT_PHOTO_CATEGORIES) {
    const when = at(0.03);
    photos.push({
      _id: new Types.ObjectId(), mediaKey: m.key, unitKey: u.key, category, caption: '', order: order++, state: 'SUBMITTED',
      original: { fileId: new Types.ObjectId(), ...c.files.get(category), uploadedBy: c.assignee, uploadedAt: when },
      capturedAt: when, lat: +(c.lat + (rnd() - 0.5) * 0.0004).toFixed(6), lng: +(c.lng + (rnd() - 0.5) * 0.0004).toFixed(6), gpsAccuracy: int(3, 15), source: 'LIVE_CAMERA', device: 'Demo phone', width: 480, height: 320, flags: [],
      uploadedBy: c.assignee, version: 1, createdAt: when,
    });
  }
  log('PHOTO_CAPTURED', new Date(clock), null);

  const installation = { ladderRequired: 'YES', scaffoldingRequired: pick(['YES', 'NO']), craneRequired: 'NO', hydraRequired: 'NO', manualInstallationPossible: 'YES', electricalAccess: pick(['AVAILABLE', 'NOT_AVAILABLE']), notes: '' };
  const v1At = at(1);
  const dueAt = new Date(v1At.getTime() + 24 * hour);
  await RecceSubmission.create({
    _id: subId, project: c.projectId, site: c.site, assignee: c.assignee, channel: c.channel, ...(c.vendor ? { vendor: c.vendor } : {}),
    mediaItems: stored, notes: '', installation, startedAt: started, photos,
    status: 'SUBMITTED', currentVersion: 1, submittedAt: v1At, attempts: 1, pendingStage: 'OPS', dueAt,
    versions: [{ version: 1, submittedBy: c.assignee, submittedAt: v1At, photos: photos.map((p) => p._id), added: photos.map((p) => p._id), removed: [], mediaItems: flat, notes: '', installation, stages: ['OPS', 'CS'], sequential: false, dueAt, idempotencyKey: `demo-${c.siteCode}-v1` }],
    reviews: [{ versionNo: 1, stage: 'OPS' }, { versionNo: 1, stage: 'CS' }],
  });
  log('SUBMISSION_CREATED', v1At, 1);
  // The real unit sync: every unit gets V1 with OPS and CS pending.
  await syncAfterSubmit(subId);
  return flat.reduce((a, m) => a + m.units.length, 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
