/**
 * Dev data for Project Tracking (Client Servicing): one project of 50 shops, 30 given to 6 vendors (5 each) and 20 to 5 in-house
 * staff (4 each), with real recce submissions in `reccesubmissions`: the field record (units, 7 photos per unit, width / height,
 * answers) is synced into mediaItems[].units (photos / versions / reviews / reworks per unit) and decided unit by unit with the real review functions (OPS / CS approve, CS rejects
 * one unit's photo / width, the field person resubmits that unit as V2). Timeline events go to AuditLog.
 *   Dry run:  npx tsx scripts/seed-project-tracking-demo.ts --cs <client-servicing-login-email>
 *   Apply:    npx tsx scripts/seed-project-tracking-demo.ts --cs <email> --apply
 *   Re-seed:  add --reset (removes ONLY this demo project's shops, submissions and timeline first)
 * The project is created by the given Client Servicing login, so it appears in their Project Tracking. Seven small PNG files are
 * stored once and shared by every demo photo. Remove everything with: npx tsx scripts/purge-projects.ts --code DEMO-TRACK-001 --apply
 * Demo field logins use MPIN 2580 (emails end with @demo.invalid).
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
import type { Actor } from '../src/common/query';
import { getConfig, mergeFieldItems, type MediaItem } from '../src/modules/recce-review/recceReview.common';
import { RecceSubmission, UNIT_PHOTO_CATEGORIES, type ReviewStage } from '../src/modules/recce-review/recceReview.model';
import { applyUnitDecisions, syncAfterSubmit, type UnitDecisionInput } from '../src/modules/recce-review/recceReview.units';
import { Site } from '../src/modules/sites/site.model';
import { User } from '../src/modules/users/user.model';
import { Vendor } from '../src/modules/vendors/vendor.model';

const CODE = 'DEMO-TRACK-001';
const MPIN = '2580';
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (name: string) => process.argv.includes(name);

/* ---------------- deterministic random ---------------- */
let seed = 22069851;
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
      const c = inBoard ? band : y < h * 0.35 ? top : bottom;
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
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
const STAFF = ['Karthi R', 'Suresh K', 'Priya M', 'Arun S', 'Deepa V'];
const SHOPS = ['Sri Balaji Stores', 'Lakshmi Traders', 'Annai Supermarket', 'Murugan Agencies', 'Royal Paints', 'Kaveri Hardware', 'Selvam Electricals', 'New Star Mobiles', 'Ganesh Stores', 'Vetri Enterprises'];
const AREAS: [string, string, string, number, number][] = [
  ['Chennai', 'T.Nagar', '600017', 13.0418, 80.2341], ['Chennai', 'Mylapore', '600004', 13.0336, 80.2687], ['Chennai', 'Adyar', '600020', 13.0012, 80.2565],
  ['Chennai', 'Velachery', '600042', 12.9815, 80.218], ['Chennai', 'Anna Nagar', '600040', 13.085, 80.2101],
];
const QUESTIONS: [string, string, string[]][] = [
  ['existing_board', 'Is there an existing board at this position?', ['Yes', 'No']],
  ['mounting_surface', 'Mounting surface', ['Brick wall', 'Concrete', 'Glass', 'Metal sheet']],
  ['power_available', 'Is power available within 5 ft?', ['Yes', 'No']],
  ['visibility', 'Board visibility from the road', ['Clear', 'Partly blocked']],
  ['ladder_height', 'Installation height (ft)', ['8', '10', '12', '14']],
  ['remarks', 'Remarks', ['Shop owner agreed', 'Needs owner permission', 'No issues']],
];
type Flow = 'NOT_STARTED' | 'IN_PROGRESS' | 'UNDER_REVIEW' | 'APPROVED' | 'REWORK' | 'V2_APPROVED' | 'V2_REVIEW' | 'OPS_ONLY';
const FLOWS: [Flow, number][] = [['NOT_STARTED', 5], ['IN_PROGRESS', 3], ['UNDER_REVIEW', 5], ['OPS_ONLY', 3], ['APPROVED', 14], ['REWORK', 4], ['V2_APPROVED', 4], ['V2_REVIEW', 2]];
const flowOf = () => { const total = FLOWS.reduce((a, [, w]) => a + w, 0); let r = rnd() * total; for (const [f, w] of FLOWS) { if ((r -= w) < 0) return f; } return 'APPROVED'; };

async function main() {
  const csEmail = arg('--cs');
  if (!csEmail) throw new Error('Pass the Client Servicing login: --cs <email>');
  if (!has('--apply')) {
    console.log(`Dry run. Would create project ${CODE} (50 shops: 6 vendors x 5, 5 in-house staff x 4) owned by ${csEmail}, with recce submissions. Add --apply to save${has('--reset') ? ' (after removing the old demo data)' : ''}.`);
    return;
  }
  await connectDb();
  const cs = await User.findOne({ email: csEmail.toLowerCase(), role: 'CLIENT_SERVICING' });
  if (!cs) throw new Error(`No Client Servicing login with email ${csEmail}`);
  const ops = (await User.findOne({ role: 'OPERATIONS', isActive: { $ne: false } })) ?? cs;

  const client = (await Client.findOne({ code: 'DEMO' })) ?? (await Client.create({ name: 'Demo Client', code: 'DEMO', clientType: 'EXISTING' }));
  let project = await Project.findOne({ code: CODE });
  if (project && has('--reset')) {
    const subs = await RecceSubmission.find({ project: project._id }).select('_id').lean();
    await AuditLog.deleteMany({ entity: 'RecceSubmission', entityId: { $in: subs.map((s) => s._id) } });
    await RecceSubmission.deleteMany({ project: project._id });
    await Site.deleteMany({ project: project._id });
    console.log('Old demo shops, submissions and timeline removed.');
  } else if (project && (await Site.exists({ project: project._id }))) {
    console.log(`${CODE} already has shops. Run with --reset to seed it again.`);
    await disconnectDb();
    return;
  }
  const start = new Date(Date.now() - 12 * 86400_000);
  project ??= await Project.create({ code: CODE, name: 'Demo Lifestyle – T.Nagar', client: client._id, requirementType: 'SHOP_MEASUREMENT', status: 'IN_PROGRESS', startDate: start, district: 'Chennai', createdBy: cs._id, expectedShops: 50 });
  await Project.updateOne({ _id: project._id }, { $set: { createdBy: cs._id, startDate: start } });

  // Seven shared placeholder photos (one per unit photo category).
  const storage = getStorage();
  const files = new Map<string, Record<string, unknown>>();
  for (const [i, cat] of UNIT_PHOTO_CATEGORIES.entries()) {
    const [a, b, c] = TONES[i]!;
    const buf = png(480, 320, a, b, c);
    const key = `Recce_Review/Demo_Client/${CODE}/Photos/demo-${cat.toLowerCase()}.png`;
    await storage.put(key, buf, 'image/png');
    files.set(cat, { key, storage: storage.type, name: `demo-${cat.toLowerCase()}.png`, size: buf.length, mimeType: 'image/png', kind: 'image', sha256: createHash('sha256').update(buf).digest('hex') });
  }

  // Teams: vendor companies with one mobile login each, and in-house recce executives.
  const hash = await hashMpin(MPIN);
  const teams: { channel: 'VENDOR' | 'IN_HOUSE'; vendor?: Types.ObjectId; login: Types.ObjectId; shops: number }[] = [];
  for (const [i, name] of VENDORS.entries()) {
    const code = `VND-TRK${i + 1}`;
    const v = (await Vendor.findOne({ code })) ?? (await Vendor.create({ code, name, nameKey: name.toLowerCase(), type: 'ORGANIZATION', mobile: `90000100${String(i + 1).padStart(2, '0')}`, district: 'Chennai', status: 'ACTIVE', kyc: { pan: true, gst: true, bank: true, address: true, verifiedAt: new Date() } }));
    const email = `track.vendor${i + 1}@demo.invalid`;
    const u = (await User.findOne({ email })) ?? (await User.create({ name: `${name.split(' ')[0]} (login)`, email, phone: `90000100${String(i + 1).padStart(2, '0')}`, role: 'VENDOR', vendorId: v._id, authMethod: 'MPIN', mpinHash: hash }));
    teams.push({ channel: 'VENDOR', vendor: v._id, login: u._id, shops: 5 });
  }
  for (const [i, name] of STAFF.entries()) {
    const email = `track.staff${i + 1}@demo.invalid`;
    const u = (await User.findOne({ email })) ?? (await User.create({ name, email, phone: `90000200${String(i + 1).padStart(2, '0')}`, role: 'RECCE_EXECUTIVE', authMethod: 'MPIN', mpinHash: hash }));
    teams.push({ channel: 'IN_HOUSE', login: u._id, shops: 4 });
  }

  let seq = 0;
  const logs: Record<string, unknown>[] = [];
  for (const t of teams) {
    for (let n = 0; n < t.shops; n++) {
      seq++;
      const [district, location, pincode, lat0, lng0] = AREAS[seq % AREAS.length]!;
      const allocatedAt = new Date(start.getTime() + int(0, 2) * 86400_000 + int(1, 8) * 3600_000);
      const lat = +(lat0 + (rnd() - 0.5) * 0.01).toFixed(6);
      const lng = +(lng0 + (rnd() - 0.5) * 0.01).toFixed(6);
      const site = await Site.create({
        project: project._id, seq, siteCode: `${CODE}-S${String(seq).padStart(3, '0')}`, scenario: 'MEASUREMENT_REQUIRED', shopName: `${pick(SHOPS)} ${seq}`, dealerName: `Dealer ${seq}`,
        district, location, pincode, address1: `${int(1, 120)}, ${location} Main Road`, lat, lng, geoQuality: 'GPS', boardType: 'GSP Board',
        channel: t.channel, ...(t.vendor ? { vendor: t.vendor } : {}), allocatedAt, allocatedBy: ops._id, assignedTo: t.login, assignedToAt: allocatedAt, assignedToBy: ops._id,
      });
      const flow = flowOf();
      if (flow === 'NOT_STARTED') continue;
      await seedSubmission({ projectId: project._id, site: site._id, channel: t.channel, vendor: t.vendor, assignee: t.login, cs: cs._id, ops: ops._id, flow, files, lat, lng, from: allocatedAt, logs });
    }
  }
  if (logs.length) await AuditLog.insertMany(logs);
  await Project.updateOne({ _id: project._id }, { siteCount: seq });
  console.log(`Done. ${CODE}: ${seq} shops. Open Project Tracking as ${csEmail}. Field logins: track.vendor1..6 / track.staff1..5 @demo.invalid, MPIN ${MPIN}.`);
  await disconnectDb();
}

/* ---------------- one shop's submission (flat field record → real unit sync → real unit decisions) ---------------- */
type Ctx = { projectId: Types.ObjectId; site: Types.ObjectId; channel: string; vendor?: Types.ObjectId | undefined; assignee: Types.ObjectId; cs: Types.ObjectId; ops: Types.ObjectId; flow: Flow; files: Map<string, Record<string, unknown>>; lat: number; lng: number; from: Date; logs: Record<string, unknown>[] };

let checklist: { key: string; passed: boolean }[] | null = null;

async function seedSubmission(c: Ctx) {
  checklist ??= (await getConfig()).checklist.map((x) => ({ key: String(x.key), passed: true }));
  const subId = new Types.ObjectId();
  const hour = 3600_000;
  let clock = c.from.getTime() + int(4, 20) * hour;
  const at = (plusHours: number) => new Date((clock += plusHours * hour));
  const log = (user: Types.ObjectId, role: string, action: string, when: Date, version: number | null) =>
    c.logs.push({ user, role, action, entity: 'RecceSubmission', entityId: subId, project: c.projectId, changes: [], meta: { site: c.site, mediaKey: null, photo: null, version, visibility: 'ALL' }, at: when });
  const fieldRole = c.channel === 'VENDOR' ? 'VENDOR' : 'RECCE_EXECUTIVE';
  const csActor: Actor = { id: String(c.cs), role: 'CLIENT_SERVICING' };
  const opsActor: Actor = { id: String(c.ops), role: 'OPERATIONS' };

  // Board lines with their units, as the field app will send them (units[] + photos[].unitKey).
  const lines: { key: string; name: string; qty: number; sided: 'SINGLE' | 'DOUBLE' }[] = [{ key: 'm1', name: 'GSP Board – Single Slide', qty: int(1, 2), sided: 'SINGLE' }];
  if (rnd() < 0.5) lines.push({ key: 'm2', name: 'GSP Board – Double Slide', qty: 1, sided: 'DOUBLE' });
  if (rnd() < 0.3) lines.push({ key: 'm3', name: 'Name Board (Flex)', qty: 1, sided: 'SINGLE' });
  const mediaItems = lines.map((l) => {
    const units = Array.from({ length: l.qty }, (_, i) => ({
      key: `${l.key}-u${i + 1}`, unitNo: i + 1, width: pick([4, 6, 8, 10, 12]), height: pick([2, 3, 4]), unit: 'FT',
      answers: QUESTIONS.map(([key, question, opts]) => ({ key, question, answer: pick(opts) })),
    }));
    return { key: l.key, name: l.name, quantity: l.qty, width: units[0]!.width, height: units[0]!.height, unit: 'FT', sided: l.sided, condition: 'PROPOSED', units };
  });

  const started = at(0);
  log(c.assignee, fieldRole, 'SHOP_VISIT_STARTED', started, null);
  const photos: Record<string, unknown>[] = [];
  const photoOf = (mediaKey: string, unitKey: string, category: string, version: number, when: Date, order: number) => {
    const p: Record<string, unknown> = { _id: new Types.ObjectId(), mediaKey, unitKey, category, caption: '', order, state: 'SUBMITTED', original: { fileId: new Types.ObjectId(), ...c.files.get(category), uploadedBy: c.assignee, uploadedAt: when }, capturedAt: when, lat: +(c.lat + (rnd() - 0.5) * 0.0004).toFixed(6), lng: +(c.lng + (rnd() - 0.5) * 0.0004).toFixed(6), gpsAccuracy: int(3, 15), source: 'LIVE_CAMERA', device: 'Demo phone', width: 480, height: 320, flags: [], uploadedBy: c.assignee, version, createdAt: when };
    photos.push(p);
    return p;
  };
  let order = 0;
  for (const m of mediaItems) for (const u of m.units) for (const cat of UNIT_PHOTO_CATEGORIES) photoOf(m.key, u.key, cat, 1, at(0.05), order++);
  log(c.assignee, fieldRole, 'PHOTO_CAPTURED', new Date(clock), null);

  const base = { _id: subId, project: c.projectId, site: c.site, assignee: c.assignee, channel: c.channel, ...(c.vendor ? { vendor: c.vendor } : {}), mediaItems: mergeFieldItems([], mediaItems as MediaItem[]), notes: '', startedAt: started, photos, attempts: 0 };
  if (c.flow === 'IN_PROGRESS') {
    for (const p of photos) { p.state = 'DRAFT'; delete p.version; }
    await RecceSubmission.create({ ...base, status: 'IN_PROGRESS', currentVersion: 0 });
    return;
  }

  // Version 1 submitted by the field person (what the field submit API writes), then the real unit sync.
  const v1At = at(1);
  const snapshot = () => JSON.parse(JSON.stringify(mediaItems));
  await RecceSubmission.create({
    ...base, status: 'SUBMITTED', currentVersion: 1, submittedAt: v1At, attempts: 1, pendingStage: 'OPS', dueAt: new Date(v1At.getTime() + 24 * hour),
    versions: [{ version: 1, submittedBy: c.assignee, submittedAt: v1At, photos: photos.map((p) => p._id), added: photos.map((p) => p._id), removed: [], mediaItems: snapshot(), notes: '', stages: ['OPS', 'CS'], sequential: false, dueAt: new Date(v1At.getTime() + 24 * hour) }],
    reviews: [{ versionNo: 1, stage: 'OPS' }, { versionNo: 1, stage: 'CS' }],
  });
  log(c.assignee, fieldRole, 'SUBMISSION_CREATED', v1At, 1);
  await syncAfterSubmit(subId);

  type U = { boardKey: string; unitKey: string; unitNo: number; versionNo: number; status: string; photos: string[] };
  const unitsNow = async (): Promise<U[]> => {
    const doc = await RecceSubmission.findById(subId).select('mediaItems').lean<{ mediaItems?: { mediaKey: string; units: { unitId: string; unitNo: number; currentVersion: number; status: string; versions: { photoIds: unknown[] }[] }[] }[] }>().exec();
    return (doc?.mediaItems ?? []).flatMap((m) => m.units.map((u) => ({ boardKey: m.mediaKey, unitKey: u.unitId, unitNo: u.unitNo, versionNo: u.currentVersion, status: u.status, photos: (u.versions.at(-1)?.photoIds ?? []).map(String) })));
  };
  const refs = (l: U[]) => l.map(({ boardKey, unitKey, versionNo }) => ({ boardKey, unitKey, versionNo }));
  const decide = async (actor: Actor, stage: ReviewStage, decision: 'APPROVE' | 'REJECT', list: U[], extra: Partial<UnitDecisionInput> = {}) => {
    if (!list.length) return;
    await applyUnitDecisions(subId, actor, stage, { decision, units: refs(list), comment: '', checklist: decision === 'APPROVE' ? checklist! : [], items: [], ...extra }, { notify: false, at: at(int(2, 8)) });
  };

  if (c.flow === 'UNDER_REVIEW') return;
  let units = await unitsNow();
  await decide(opsActor, 'OPS', 'APPROVE', units);
  if (c.flow === 'OPS_ONLY') return;
  if (c.flow === 'APPROVED') { await decide(csActor, 'CS', 'APPROVE', units); return; }

  // REWORK / V2: CS approves every unit except the last one, which it rejects (a photo, sometimes the width too).
  const target = units.at(-1)!;
  const photoId = pick(target.photos.slice(1));
  const withMeasure = rnd() < 0.6;
  const reason = pick(['Image not clear', 'Wrong angle', 'Board not fully visible']);
  await decide(csActor, 'CS', 'APPROVE', units.slice(0, -1));
  await decide(csActor, 'CS', 'REJECT', [target], {
    comment: `${reason}${withMeasure ? '; width looks wrong' : ''}`,
    rejectMode: withMeasure ? 'BOTH' : 'PHOTO',
    items: [{ boardKey: target.boardKey, unitKey: target.unitKey, kind: 'PHOTO', ref: photoId, reason }, ...(withMeasure ? [{ boardKey: target.boardKey, unitKey: target.unitKey, kind: 'MEASUREMENT' as const, field: 'width' as const, reason: 'Recheck width' }] : [])],
  });
  if (c.flow === 'REWORK') return;

  // Resubmission (what the field app does): the rejected photo is replaced (the old one stays SUPERSEDED), the width is corrected.
  const v2At = at(int(6, 20));
  const old = photos.find((p) => String(p._id) === photoId)!;
  const np = photoOf(String(old.mediaKey), String(old.unitKey), String(old.category), 2, v2At, Number(old.order));
  np.replaces = old._id;
  const m = mediaItems.find((x) => x.key === target.boardKey)!;
  const u = m.units.find((x) => x.unitNo === target.unitNo)!;
  if (withMeasure) { u.width += 2; if (u.unitNo === 1) m.width = u.width; }
  const v2Photos = photos.filter((p) => p !== old && p.state === 'SUBMITTED').map((p) => p._id);
  // The field draft save merges the corrected lines into the stored units (only the sent-back unit changes).
  const storedNow = (await RecceSubmission.findById(subId).select('mediaItems').lean())?.mediaItems ?? [];
  await RecceSubmission.updateOne({ _id: subId }, {
    $set: { status: 'SUBMITTED', currentVersion: 2, submittedAt: v2At, attempts: 2, pendingStage: 'OPS', mediaItems: mergeFieldItems(storedNow, mediaItems as MediaItem[]), notes: 'Corrected as asked', 'reworks.$[w].status': 'RESOLVED', 'reworks.$[w].resolvedAt': v2At, 'reworks.$[w].items.$[].resolved': true, 'reworks.$[w].items.$[].resolvedInVersion': 2, 'photos.$[o].state': 'SUPERSEDED', 'photos.$[o].supersededBy': np._id },
    $push: { photos: np, versions: { version: 2, submittedBy: c.assignee, submittedAt: v2At, photos: v2Photos, added: [np._id], removed: [old._id], mediaItems: snapshot(), notes: 'Corrected as asked', stages: ['OPS', 'CS'], sequential: false, dueAt: new Date(v2At.getTime() + 24 * hour) }, reviews: { $each: [{ versionNo: 2, stage: 'OPS' }, { versionNo: 2, stage: 'CS' }] } },
    $inc: { rev: 1 },
  }, { arrayFilters: [{ 'w.status': 'OPEN' }, { 'o._id': old._id }] });
  log(c.assignee, fieldRole, 'REWORK_SUBMITTED', v2At, 2);
  await syncAfterSubmit(subId);
  if (c.flow === 'V2_REVIEW') return;
  units = (await unitsNow()).filter((x) => x.status === 'SUBMITTED');
  await decide(opsActor, 'OPS', 'APPROVE', units);
  await decide(csActor, 'CS', 'APPROVE', units);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
