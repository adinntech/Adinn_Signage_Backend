import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { objectId, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { Project } from '../projects/project.model';
import { User } from '../users/user.model';
import { Vendor } from '../vendors/vendor.model';
import { DEFAULT_RATES, calcTrip, calcVendorCost, type Rates } from './recceCost.calc';
import { LEG_MODES, MISC_TYPES, RecceRateConfig, RecceTrip, STAY_ORIGINS, VEHICLE_TYPES, VendorRecceCost, VendorRecceRateCard } from './recceCost.model';

const money = z.coerce.number().min(0).max(1_000_000);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const meal = z.object({ from: hhmm, to: hhmm, amount: money }).refine((m) => m.from < m.to, { message: 'Window end must be after start' });

// ---------- Rates (Admin) ----------
export const rateBody = z.object({
  effectiveFrom: z.coerce.date(),
  kmRate: money,
  breakfast: meal,
  lunch: meal,
  dinner: meal,
  dailyFoodMax: money,
  mealMinOverlapMinutes: z.coerce.number().int().min(0).max(600),
  stayDistanceKm: money,
  stayDurationHours: z.coerce.number().min(0).max(240),
  stayPerNight: money,
  stayMaxAmount: money,
  stayOrigin: z.enum(STAY_ORIGINS).default('OFFICE'),
  receiptRequiredAbove: money,
  adminApprovalAbove: money,
  maxTripKm: z.coerce.number().min(1).max(10_000),
  note: z.string().trim().max(300).optional(),
});

const RATE_KEYS = Object.keys(DEFAULT_RATES) as (keyof Rates)[];
const pickRates = (d: Record<string, any>): Rates => Object.fromEntries(RATE_KEYS.map((k) => [k, d[k] instanceof Object && !(d[k] instanceof Date) ? { from: d[k].from, to: d[k].to, amount: d[k].amount } : d[k]])) as unknown as Rates;

/** The rate version in force at a date (the newest one that started on or before it); company defaults if none was saved. */
export async function ratesAt(at: Date = new Date()): Promise<{ rates: Rates; version: string | null; effectiveFrom: Date | null }> {
  const v = await RecceRateConfig.findOne({ effectiveFrom: { $lte: at } }).sort({ effectiveFrom: -1, createdAt: -1 }).lean();
  return v ? { rates: pickRates(v), version: String(v._id), effectiveFrom: v.effectiveFrom } : { rates: DEFAULT_RATES, version: null, effectiveFrom: null };
}
export async function rateHistory() {
  return RecceRateConfig.find().sort({ effectiveFrom: -1, createdAt: -1 }).populate('createdBy', 'name').lean();
}
export async function saveRates(body: z.infer<typeof rateBody>, actor: Actor) {
  const v = await RecceRateConfig.create({ ...body, createdBy: actor.id });
  await recordAudit({ actor, action: 'RECCE_RATE_CHANGE', entity: 'RecceRateConfig', entityId: v._id, reason: `Km ₹${body.kmRate}, effective ${body.effectiveFrom.toISOString().slice(0, 10)}` });
  return v.toObject();
}

// ---------- Trips ----------
const gpsBody = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), accuracy: z.coerce.number().min(0).max(100_000).optional(), address: z.string().trim().max(200).optional() });
const odoBody = z.object({ reading: z.coerce.number().min(0).max(9_999_999), photoFileId: objectId.optional(), gps: gpsBody.optional(), capturedAt: z.coerce.date().optional() });

export const tripBody = z.object({
  projectId: objectId,
  startAt: z.coerce.date(),
  endAt: z.coerce.date().optional(),
  transportType: z.enum(['PUBLIC', 'PRIVATE']),
  legs: z.array(z.object({
    from: z.string().trim().min(1).max(120), to: z.string().trim().min(1).max(120), district: z.string().trim().max(80).optional(),
    mode: z.enum(LEG_MODES), at: z.coerce.date(), amount: money, receiptFileId: objectId.optional(), remarks: z.string().trim().max(300).optional(),
  })).max(60).default([]),
  vehicle: z.object({ type: z.enum(VEHICLE_TYPES), regNo: z.string().trim().max(20).optional() }).optional(),
  odoStart: odoBody.optional(),
  odoEnd: odoBody.optional(),
  misc: z.array(z.object({
    type: z.enum(MISC_TYPES), date: z.coerce.date(), amount: z.coerce.number().min(0.01).max(1_000_000), description: z.string().trim().max(200).optional(), remarks: z.string().trim().max(300).optional(),
    receiptFileId: objectId.optional(), site: objectId.optional(), shopRef: z.string().trim().max(120).optional(),
  })).max(60).default([]),
  stayOrigin: z.enum(STAY_ORIGINS).optional(),
  startLocation: z.string().trim().max(200).optional(),
  destination: z.string().trim().max(200).optional(),
  manualDistanceKm: z.coerce.number().min(0).max(10_000).optional(),
  manualDistanceEvidence: z.string().trim().max(300).optional(),
  estimatedTravelHours: z.coerce.number().min(0).max(240).optional(),
  stayNights: z.coerce.number().int().min(0).max(60).optional(),
  stayClaimed: money.optional(),
  stayBillFileId: objectId.optional(),
  stayRemarks: z.string().trim().max(300).optional(),
  foodClaimed: money.optional(),
  foodRemarks: z.string().trim().max(300).optional(),
}).refine((v) => !v.endAt || v.endAt > v.startAt, { path: ['endAt'], message: 'End time must be after the start time' });
export type TripBody = z.infer<typeof tripBody>;

export const reviewBody = z.object({
  action: z.enum(['START_REVIEW', 'APPROVE', 'REJECT', 'SETTLE']),
  remark: z.string().trim().max(500).optional(),
  /** Reviewer's own figures per component; changing any of them needs a remark. */
  approved: z.object({ transport: money, food: money, stay: money, misc: money }).partial().optional(),
  stayException: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
});

async function assertFiles(projectId: string, ids: (string | undefined)[]) {
  for (const id of ids.filter(Boolean) as string[]) {
    const ok = await Project.exists({ _id: projectId, files: { $elemMatch: { _id: id, category: 'RECCE_EXPENSE', deletedAt: null } } });
    if (!ok) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'receiptFileId', message: 'Upload the file first (Expenses category) and attach it here' }]);
  }
}

const isEditable = (status: string) => status === 'DRAFT' || status === 'REJECTED';
const legacy = (d: any) => d.toObject?.() ?? d;

function recompute(t: any, rates: Rates) {
  const c = calcTrip(
    {
      transportType: t.transportType, startAt: t.startAt, endAt: t.endAt, legs: t.legs, odoStart: t.odoStart, odoEnd: t.odoEnd, misc: t.misc,
      manualDistanceKm: t.manualDistanceKm, estimatedTravelHours: t.estimatedTravelHours, stayNights: t.stayNights || undefined,
      stayClaimed: t.stayClaimed, stayException: !!t.stayException?.approved, foodClaimed: t.foodClaimed,
    },
    rates,
  );
  t.calc = c;
  t.flags = c.flags;
}

export async function saveTrip(id: string | null, body: TripBody, actor: Actor) {
  const project = await Project.findOne({ _id: body.projectId, deletedAt: null }).select('code client').lean();
  if (!project) throw AppError.notFound('Project not found');
  await assertNotCancelled(body.projectId);
  await assertFiles(body.projectId, [...body.legs.map((l) => l.receiptFileId), ...body.misc.map((m) => m.receiptFileId), body.odoStart?.photoFileId, body.odoEnd?.photoFileId, body.stayBillFileId]);
  const { rates } = await ratesAt(body.startAt);
  const client = await Client.findById(project.client).select('code').lean();
  const user = await User.findById(actor.id).select('name').lean();

  let t = id ? await RecceTrip.findById(id) : null;
  if (id && !t) throw AppError.notFound('Trip not found');
  if (t) {
    if (String(t.employee) !== actor.id && actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the employee who made this claim can edit it');
    if (!isEditable(t.status)) throw AppError.conflict('Only a draft or rejected claim can be edited');
  }
  const now = new Date();
  const stamp = (o: any) => (o ? { ...o, uploadedAt: o.photoFileId ? now : undefined } : undefined);
  const data = {
    ...body, project: body.projectId, client: project.client, clientCode: client?.code, projectCode: project.code,
    odoStart: stamp(body.odoStart), odoEnd: stamp(body.odoEnd),
    vehicle: body.vehicle ? { type: body.vehicle.type, regNo: body.vehicle.regNo } : undefined,
  };
  delete (data as any).projectId;
  const history: any[] = [];
  if (!t) t = new RecceTrip({ ...data, employee: actor.id, employeeName: user?.name, history: [] });
  else { t.set(data); }
  if (body.transportType === 'PUBLIC') { t.odoStart = undefined as any; t.odoEnd = undefined as any; t.vehicle = undefined as any; }
  else t.legs.splice(0, t.legs.length);
  recompute(t, rates);
  // The employee may claim up to the suggestion; anything above needs a remark.
  const calc = t.calc as any;
  if (calc.food.claimed > calc.food.suggested && !body.foodRemarks) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'foodRemarks', message: 'Explain why the food claim is above the suggested allowance' }]);
  if (calc.stay.claimed > 0 && !calc.stay.eligible && !t.stayException?.approved) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'stayClaimed', message: `Stay is not allowed: ${calc.stay.reason}` }]);
  if (calc.stay.claimed > rates.stayMaxAmount) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'stayClaimed', message: `Stay is limited to ₹${rates.stayMaxAmount}` }]);
  if (!id) history.push({ by: actor.id, byName: user?.name, action: 'CREATED', to: 'DRAFT' });
  else history.push({ by: actor.id, byName: user?.name, action: 'EDITED', from: t.status, to: t.status });
  t.history.push(...history);
  await t.save();
  await recordAudit({ actor, action: id ? 'UPDATE' : 'CREATE', entity: 'RecceTrip', entityId: t._id, project: body.projectId, reason: `Claim ₹${calc.total}` });
  return t.toObject();
}

/** Blocks anything the submission must not carry: missing photos / bills, impossible odometer values, duplicates. */
async function assertSubmittable(t: any, rates: Rates) {
  const issues: { path: string; message: string }[] = [];
  const c = t.calc as ReturnType<typeof calcTrip>;
  if (!t.endAt) issues.push({ path: 'endAt', message: 'Enter the trip end time' });
  if (t.transportType === 'PRIVATE') {
    if (!t.vehicle?.type) issues.push({ path: 'vehicle', message: 'Choose the vehicle type' });
    if (t.odoStart?.reading === undefined || !t.odoStart.photoFileId) issues.push({ path: 'odoStart', message: 'Starting odometer reading and photo are required' });
    if (t.odoEnd?.reading === undefined || !t.odoEnd.photoFileId) issues.push({ path: 'odoEnd', message: 'Ending odometer reading and photo are required' });
    if (!t.odoStart?.gps?.lat) issues.push({ path: 'odoStart.gps', message: 'Starting GPS location is required' });
    if (!t.odoEnd?.gps?.lat) issues.push({ path: 'odoEnd.gps', message: 'Ending GPS location is required' });
    if (c.flags.includes('END_BELOW_START')) issues.push({ path: 'odoEnd.reading', message: 'Ending reading cannot be below the starting reading' });
    if (c.flags.includes('END_BEFORE_START_TIME')) issues.push({ path: 'odoEnd.capturedAt', message: 'Ending photo time is before the starting photo time' });
  } else if (!t.legs.length) issues.push({ path: 'legs', message: 'Add at least one travel leg' });
  for (const [i, l] of t.legs.entries()) if (l.amount > rates.receiptRequiredAbove && !l.receiptFileId) issues.push({ path: `legs.${i}.receiptFileId`, message: `Bill is required above ₹${rates.receiptRequiredAbove}` });
  for (const [i, m] of t.misc.entries()) if (m.amount > rates.receiptRequiredAbove && !m.receiptFileId) issues.push({ path: `misc.${i}.receiptFileId`, message: `Bill is required above ₹${rates.receiptRequiredAbove}` });
  if (c.stay.claimed > 0 && !t.stayBillFileId) issues.push({ path: 'stayBillFileId', message: 'Upload the hotel bill' });
  if (!t.calc || c.total <= 0) issues.push({ path: 'total', message: 'Nothing to claim' });
  if (t.transportType === 'PRIVATE' && !issues.length) {
    // Same employee + same vehicle: odometer ranges of two live claims must not overlap.
    const others = await RecceTrip.find({ _id: { $ne: t._id }, employee: t.employee, transportType: 'PRIVATE', status: { $ne: 'REJECTED' }, 'vehicle.regNo': t.vehicle?.regNo ?? null, 'vehicle.type': t.vehicle?.type, 'odoStart.reading': { $exists: true }, 'odoEnd.reading': { $exists: true } }).select('odoStart odoEnd').lean();
    const a = t.odoStart.reading; const b = t.odoEnd.reading;
    if (others.some((o) => a < o.odoEnd!.reading! && o.odoStart!.reading! < b)) throw AppError.conflict('This odometer range is already claimed in another trip');
  }
  if (issues.length) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', issues);
}

export async function submitTrip(id: string, actor: Actor) {
  const t = await RecceTrip.findById(id);
  if (!t) throw AppError.notFound('Trip not found');
  if (String(t.employee) !== actor.id) throw AppError.forbidden('Only the employee who made this claim can submit it');
  if (!isEditable(t.status)) throw AppError.conflict('This claim is already submitted');
  const { rates, version } = await ratesAt(t.startAt);
  recompute(t, rates);
  await assertSubmittable(t, rates);
  const from = t.status;
  t.status = 'SUBMITTED';
  t.rateSnapshot = { rates, version }; // frozen: later Admin rate changes never touch this claim
  t.history.push({ by: actor.id as any, action: 'SUBMITTED', from, to: 'SUBMITTED', at: new Date() } as any);
  await t.save();
  await recordAudit({ actor, action: 'STATUS_CHANGE', entity: 'RecceTrip', entityId: t._id, project: t.project, changes: [{ field: 'status', oldValue: from, newValue: 'SUBMITTED' }] });
  return t.toObject();
}

export async function reviewTrip(id: string, body: z.infer<typeof reviewBody>, actor: Actor) {
  const t = await RecceTrip.findById(id);
  if (!t) throw AppError.notFound('Trip not found');
  const c = t.calc as any;
  const from = t.status as string;
  const need = (ok: boolean, msg: string) => { if (!ok) throw AppError.conflict(msg); };
  const isAdmin = actor.role === 'SUPER_ADMIN';
  if (t.status === 'SETTLED') throw AppError.conflict('A settled claim cannot be changed');
  if (String(t.employee) === actor.id && !isAdmin) throw AppError.forbidden('You cannot review your own claim');
  let to: string = from;
  switch (body.action) {
    case 'START_REVIEW':
      need(from === 'SUBMITTED', 'Only a submitted claim can be taken for review');
      to = 'UNDER_REVIEW';
      break;
    case 'REJECT':
      need(from === 'SUBMITTED' || from === 'UNDER_REVIEW', 'Only a claim in review can be rejected');
      if (!body.remark) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'remark', message: 'Say why the claim is rejected' }]);
      to = 'REJECTED';
      t.reviewRemark = body.remark;
      break;
    case 'APPROVE': {
      need(from === 'SUBMITTED' || from === 'UNDER_REVIEW', 'Only a claim in review can be approved');
      if (c.needsAdminApproval && !isAdmin) throw AppError.forbidden('This claim is above the Admin approval limit');
      if (c.flags.some((f: string) => ['END_BELOW_START', 'END_BEFORE_START_TIME'].includes(f))) throw AppError.conflict('The odometer readings are inconsistent');
      if (c.stay.claimed > 0 && !c.stay.eligible && !t.stayException?.approved) {
        if (!(isAdmin && body.stayException)) throw AppError.conflict('Stay is not eligible: an Admin must approve an exception first');
        t.stayException = { approved: true, by: actor.id as any, reason: body.stayException.reason };
      }
      const a = { transport: c.transport, food: c.food.claimed, stay: c.stay.claimed, misc: c.misc, ...(body.approved ?? {}) };
      const total = Math.round((a.transport + a.food + a.stay + a.misc) * 100) / 100;
      const changed = a.transport !== c.transport || a.food !== c.food.claimed || a.stay !== c.stay.claimed || a.misc !== c.misc;
      if (changed && !body.remark) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'remark', message: 'A remark is required when you change the claimed amounts' }]);
      if (total > c.total) throw AppError.conflict('Approved amount cannot be above the claim');
      t.approved = { ...a, total };
      t.reviewRemark = body.remark;
      to = 'APPROVED';
      break;
    }
    case 'SETTLE':
      need(from === 'APPROVED', 'Only an approved claim can be settled');
      to = 'SETTLED';
      break;
  }
  const user = await User.findById(actor.id).select('name').lean();
  t.status = to as any;
  t.history.push({ by: actor.id as any, byName: user?.name, action: body.action, from, to, remark: body.remark, at: new Date() } as any);
  await t.save();
  await recordAudit({ actor, action: 'RECCE_TRIP_REVIEW', entity: 'RecceTrip', entityId: t._id, project: t.project, changes: [{ field: 'status', oldValue: from, newValue: to }], reason: body.remark });
  return t.toObject();
}

export async function deleteTrip(id: string, actor: Actor) {
  const t = await RecceTrip.findById(id);
  if (!t) throw AppError.notFound('Trip not found');
  if (String(t.employee) !== actor.id && actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the owner can delete a claim');
  if (t.status !== 'DRAFT') throw AppError.conflict('Only a draft can be deleted');
  await t.deleteOne();
  await recordAudit({ actor, action: 'DELETE', entity: 'RecceTrip', entityId: t._id, project: t.project });
}

export async function getTrip(id: string) {
  const t = await RecceTrip.findById(id).populate('employee', 'name').lean();
  if (!t) throw AppError.notFound('Trip not found');
  return t;
}

export async function listTrips(f: { projectId?: string; employee?: string; status?: string; mine?: boolean; actor: Actor }) {
  const q: Record<string, unknown> = {};
  if (f.projectId) q.project = f.projectId;
  if (f.status) q.status = f.status;
  if (f.mine) q.employee = f.actor.id; else if (f.employee) q.employee = f.employee;
  return RecceTrip.find(q).sort({ startAt: -1 }).limit(200).lean();
}

// ---------- Vendor rate cards ----------
export const vendorRateBody = z.object({
  vendorId: objectId,
  recceType: z.string().trim().min(2).max(60),
  ratePerShop: money.default(0), ratePerDay: money.default(0), ratePerLocation: money.default(0), fixedProjectRate: money.default(0),
  travelCharges: money.default(0), stayCharges: money.default(0), otherCharges: money.default(0),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
}).refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'End date is before the start date' })
  .refine((v) => v.ratePerShop + v.ratePerDay + v.ratePerLocation + v.fixedProjectRate > 0, { path: ['ratePerShop'], message: 'Enter at least one rate' });

export async function saveVendorRate(id: string | null, body: z.infer<typeof vendorRateBody>, actor: Actor) {
  if (!(await Vendor.exists({ _id: body.vendorId }))) throw AppError.notFound('Vendor not found');
  const far = new Date('9999-12-31');
  const clash = await VendorRecceRateCard.findOne({
    _id: { $ne: id ?? undefined }, vendor: body.vendorId, recceType: body.recceType,
    effectiveFrom: { $lte: body.effectiveTo ?? far },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: body.effectiveFrom } }],
  }).lean();
  if (clash) throw AppError.conflict('This vendor already has a rate plan for this recce type in that date range');
  const { vendorId, ...rest } = body;
  const doc = id ? await VendorRecceRateCard.findByIdAndUpdate(id, { ...rest, vendor: vendorId }, { new: true }) : await VendorRecceRateCard.create({ ...rest, vendor: vendorId, createdBy: actor.id });
  if (!doc) throw AppError.notFound('Rate plan not found');
  await recordAudit({ actor, action: id ? 'UPDATE' : 'CREATE', entity: 'VendorRecceRateCard', entityId: doc._id, reason: `${body.recceType}` });
  return doc.toObject();
}
export const listVendorRates = (vendorId?: string) => VendorRecceRateCard.find(vendorId ? { vendor: vendorId } : {}).sort({ effectiveFrom: -1 }).populate('vendor', 'name').lean();

export const applyVendorBody = z.object({
  vendorId: objectId, recceType: z.string().trim().min(2).max(60),
  shops: z.coerce.number().int().min(0).max(100_000).default(0), days: z.coerce.number().min(0).max(1000).default(0), locations: z.coerce.number().int().min(0).max(100_000).default(0),
  scope: z.string().trim().max(300).optional(), additional: money.default(0),
});
/** Applies the vendor's rate card (in force today) to a project and stores the snapshot. Re-applying replaces it. */
export async function applyVendorRate(projectId: string, body: z.infer<typeof applyVendorBody>, actor: Actor) {
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).select('code client').lean();
  if (!project) throw AppError.notFound('Project not found');
  const now = new Date();
  const card = await VendorRecceRateCard.findOne({ vendor: body.vendorId, recceType: body.recceType, effectiveFrom: { $lte: now }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: now } }] }).lean();
  if (!card) throw AppError.notFound('No vendor rate plan is in force for this vendor and recce type');
  const calc = calcVendorCost(card as any, body);
  const client = await Client.findById(project.client).select('code').lean();
  const doc = await VendorRecceCost.findOneAndUpdate(
    { project: projectId, vendor: body.vendorId },
    { project: projectId, client: project.client, clientCode: client?.code, projectCode: project.code, vendor: body.vendorId, rateCard: card._id, recceType: body.recceType, shops: body.shops, days: body.days, locations: body.locations, scope: body.scope, additional: body.additional, snapshot: { ...card, calc }, total: calc.total, appliedBy: actor.id },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await recordAudit({ actor, action: 'APPLY_VENDOR_RATE', entity: 'VendorRecceCost', entityId: doc._id, project: projectId, reason: `₹${calc.total}` });
  return doc.toObject();
}
export const listVendorCosts = (projectId?: string) => VendorRecceCost.find(projectId ? { project: projectId } : {}).populate('vendor', 'name').sort({ createdAt: -1 }).lean();

// ---------- Internal cost report (never feeds invoices) ----------
/** Approved or settled claims count at their approved amounts; claims still in flight are shown as pending. */
export async function costReport(f: { client?: string; project?: string; from?: Date; to?: Date }) {
  const q: Record<string, unknown> = { status: { $in: ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SETTLED'] } };
  if (f.client) q.client = f.client;
  if (f.project) q.project = f.project;
  if (f.from || f.to) q.startAt = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
  const trips = await RecceTrip.find(q).select('client clientCode project projectCode employee employeeName startAt status calc approved').lean();
  const vq: Record<string, unknown> = {};
  if (f.client) vq.client = f.client;
  if (f.project) vq.project = f.project;
  const vendors = await VendorRecceCost.find(vq).populate('vendor', 'name').lean();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const by = <T>(items: T[], key: (i: T) => string) => { const m = new Map<string, number>(); return { add: (i: T, v: number) => m.set(key(i), (m.get(key(i)) ?? 0) + v), out: () => [...m].map(([k, v]) => ({ key: k, total: r2(v) })).sort((a, b) => b.total - a.total) }; };
  const cat = { transport: 0, food: 0, stay: 0, misc: 0, vendor: 0 };
  const byClient = by(trips, (t: any) => t.clientCode ?? String(t.client));
  const byProject = by(trips, (t: any) => t.projectCode ?? String(t.project));
  const byEmployee = by(trips, (t: any) => t.employeeName ?? String(t.employee));
  const byDate = by(trips, (t: any) => new Date(t.startAt).toISOString().slice(0, 10));
  const byVendor = new Map<string, number>();
  let inHouse = 0; let pending = 0;
  for (const t of trips as any[]) {
    const settled = t.status === 'APPROVED' || t.status === 'SETTLED';
    const a = settled ? t.approved : { transport: t.calc.transport, food: t.calc.food.claimed, stay: t.calc.stay.claimed, misc: t.calc.misc, total: t.calc.total };
    if (!settled) { pending += a.total; continue; }
    inHouse += a.total;
    cat.transport += a.transport; cat.food += a.food; cat.stay += a.stay; cat.misc += a.misc;
    byClient.add(t, a.total); byProject.add(t, a.total); byEmployee.add(t, a.total); byDate.add(t, a.total);
  }
  let vendorTotal = 0;
  for (const v of vendors as any[]) {
    vendorTotal += v.total; cat.vendor += v.total;
    const name = v.vendor?.name ?? String(v.vendor);
    byVendor.set(name, (byVendor.get(name) ?? 0) + v.total);
    byClient.add({ clientCode: v.clientCode } as any, v.total); byProject.add({ projectCode: v.projectCode } as any, v.total);
  }
  return {
    internalOnly: true,
    totals: { inHouse: r2(inHouse), vendor: r2(vendorTotal), total: r2(inHouse + vendorTotal), pendingApproval: r2(pending) },
    categories: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, r2(v)])),
    byClient: byClient.out(), byProject: byProject.out(), byEmployee: byEmployee.out(), byDate: byDate.out(),
    byVendor: [...byVendor].map(([key, total]) => ({ key, total: r2(total) })).sort((a, b) => b.total - a.total),
  };
}
