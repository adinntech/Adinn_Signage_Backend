import { Types } from 'mongoose';
import { env } from '../../config/env';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { escapeRegex, objectId, type Actor } from '../../common/query';
import { listAudit, recordAudit } from '../audit/audit.service';
import { hasCoords, haversineKm, roadKm, ROAD_FACTOR, type LatLng } from '../allocation/allocation.geo';
import { geocode, googleMapsAddressUrl } from '../allocation/allocation.maps';
import { notifyNewShops } from '../allocation/allocation.notify';
import { addressOf, planRoute, type RouteSite } from '../allocation/allocation.route';
import { clientNameOf } from '../clients/clientDetails';
import { listExpenses, notifyApprovers } from '../expenses/expense.service';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { advanceStage, changeStatus } from '../projects/project.service';
import { User } from '../users/user.model';
import { normKey } from '../sites/site.fields';
import { Site } from '../sites/site.model';
import { clusterShops } from './costing.cluster';
import { NO_ADDRESS, verifiedFilter } from '../sites/site.ready';
import { VendorPrice } from '../vendors/vendorPrice.model';
import { Vendor } from '../vendors/vendor.model';
import { adoptZohoVendor } from '../vendors/vendor.service';
import { VendorRateApproval } from '../vendors/vendorRateApproval.model';
import { calculateLeg, DEFAULT_RATES, estimateTrip, PLANNING, totalsOf, type Channel, type CostRates, type LegInput } from './costing.calc';
import { BaseLocation } from './baseLocation.model';
import { CHANNELS, CostPlan, CostPolicy } from './costing.model';

const money = z.coerce.number().min(0).max(100_000_000);
const dateTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick the date and time').optional().or(z.literal('').transform(() => undefined));
const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date').optional().or(z.literal('').transform(() => undefined));

export const legBody = z
  .object({
    key: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1, 'Name the area').max(120),
    district: z.string().trim().max(120).optional().or(z.literal('').transform(() => undefined)),
    shops: z.coerce.number().int().min(1, 'At least one shop').max(100000),
    distanceKm: money.default(0),
    routeKm: money.nullable().optional(),
    deadline: day,
    channel: z.enum(CHANNELS).nullable().optional(),
    vendorId: objectId.nullable().optional(),
    vendorRate: money.nullable().optional(),
    vendorOther: money.default(0),
    tripStart: dateTime,
    tripEnd: dateTime,
    clientsShared: z.coerce.number().int().min(1).max(20).default(1),
    otherAmount: money.default(0),
  })
  .superRefine((v, ctx) => {
    if (v.tripStart && v.tripEnd && v.tripEnd < v.tripStart) ctx.addIssue({ code: 'custom', path: ['tripEnd'], message: 'The trip must end after it starts' });
    if (v.channel === 'VENDOR' && !v.vendorId) ctx.addIssue({ code: 'custom', path: ['vendorId'], message: 'Choose the vendor' });
  });
export const legsBody = z
  .object({ legs: z.array(legBody).min(1, 'Add at least one area').max(100), refreshRates: z.boolean().optional() })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.legs.forEach((l, i) => {
      if (seen.has(l.key)) ctx.addIssue({ code: 'custom', path: ['legs', i, 'key'], message: 'Two areas have the same key' });
      seen.add(l.key);
    });
  });
export const submitBody = z.object({ justification: z.string().trim().max(1000).optional() });
export const decideBody = z
  .object({ approve: z.boolean(), remark: z.string().trim().max(1000).optional() })
  .refine((v) => v.approve || !!v.remark, { path: ['remark'], message: 'Say why it is rejected' });
export const clientBody = z
  .object({ decision: z.enum(['ACCEPTED', 'REJECTED', 'PENDING']), remark: z.string().trim().max(1000).optional() })
  .refine((v) => v.decision !== 'REJECTED' || (v.remark?.length ?? 0) >= 3, { path: ['remark'], message: "Give the client's reason for rejecting the cost" });
export const policyBody = z.object(Object.fromEntries(Object.keys(DEFAULT_RATES).map((k) => [k, money])) as Record<keyof CostRates, z.ZodNumber>).partial();

const RATE_KEYS = Object.keys(DEFAULT_RATES) as (keyof CostRates)[];
const ratesOf = (d: Record<string, unknown> | null | undefined): CostRates => Object.fromEntries(RATE_KEYS.map((k) => [k, Number(d?.[k] ?? DEFAULT_RATES[k])])) as unknown as CostRates;

export async function getPolicy() {
  const d = await CostPolicy.findOneAndUpdate({ key: 'default' }, { $setOnInsert: { key: 'default' } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).lean();
  return ratesOf(d);
}
export async function updatePolicy(body: z.infer<typeof policyBody>, actor: Actor) {
  await getPolicy();
  const d = await CostPolicy.findOneAndUpdate({ key: 'default' }, { $set: { ...body, updatedBy: actor.id } }, { returnDocument: 'after' }).lean();
  await recordAudit({ actor, action: 'UPDATE', entity: 'CostPolicy', entityId: d!._id, changes: Object.entries(body).map(([field, newValue]) => ({ field, oldValue: null, newValue })), reason: 'Cost rates changed' });
  return ratesOf(d);
}

const PROJECT_FIELDS = 'code client clientDetails siteCount status targetDate owner createdBy assignedTo originName originLat originLng requirementType';
async function requireProject(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select(PROJECT_FIELDS).lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}
const originOf = (p: { originLat?: number | null; originLng?: number | null }): LatLng | null => (hasCoords({ lat: p.originLat, lng: p.originLng }) ? { lat: p.originLat as number, lng: p.originLng as number } : null);
const isoDay = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);
const districtRe = (name: string) => new RegExp(`^\\s*${escapeRegex(name.trim())}\\s*$`, 'i');
/** The shops of one plan area: its cluster key, else its district. */
const legShopFilter = (projectId: string, leg: { key: string; district?: string | null; clustered?: boolean | null }) =>
  ({ project: projectId, deletedAt: null, ...(leg.clustered ? { planArea: leg.key } : { district: districtRe(leg.district ?? '') }) });

type LegDoc = {
  key: string; name: string; district?: string | null; shops: number; distanceKm?: number | null; routeKm?: number | null; deadline?: string | null;
  channel?: Channel | null; vendor?: Types.ObjectId | null; vendorName?: string | null; vendorRate?: number | null; cardRate?: number | null; cardFarRate?: number | null;
  vendorOther?: number | null; tripStart?: string | null; tripEnd?: string | null; clientsShared?: number | null; otherAmount?: number | null; clustered?: boolean | null; autoSelected?: boolean | null;
};
const legInput = (l: LegDoc): LegInput => ({
  shops: l.shops, distanceKm: l.distanceKm ?? 0, routeKm: l.routeKm, tripStart: l.tripStart, tripEnd: l.tripEnd, clientsShared: l.clientsShared ?? 1,
  otherAmount: l.otherAmount ?? 0, vendorRate: l.vendorRate, vendorOther: l.vendorOther ?? 0, cardRate: l.cardRate, cardFarRate: l.cardFarRate,
});

/** The shops grouped by district: how many, how many have a map position, and where they are on average. */
async function districtSummary(projectId: string) {
  const rows = await Site.aggregate([
    { $match: { project: new Types.ObjectId(projectId), deletedAt: null } },
    {
      $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ['$district', ''] } } } },
        name: { $first: '$district' },
        shops: { $sum: 1 },
        located: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$lat', null] }, null] }, { $ne: [{ $ifNull: ['$lng', null] }, null] }] }, 1, 0] } },
        lat: { $avg: '$lat' },
        lng: { $avg: '$lng' },
      },
    },
    { $sort: { shops: -1, _id: 1 } },
  ]);
  return rows.map((r) => ({
    key: normKey(r._id) || 'no-district',
    name: (r.name ? String(r.name).trim() : '') || null,
    shops: r.shops as number,
    located: r.located as number,
    centre: r.lat != null && r.lng != null ? ({ lat: r.lat, lng: r.lng } as LatLng) : null,
  }));
}

/** The plan (or an empty starting point), with every figure worked out, the shops by district and the real expenses. */
export async function getPlan(projectId: string) {
  const project = await requireProject(projectId);
  const [saved, policy, sqft, expenses, districts] = await Promise.all([
    CostPlan.findOne({ project: projectId }).lean(),
    getPolicy(),
    Site.aggregate([{ $match: { project: new Types.ObjectId(projectId), deletedAt: null } }, { $group: { _id: null, s: { $sum: '$sqft' }, n: { $sum: 1 } } }]),
    listExpenses(projectId),
    districtSummary(projectId),
  ]);
  const plan = saved ?? { _id: null, project: projectId, legs: [] as LegDoc[], status: 'DRAFT' as const, clientDecision: 'PENDING' as const };
  const rates = saved?.rates ? ratesOf(saved.rates as Record<string, unknown>) : policy;
  const origin = originOf(project);
  const legs = (plan.legs as unknown as LegDoc[]).map((l) => ({ ...l, vendor: l.vendor ? String(l.vendor) : null, calc: calculateLeg(legInput(l), rates) }));
  const totals = totalsOf(legs);
  const totalSqft = Math.round((sqft[0]?.s ?? 0) * 100) / 100;
  const allChosen = legs.length > 0 && totals.chosenLegs === legs.length;
  const inHouse = legs
    .filter((l) => l.channel === 'IN_HOUSE')
    .reduce((a, l) => ({ food: a.food + l.calc.inHouse.food, stay: a.stay + l.calc.inHouse.stay, fuel: a.fuel + l.calc.inHouse.fuel, other: a.other + l.calc.inHouse.other, total: a.total + l.calc.inHouse.total }), { food: 0, stay: 0, fuel: 0, other: 0, total: 0 });
  return {
    plan: { ...plan, legs },
    saved: !!saved,
    rates,
    policy,
    totals,
    districts: districts.map((d) => ({ key: d.key, name: d.name, shops: d.shops, located: d.located, distanceKm: origin && d.centre ? roadKm(origin, d.centre) : null })),
    project: { deadline: isoDay(project.targetDate), origin: origin ? { name: project.originName ?? 'Start point', ...origin } : null, status: project.status },
    shopsRecorded: sqft[0]?.n ?? 0,
    totalSqft,
    inHouseByCategory: inHouse,
    // What the client is shown after the recce: the chosen channels' total, per shop and per square foot.
    clientCost: allChosen ? { total: totals.chosenTotal, perShop: totals.perShop, perSqft: totalSqft ? Math.round((totals.chosenTotal / totalSqft) * 100) / 100 : null } : null,
    actual: { ...expenses.totals, byCategory: expenses.byCategory, perShop: totals.shops ? Math.round((expenses.totals.all / totals.shops) * 100) / 100 : 0 },
  };
}

/** Any edit to the numbers voids a confirmation or approval: the plan must be submitted again. */
function reopen(plan: InstanceType<typeof CostPlan>) {
  if (plan.status === 'DRAFT') return;
  plan.set({ status: 'DRAFT', justification: undefined, reviewRemark: undefined, reviewedBy: undefined, reviewedAt: undefined, requestedBy: undefined, requestedAt: undefined, assignedAt: undefined, assignedBy: undefined });
}
async function loadEditable(projectId: string, actor: Actor, create = true) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  let plan = await CostPlan.findOne({ project: projectId });
  if (!plan) {
    if (!create) throw AppError.conflict('Create the plan from the shops first');
    plan = new CostPlan({ project: projectId, rates: await getPolicy(), createdBy: actor.id, updatedBy: actor.id });
  }
  if (plan.clientDecision === 'ACCEPTED') throw AppError.conflict('The client already accepted this cost, so it can no longer be edited');
  return plan;
}

/** Builds (or refreshes) the areas from the project's shops: one per district, keeping anything already filled in. */
export async function syncLegs(projectId: string, actor: Actor) {
  const project = await requireProject(projectId);
  const plan = await loadEditable(projectId, actor);
  const groups = await districtSummary(projectId);
  if (!groups.length) throw AppError.conflict('This project has no shops yet. Extract the shops from the attached sheet first');
  const origin = originOf(project);
  const before = (plan.legs as unknown as LegDoc[]).map((l) => `${l.key}:${l.shops}`).join('|');
  const old = new Map((plan.legs as unknown as { toObject: () => LegDoc }[]).map((l) => [l.toObject().key, l.toObject()]));
  const legs = groups.map((g) => {
    const prev = old.get(g.key);
    const distance = origin && g.centre ? roadKm(origin, g.centre) : 0;
    const base = { key: g.key, name: g.name ?? 'No district', district: g.name ?? undefined, shops: g.shops };
    return prev
      ? { ...prev, ...base, distanceKm: prev.distanceKm || distance }
      : { ...base, distanceKm: distance, deadline: isoDay(project.targetDate), vendorOther: 0, clientsShared: 1, otherAmount: 0 };
  });
  plan.set({ legs, updatedBy: actor.id });
  if (legs.map((l) => `${l.key}:${l.shops}`).join('|') !== before) reopen(plan);
  await plan.save();
  await recordAudit({ actor, action: 'COST_SYNC', entity: 'CostPlan', entityId: plan._id, project: projectId, reason: `${legs.length} area(s) from ${groups.reduce((a, g) => a + g.shops, 0)} shops` });
  return getPlan(projectId);
}

/** Saves what Operations entered for every area: channel, vendor and bargained price, trip dates, route km. */
export async function saveLegs(projectId: string, body: z.infer<typeof legsBody>, actor: Actor) {
  const plan = await loadEditable(projectId, actor);
  const ids = [...new Set(body.legs.map((l) => l.vendorId).filter(Boolean))] as string[];
  const vendors = await Vendor.find({ _id: { $in: ids }, deletedAt: null }).select('name status ratePerShop farRatePerShop').lean();
  const byId = new Map(vendors.map((v) => [String(v._id), v]));
  const before = new Map((plan.legs as unknown as { toObject: () => LegDoc }[]).map((l) => [l.toObject().key, l.toObject()]));
  const legs = body.legs.map(({ vendorId, ...l }) => {
    const v = vendorId ? byId.get(vendorId) : undefined;
    if (vendorId && !v) throw AppError.notFound('Vendor not found');
    if (l.channel === 'VENDOR' && v && v.status !== 'ACTIVE') throw AppError.conflict(`${v.name} is not an active vendor`);
    const was = before.get(l.key);
    // A choice stays "auto-selected" until a person changes the channel or the vendor.
    const sameChoice = !!was && (was.channel ?? null) === (l.channel ?? null) && String(was.vendor ?? '') === String(v?._id ?? '');
    return { ...l, clustered: !!was?.clustered, autoSelected: sameChoice && !!was?.autoSelected, vendor: v?._id ?? null, vendorName: v?.name ?? null, cardRate: v?.ratePerShop ?? null, cardFarRate: v?.farRatePerShop ?? null, channel: l.channel ?? null };
  });
  if (body.refreshRates) plan.set({ rates: (await getPolicy()) as unknown as Record<string, number> });
  plan.set({ legs, updatedBy: actor.id });
  reopen(plan);
  await plan.save();
  const changes = legs.flatMap((l) => {
    const was = before.get(l.key);
    const now = l.channel === 'VENDOR' ? `Vendor: ${l.vendorName ?? '-'}` : l.channel === 'IN_HOUSE' ? 'In-house' : 'Not chosen';
    const old = was?.channel === 'VENDOR' ? `Vendor: ${was.vendorName ?? '-'}` : was?.channel === 'IN_HOUSE' ? 'In-house' : 'Not chosen';
    return now === old ? [] : [{ field: `${l.name}: who does it`, oldValue: old, newValue: now }];
  });
  await recordAudit({ actor, action: 'UPDATE', entity: 'CostPlan', entityId: plan._id, project: projectId, changes, reason: `${legs.length} area(s) saved` });
  return getPlan(projectId);
}

/** Road route for one area's shops: total km over real roads, days, time and a Google Maps link for each day. */
export async function routeLeg(projectId: string, key: string, actor: Actor, shopsPerDay = 8) {
  const project = await requireProject(projectId);
  const plan = await loadEditable(projectId, actor, false);
  const leg = plan.legs.find((l) => l.key === key);
  if (!leg) throw AppError.notFound('That area is not in the plan');
  const origin = originOf(project);
  if (!origin) throw AppError.conflict('Set the start point (office / hub) on the Shop Allocation map first');
  const filter = leg.district ? { district: districtRe(leg.district) } : { $or: [{ district: null }, { district: '' }] };
  const rows = await Site.find({ project: projectId, deletedAt: null, ...filter }).select('seq siteCode shopName dealerName district location address1 address2 address3 pincode lat lng').sort({ seq: 1 }).lean();
  const located = rows.filter((r) => hasCoords(r)) as unknown as RouteSite[];
  if (!located.length) throw AppError.conflict(`None of the ${rows.length} shop(s) in ${leg.name} has a map position. Use “Locate shops” first`);
  const route = await planRoute(origin, located, shopsPerDay);
  const farthest = Math.max(...located.map((s) => roadKm(origin, s)));
  leg.set({ routeKm: route.totalKm, distanceKm: Math.round(farthest * 10) / 10 });
  reopen(plan);
  plan.updatedBy = actor.id as never;
  await plan.save();
  return {
    ...(await getPlan(projectId)),
    route: { key, located: located.length, missing: rows.length - located.length, roadDistance: route.roadDistance, totalKm: route.totalKm, days: route.days.map((d) => ({ day: d.day, km: d.km, minutes: d.minutes, stops: d.stops.length, source: d.source, googleUrl: d.googleUrl, googleAddressUrl: d.googleAddressUrl })) },
  };
}

/**
 * Google Maps links for one area's shops, built from their written addresses (no map position needed): the shops in entry order,
 * eight to a day, each day starting and ending at the start point. Open them to see the stops and the distance in Google Maps.
 */
export async function legMapLinks(projectId: string, key: string, perDay = 8) {
  const project = await requireProject(projectId);
  const plan = await CostPlan.findOne({ project: projectId }).lean();
  const leg = (plan?.legs as unknown as LegDoc[] | undefined)?.find((l) => l.key === key);
  if (!leg) throw AppError.notFound('That area is not in the plan');
  const filter = leg.district ? { district: districtRe(leg.district) } : { $or: [{ district: null }, { district: '' }] };
  const rows = await Site.find({ project: projectId, deletedAt: null, ...filter }).select('seq siteCode shopName dealerName district location address1 address2 address3 pincode lat lng').sort({ seq: 1 }).lean();
  const origin = originOf(project);
  const days: { day: number; stops: number; googleUrl: string }[] = [];
  for (let i = 0; i < rows.length; i += perDay) {
    const chunk = rows.slice(i, i + perDay);
    days.push({ day: days.length + 1, stops: chunk.length, googleUrl: googleMapsAddressUrl(origin, chunk.map((c) => ({ address: addressOf(c as unknown as RouteSite), at: hasCoords(c) ? { lat: c.lat as number, lng: c.lng as number } : undefined }))) });
  }
  return { key, shops: rows.length, days };
}

/** Operations submits the finished plan. Anything over a limit goes to admin as a special approval; the rest is confirmed. */
export async function submitPlan(projectId: string, body: z.infer<typeof submitBody>, actor: Actor) {
  const project = await requireProject(projectId);
  const plan = await loadEditable(projectId, actor, false);
  const view = await getPlan(projectId);
  if (!view.plan.legs.length) throw AppError.conflict('There are no areas in the plan yet');
  const open = view.plan.legs.filter((l) => !l.channel);
  if (open.length) throw AppError.conflict(`Choose in-house or a vendor for: ${open.map((l) => l.name).join(', ')}`);
  const needs = view.totals.needsApproval;
  if (needs && (body.justification?.length ?? 0) < 5) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'justification', message: 'Part of this plan is over the cost limit. Explain why it is needed' }]);
  plan.set({ status: needs ? 'APPROVAL_PENDING' : 'CONFIRMED', justification: body.justification, requestedBy: actor.id, requestedAt: new Date(), reviewRemark: undefined, reviewedBy: undefined, reviewedAt: undefined, updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: needs ? 'COST_APPROVAL_REQUEST' : 'COST_CONFIRM', entity: 'CostPlan', entityId: plan._id, project: projectId, reason: body.justification });
  if (needs) await notifyApprovers(project, `Special approval needed: ${project.code}`, `${view.totals.reasons.join(' ')} Reason given: ${body.justification}`, `cost-request:${plan._id}:${plan.requestedAt?.getTime()}`, actor);
  return getPlan(projectId);
}

/** Admin / Finance approve or reject the special-approval request. */
export async function decideApproval(projectId: string, body: z.infer<typeof decideBody>, actor: Actor) {
  const project = await requireProject(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan || plan.status !== 'APPROVAL_PENDING') throw AppError.conflict('There is no special approval waiting for this project');
  plan.set({ status: body.approve ? 'APPROVED' : 'REJECTED', reviewRemark: body.remark, reviewedBy: actor.id, reviewedAt: new Date(), updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: 'COST_APPROVAL', entity: 'CostPlan', entityId: plan._id, project: projectId, changes: [{ field: 'status', oldValue: 'APPROVAL_PENDING', newValue: plan.status }], reason: body.remark });
  const client = { name: await clientNameOf(project) };
  await notify({
    kind: 'COST_APPROVAL', recipients: [plan.requestedBy, project.assignedTo], actorId: actor.id,
    title: `Special approval ${body.approve ? 'granted' : 'rejected'}: ${project.code}`,
    body: body.approve ? `Your recce plan was approved.${body.remark ? ` ${body.remark}` : ''}` : `Your recce plan was rejected: ${body.remark}. Change it and submit again.`,
    project: { _id: project._id, code: project.code, clientName: client?.name ?? undefined }, dedupe: (r) => `cost-decision:${plan._id}:${plan.reviewedAt?.getTime()}:${r}`,
  });
  return getPlan(projectId);
}

/** The final step: gives every area's shops to the chosen in-house team or vendor (what Shop Allocation then shows). */
export async function assignPlan(projectId: string, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan) throw AppError.conflict('There is no plan yet');
  if (!['CONFIRMED', 'APPROVED', 'ASSIGNED'].includes(plan.status)) throw AppError.conflict('Submit the plan, and get any special approval, before assigning the shops');
  let assigned = 0;
  const skipped: string[] = [];
  for (const leg of plan.legs) {
    if (!leg.channel || !leg.district) { skipped.push(leg.name); continue; }
    if (leg.channel === 'VENDOR') {
      const v = leg.vendor ? await Vendor.findOne({ _id: leg.vendor, deletedAt: null }).select('name status').lean() : null;
      if (!v || v.status !== 'ACTIVE') throw AppError.conflict(`${leg.vendorName ?? 'The vendor'} for ${leg.name} is no longer active`);
    }
    const now = new Date();
    const r = await Site.updateMany(
      legShopFilter(projectId, leg),
      // A fresh allocation clears any earlier login assignment: Operations picks the login again afterwards.
      leg.channel === 'VENDOR'
        ? { $set: { channel: 'VENDOR', vendor: leg.vendor, allocatedAt: now, allocatedBy: actor.id, status: 'PENDING' }, $unset: { assignedTo: 1, assignedToAt: 1, assignedToBy: 1 } }
        : { $set: { channel: 'IN_HOUSE', allocatedAt: now, allocatedBy: actor.id, status: 'PENDING' }, $unset: { vendor: 1, assignedTo: 1, assignedToAt: 1, assignedToBy: 1 } },
    );
    assigned += r.modifiedCount;
    if (r.modifiedCount > 0) await notifyNewShops(projectId, leg.channel === 'VENDOR' ? { kind: 'VENDOR', vendorId: String(leg.vendor) } : { kind: 'IN_HOUSE' }, r.modifiedCount, actor);
  }
  plan.set({ status: 'ASSIGNED', assignedAt: new Date(), assignedBy: actor.id, updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: 'COST_ASSIGN', entity: 'CostPlan', entityId: plan._id, project: projectId, reason: `${assigned} shop(s) assigned${skipped.length ? `; not matched: ${skipped.join(', ')}` : ''}` });

  // The recce is now running: the project goes to IN_PROGRESS (one step at a time, the same checks as Operations' own button).
  let stage: string | null = null;
  try {
    for (let i = 0; i < 2; i++) {
      const p = await Project.findById(projectId).select('status').lean();
      if (!p || !['RECCE_ASSIGNED', 'PLANNING'].includes(p.status)) { stage = p?.status ?? null; break; }
      stage = (await advanceStage(projectId, { stage: p.status === 'RECCE_ASSIGNED' ? 'PLANNING' : 'IN_PROGRESS' }, actor)).status as string;
    }
  } catch (e) {
    stage = null; // shops stay assigned; Operations can start the recce by hand (the reason shows in the project page)
    console.error('project could not move to in progress after assigning', e instanceof Error ? e.message : e);
  }

  // A vendor can only see its shops with a mobile login. Tell Operations which vendors still have none.
  const vendorIds = [...new Set(plan.legs.filter((l) => l.channel === 'VENDOR' && l.vendor).map((l) => String(l.vendor)))];
  const vendorsWithoutLogin: { id: string; name: string; email: string | null; mobile: string | null }[] = [];
  for (const id of vendorIds) {
    if (await User.exists({ role: 'VENDOR', vendorId: id, isActive: true, deletedAt: null })) continue;
    const v = await Vendor.findById(id).select('name email mobile').lean();
    if (v) vendorsWithoutLogin.push({ id, name: v.name, email: v.email ?? null, mobile: v.mobile ?? null });
  }
  return { ...(await getPlan(projectId)), assigned, skipped, stage, vendorsWithoutLogin };
}

export const loginsBody = z.object({ legs: z.array(z.object({ key: z.string().trim().min(1).max(80), userId: objectId })).min(1).max(100) });

/** Active recce mobile logins that may take a plan area: the vendor's own logins, or the in-house recce executives. */
async function loginsFor(leg: { channel?: string | null; vendor?: unknown }) {
  const filter: Record<string, unknown> = leg.channel === 'VENDOR' ? { role: 'VENDOR', vendorId: leg.vendor } : { role: 'RECCE_EXECUTIVE' };
  const users = await User.find({ ...filter, isActive: true, deletedAt: null }).select('name phone employeeId').sort({ name: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, phone: u.phone ?? null, employeeId: u.employeeId ?? null }));
}

/** Step after "Confirm & assign": for every area, the logins to choose from and who already holds its shops (with when and by whom). */
export async function legLogins(projectId: string) {
  await requireProject(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan || plan.status !== 'ASSIGNED') throw AppError.conflict('Assign the shops to the in-house team or vendors first');
  const out = [];
  for (const leg of plan.legs) {
    if (!leg.channel || !leg.district) continue;
    const filter = legShopFilter(projectId, leg);
    const [logins, holders] = await Promise.all([
      loginsFor(leg),
      Site.aggregate<{ _id: Types.ObjectId | null; shops: number; at: Date | null; by: Types.ObjectId | null }>([
        { $match: { ...filter, project: new Types.ObjectId(projectId) } },
        { $group: { _id: '$assignedTo', shops: { $sum: 1 }, at: { $max: '$assignedToAt' }, by: { $last: '$assignedToBy' } } },
      ]),
    ]);
    const byIds = holders.map((h) => h.by).filter((x): x is Types.ObjectId => !!x);
    const names = new Map((byIds.length ? await User.find({ _id: { $in: byIds } }).select('name').lean() : []).map((u) => [String(u._id), u.name]));
    out.push({
      key: leg.key, name: leg.name, channel: leg.channel, vendorName: leg.vendorName ?? null, vendorId: leg.vendor ? String(leg.vendor) : null, shops: holders.reduce((n, h) => n + h.shops, 0), logins,
      holders: holders.filter((h) => h._id).map((h) => ({ userId: String(h._id), shops: h.shops, assignedAt: h.at, assignedBy: h.by ? (names.get(String(h.by)) ?? null) : null })),
      unassigned: holders.find((h) => !h._id)?.shops ?? 0,
    });
  }
  return out;
}

/** Gives each area's shops to the chosen recce mobile login: status IN_PROGRESS, with the date and time and who assigned. */
export async function assignLogins(projectId: string, body: z.infer<typeof loginsBody>, actor: Actor) {
  const project = await requireProject(projectId);
  await assertNotCancelled(projectId);
  const legs = await legLogins(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  let given = 0;
  for (const pick of body.legs) {
    const view = legs.find((l) => l.key === pick.key);
    const leg = plan?.legs.find((l) => l.key === pick.key);
    if (!view || !leg) throw AppError.conflict('That area is not part of the plan');
    if (!view.logins.some((u) => u.id === pick.userId)) throw AppError.conflict(`That login cannot take ${view.name}. Pick one of the ${view.channel === 'VENDOR' ? 'vendor' : 'in-house'} logins.`);
    const now = new Date();
    const r = await Site.updateMany({ ...legShopFilter(projectId, leg), channel: leg.channel }, { $set: { assignedTo: pick.userId, assignedToAt: now, assignedToBy: actor.id, status: 'IN_PROGRESS' } });
    given += r.modifiedCount;
    if (r.modifiedCount > 0) {
      await notify({
        kind: 'SHOPS_ADDED', recipients: [new Types.ObjectId(pick.userId)] as never[], actorId: actor.id,
        title: `New shops assigned: ${project.code}`, body: `${r.modifiedCount} shop${r.modifiedCount === 1 ? '' : 's'} in ${view.name} are assigned to you. Open the project in the app to start the recce.`,
        project: { _id: project._id, code: project.code }, dedupe: (rcp) => `shops-login:${projectId}:${pick.key}:${rcp}:${now.getTime()}`,
      });
    }
  }
  await recordAudit({ actor, action: 'COST_ASSIGN_LOGIN', entity: 'CostPlan', entityId: plan!._id, project: projectId, reason: `${given} shop(s) given to recce logins` });
  return { given, legs: await legLogins(projectId) };
}

/** The client's answer to the cost. A rejected cost closes the project as LOSS, with the reason. */
export async function clientDecision(projectId: string, body: z.infer<typeof clientBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan) throw AppError.conflict('Create the plan first');
  if (body.decision === 'ACCEPTED' && !['CONFIRMED', 'APPROVED', 'ASSIGNED'].includes(plan.status)) throw AppError.conflict('Confirm the plan (and get any special approval) before the client accepts');
  plan.set({ clientDecision: body.decision, clientRemark: body.remark, clientDecidedAt: body.decision === 'PENDING' ? undefined : new Date(), updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: 'CLIENT_COST_DECISION', entity: 'CostPlan', entityId: plan._id, project: projectId, changes: [{ field: 'clientDecision', oldValue: null, newValue: body.decision }], reason: body.remark });
  if (body.decision === 'REJECTED') await changeStatus(projectId, 'LOSS', `Client rejected the cost: ${body.remark}`, actor);
  return getPlan(projectId);
}

/**
 * A vendor's own price per shop: what is saved on the vendor, else the cost saved for their Zoho record (Vendor rates). The
 * company rate is used only when neither exists. Also returns the rate requests still waiting for the approver's reply.
 */
async function withOwnPrices<T extends { _id: unknown; zohoContactId?: string | null; ratePerShop?: number | null; farRatePerShop?: number | null }>(list: T[]) {
  const ids = list.map((v) => v.zohoContactId).filter((x): x is string => !!x);
  const zoho = ids.length ? await VendorPrice.find({ zohoContactId: { $in: ids } }).select('zohoContactId ratePerShop farRatePerShop').lean() : [];
  const byZoho = new Map(zoho.map((z) => [z.zohoContactId, z]));
  for (const v of list) {
    const z = v.zohoContactId ? byZoho.get(v.zohoContactId) : undefined;
    if (v.ratePerShop == null && z?.ratePerShop != null) v.ratePerShop = z.ratePerShop;
    if (v.farRatePerShop == null && z?.farRatePerShop != null) v.farRatePerShop = z.farRatePerShop;
  }
  const waiting = list.length ? await VendorRateApproval.find({ status: 'PENDING', vendor: { $in: list.map((v) => v._id as Types.ObjectId) } }).select('vendor requested limit').lean() : [];
  return new Map(waiting.map((w) => [String(w.vendor), { requested: w.requested?.ratePerShop ?? null, limit: w.limit?.ratePerShop ?? null }]));
}

/** The same for Zoho vendors that only have a cost saved (city and address from Zoho). */
async function ensureZohoPlaces(list: { zohoContactId: string; city?: string | null; address?: string | null; lat?: number | null; lng?: number | null; geoAt?: Date | null }[]) {
  if (env.NODE_ENV === 'test') return;
  const todo = list.filter((z) => !hasCoords(z) && !z.geoAt && (z.city || z.address)).slice(0, 5);
  for (const z of todo) {
    const hit = await geocode({ address: z.address ?? undefined, area: z.city ?? undefined, district: z.city ?? undefined }, () => new Promise((r) => setTimeout(r, 1100)));
    await VendorPrice.updateOne({ zohoContactId: z.zohoContactId }, { $set: { geoAt: new Date(), ...(hit ? { lat: hit.lat, lng: hit.lng } : {}) } });
    if (hit) { z.lat = hit.lat; z.lng = hit.lng; }
    z.geoAt = new Date();
  }
}

/**
 * Finds where vendors are (from address, pincode or district) once and keeps it, so the planner can offer the nearest vendor
 * when nobody works in an area. A few per call; one that cannot be found is not tried again.
 */
async function ensureVendorPlaces(list: { _id: unknown; ratePerShop?: number | null; address?: string | null; district?: string | null; pincode?: string | null; lat?: number | null; lng?: number | null; geoAt?: Date | null }[]) {
  if (env.NODE_ENV === 'test') return; // tests never call the address service
  const todo = list.filter((v) => v.ratePerShop != null && !hasCoords(v) && !v.geoAt).slice(0, 5);
  for (const v of todo) {
    const hit = await geocode({ address: v.address ?? undefined, area: v.district ?? undefined, district: v.district ?? undefined, pincode: v.pincode ?? undefined }, () => new Promise((r) => setTimeout(r, 1100)));
    await Vendor.updateOne({ _id: v._id }, { $set: { geoAt: new Date(), ...(hit ? { lat: hit.lat, lng: hit.lng } : {}) } });
    if (hit) { v.lat = hit.lat; v.lng = hit.lng; }
    v.geoAt = new Date();
  }
}

// ---------- Smart plan: who should do which area ----------
export const suggestBody = z.object({
  /** Skills the recce needs (e.g. "measurement"). Vendors that have them rank first. */
  skills: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  /** When true, vendors without every listed skill are left out. */
  requireSkills: z.boolean().default(false),
  /** `area` groups nearby shops (one trip covers them); `district` keeps whole districts together. */
  groupBy: z.enum(['area', 'district']).default('area'),
  /** Who may be suggested: only vendors, only the in-house team, or whichever is cheaper. */
  mode: z.enum(['BOTH', 'VENDOR', 'IN_HOUSE']).default('BOTH'),
  /** When true, the groups and the best choice for each are saved into the plan (as a draft). */
  apply: z.boolean().default(false),
});

/** Distance a vendor travels to the area: none when they work there, else from where they are, else (unknown place) from the start point. */
const vendorKm = (local: boolean, at: LatLng | null, centre: LatLng | null, fromStart: number) =>
  local ? 0 : at && centre ? Math.round(haversineKm(at, centre) * ROAD_FACTOR) : fromStart;
const sameName = (a?: string | null, b?: string | null) => !!a && !!b && normKey(a) === normKey(b);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/**
 * 1. Groups the project's shops into work areas: nearby shops together (one trip covers them, so the in-house team's travel,
 *    food and stay are shared), or whole districts.
 * 2. Prices each area for the in-house team (travel + food + stay only, from the area's real tour km and the days it needs)
 *    and for every active vendor that works there (price per shop, skills respected).
 * 3. Recommends the cheaper one; a choice that breaks a limit loses to one that does not. Also says from how many shops in one
 *    trip the in-house team beats the vendor.
 */
export async function suggestPlan(projectId: string, body: z.infer<typeof suggestBody>, actor: Actor) {
  const project = await requireProject(projectId);
  const readiness = await verificationOf(projectId, project.requirementType);
  if (!readiness.total) throw AppError.conflict('This project has no shops yet. Extract the shops from the attached sheet first');
  if (!readiness.verified) throw AppError.conflict(`None of the ${readiness.total} shops is verified yet. Check the shop details in Shop verification first (shops without an address cannot be verified), then analyse`);
  // The smart plan works on verified shops; the others wait and are reported.
  const sites = await Site.find({ project: projectId, deletedAt: null, ...verifiedFilter(project.requirementType) }).select('district location address1 address2 address3 pincode lat lng').lean();
  const saved = await CostPlan.findOne({ project: projectId }).select('rates').lean();
  const rates = saved?.rates ? ratesOf(saved.rates as Record<string, unknown>) : await getPolicy();
  // The project's own start point, else the company's default base, so the plan is priced with travel straight away.
  const own = originOf(project);
  // No start point chosen: the in-house team starts only from a saved Adinn place (Head Office, Factory), the one nearer to the shops.
  const placed = sites.filter(hasCoords) as unknown as LatLng[];
  const middle: LatLng | null = placed.length ? { lat: placed.reduce((a, p) => a + p.lat, 0) / placed.length, lng: placed.reduce((a, p) => a + p.lng, 0) / placed.length } : null;
  const places = await BaseLocation.find().select('name lat lng').lean();
  const hub = middle ? [...places].sort((a, b) => haversineKm(middle, a) - haversineKm(middle, b))[0] : places[0];
  const fallback = hub ?? { name: env.DEFAULT_BASE_NAME, lat: env.DEFAULT_BASE_LAT, lng: env.DEFAULT_BASE_LNG };
  const origin: LatLng = own ?? { lat: fallback.lat, lng: fallback.lng };
  const base = { name: own ? (project.originName ?? 'Start point') : fallback.name, ...origin, isDefault: !own };
  const unlocated = sites.length - placed.length;
  const vendors = await Vendor.find({ status: 'ACTIVE', deletedAt: null }).select('name district pincode serviceAreas skills ratePerShop farRatePerShop shopsPerDay availability address zohoContactId lat lng geoAt').lean();
  const pending = await withOwnPrices(vendors);
  await ensureVendorPlaces(vendors);
  // Zoho vendors that have a cost added in Vendor master but are not registered yet: shown as nearby options (they cannot be given shops until registered).
  const registeredZoho = new Set(vendors.map((v) => v.zohoContactId).filter(Boolean));
  const unregistered = (await VendorPrice.find({ ratePerShop: { $ne: null }, zohoStatus: { $ne: 'inactive' } }).select('zohoContactId vendorNo name city address skills ratePerShop farRatePerShop lat lng geoAt').lean()).filter((z) => !registeredZoho.has(z.zohoContactId));
  await ensureZohoPlaces(unregistered);
  // Only vendors listed in Vendor master with a cost ("Vendors with cost") are offered. Each carries the approval answer for its price.
  const zohoIds = [...vendors.map((v) => v.zohoContactId), ...unregistered.map((z) => z.zohoContactId)].filter((x): x is string => !!x);
  const approvalOf = new Map<string, string>();
  if (zohoIds.length) for (const a of await VendorRateApproval.find({ zohoContactId: { $in: zohoIds } }).sort({ createdAt: 1 }).select('zohoContactId status').lean()) if (a.status !== 'REPLACED') approvalOf.set(a.zohoContactId, a.status);
  const approvalTag = (id?: string | null) => { const a = id ? approvalOf.get(id) : undefined; return a === 'PENDING' ? 'Waiting for approval' : a === 'NOT_APPROVED' ? 'Rejected: company rate applied' : ''; };
  const wanted = body.skills.map((s) => s.toLowerCase());
  const zoho = await zohoVendorsWithPlace();
  const startDay = tomorrow();
  const busy = new Set(vendors.filter((v) => v.availability === 'BUSY').map((v) => String(v._id)));

  const shops = sites.map((s) => ({ id: String(s._id), district: (s.district ?? '').trim(), location: s.location ?? null, lat: s.lat ?? null, lng: s.lng ?? null, pincode: s.pincode ?? null }));
  // `district` mode: a radius so large that nothing splits inside a district.
  const clusters = clusterShops(shops, origin, body.groupBy === 'district' ? 100000 : undefined);

  const proposals = clusters.map((g) => {
    const count = g.shops.length;
    const warnings: string[] = [];
    if (g.located === 0) warnings.push('None of these shops are on the map, so travel is not counted. Use "Locate shops from address" in Shop Allocation.');
    else if (g.located < count) warnings.push(`${count - g.located} of ${count} shops are not on the map; their travel is not counted.`);
    const est = estimateTrip(count, g.distanceKm, g.routeKm || undefined, startDay);
    const inHouse = calculateLeg({ shops: count, distanceKm: g.distanceKm, routeKm: est.routeKm, tripStart: est.tripStart, tripEnd: est.tripEnd }, rates);

    const all = vendors
      .map((v) => {
        const local = sameName(v.district, g.district) || g.towns.some((t) => sameName(v.district, t));
        const places = [g.district, ...g.towns, ...g.pincodes].filter(Boolean);
        const covers = local || (v.serviceAreas ?? []).some((a) => places.some((p) => sameName(a, p))) || (!!v.address && places.some((p) => normKey(p).length >= 4 && normKey(v.address ?? '').includes(normKey(p))));
        const have = (v.skills ?? []).map((s) => s.toLowerCase());
        const skillMatch = wanted.length === 0 || wanted.every((w) => have.some((h) => h.includes(w)));
        const at = hasCoords(v) ? { lat: v.lat as number, lng: v.lng as number } : null;
        // The vendor's "far" rate depends on how far the vendor is from these shops, not on how far the shops are from ADINN.
        const calc = calculateLeg({ shops: count, distanceKm: vendorKm(local, at, g.centre, g.distanceKm), cardRate: v.ratePerShop, cardFarRate: v.farRatePerShop }, rates);
        return { point: at, place: v.district ?? null, hasCost: !!v.zohoContactId && v.ratePerShop != null, approvalTag: approvalTag(v.zohoContactId), nearKm: null as number | null, rateSource: (v.ratePerShop != null ? 'VENDOR' : 'COMPANY') as 'VENDOR' | 'COMPANY', pendingRate: pending.get(String(v._id))?.requested ?? null, vendorId: String(v._id), name: v.name, covers, local, skillMatch, skills: v.skills ?? [], perShopRate: calc.vendor.perShopRate, total: calc.vendor.total, perShop: calc.vendor.perShop, needsApproval: calc.needsApproval.VENDOR, cardRate: v.ratePerShop ?? null, cardFarRate: v.farRatePerShop ?? null, shopsPerDay: v.shopsPerDay ?? null, days: v.shopsPerDay ? Math.ceil(count / v.shopsPerDay) : null };
      });
    const rank = (a: (typeof all)[number], b: (typeof all)[number]) => Number(a.needsApproval) - Number(b.needsApproval) || Number(b.skillMatch) - Number(a.skillMatch) || a.total - b.total || Number(b.local) - Number(a.local);
    // Only vendors with a price saved are offered. Shown: the one that works in the area (cheapest), the nearest ones, the lowest cost.
    const from = g.centre ?? origin;
    const priced = all
      .filter((o) => o.hasCost && (o.skillMatch || !body.requireSkills) && !busy.has(o.vendorId))
      .map((o) => ({ ...o, nearKm: o.point ? Math.round(haversineKm(from, o.point) * ROAD_FACTOR) : null as number | null }));
    const covering = priced.filter((o) => o.covers).sort(rank);
    const byNear = [...priced].filter((o) => o.nearKm != null).sort((a, b) => a.nearKm! - b.nearKm! || a.total - b.total);
    const lowest = [...priced].sort((a, b) => a.total - b.total)[0];
    const lead = covering[0] ?? byNear[0] ?? lowest;
    const picked = new Map<string, (typeof priced)[number]>();
    for (const o of [lead, ...[...priced].sort((a, b) => a.total - b.total).slice(0, 3), ...byNear.slice(0, 2), ...covering.slice(1, 2)]) if (o && !picked.has(o.vendorId)) picked.set(o.vendorId, o);
    const options = [...picked.values()].slice(0, 5).map((o) => ({ ...o, tags: [o.approvalTag, o.covers ? 'Works in this area' : '', o === byNear[0] ? 'Nearest' : '', o === lowest ? 'Lowest cost' : ''].filter(Boolean) }));
    const nearest = covering.length === 0 && options.length > 0;
    const outside = unregistered
      .map((z) => {
        const hay = normKey(`${z.city ?? ''} ${z.address ?? ''}`);
        const places = [g.district, ...g.towns, ...g.pincodes].filter(Boolean);
        const covers = places.some((p) => normKey(p).length >= 4 && hay.includes(normKey(p)));
        const have = (z.skills ?? []).map((s) => s.toLowerCase());
        const skillMatch = wanted.length === 0 || wanted.every((w) => have.some((h) => h.includes(w)));
        const km = hasCoords(z) ? Math.round(haversineKm(from, { lat: z.lat as number, lng: z.lng as number }) * ROAD_FACTOR) : null;
        const calc = calculateLeg({ shops: count, distanceKm: covers ? 0 : km ?? g.distanceKm, cardRate: z.ratePerShop, cardFarRate: z.farRatePerShop }, rates);
        return { vendorId: `zoho:${z.zohoContactId}`, name: z.name ?? 'Zoho vendor', place: z.city ?? null, registered: false, covers, local: covers, skillMatch, skills: z.skills ?? [], perShopRate: calc.vendor.perShopRate, total: calc.vendor.total, perShop: calc.vendor.perShop, needsApproval: calc.needsApproval.VENDOR, cardRate: z.ratePerShop ?? null, cardFarRate: z.farRatePerShop ?? null, shopsPerDay: null, days: null, rateSource: 'VENDOR' as const, pendingRate: null, nearKm: km, tags: [approvalTag(z.zohoContactId)].filter(Boolean) };
      })
      .filter((o) => o.skillMatch || !body.requireSkills)
      .sort((a, b) => (a.nearKm ?? 1e9) - (b.nearKm ?? 1e9) || a.total - b.total)
      .slice(0, 3);
    // Zoho vendors with a cost can be given shops too (their CRM record is created then), so the cheapest of both groups is suggested.
    const best = [options[0], ...outside.filter((o) => o.skillMatch || !body.requireSkills)].filter((o): o is NonNullable<typeof o> => !!o).sort((a, b) => Number(a.needsApproval) - Number(b.needsApproval) || a.total - b.total)[0];
    const registered = new Set(vendors.map((v) => v.zohoContactId).filter(Boolean));
    const zohoNear = zohoMatches(zoho, [g.district, ...g.towns], g.pincodes).filter((z) => !registered.has(z.zohoContactId)).slice(0, 5);

    const reasons: string[] = [];
    let channel: Channel = 'IN_HOUSE';
    if (nearest && best) reasons.push(`No vendor with a price is based in or serves ${g.name}. The nearest is ${best.name}${best.nearKm != null ? `, about ${best.nearKm} km away` : ''}.`);
    if (covering.length === 0 && zohoNear.length) reasons.push(`Zoho vendors near this area (not registered yet): ${zohoNear.slice(0, 3).map((z) => `${z.name} (${z.city || z.match.toLowerCase()})`).join(', ')}. Register one in Vendor master to give them these shops.`);
    if (!best) {
      reasons.push(`No registered vendor covers ${g.name}${body.requireSkills && wanted.length ? ' with the needed skills' : ''}, so the in-house team is suggested.`);
    }
    else {
      const hNeeds = inHouse.needsApproval.IN_HOUSE;
      const vNeeds = best.needsApproval;
      channel = hNeeds === vNeeds ? (inHouse.inHouse.total <= best.total ? 'IN_HOUSE' : 'VENDOR') : hNeeds ? 'VENDOR' : 'IN_HOUSE';
      const gap = Math.round(Math.abs(inHouse.inHouse.total - best.total));
      reasons.push(channel === 'IN_HOUSE'
        ? `In-house ₹${Math.round(inHouse.inHouse.total)} against ${best.name} ₹${Math.round(best.total)}: ${hNeeds === vNeeds ? `saves ₹${gap}` : 'the vendor price breaks a limit'}.`
        : `${best.name} ₹${Math.round(best.total)} against in-house ₹${Math.round(inHouse.inHouse.total)}: ${hNeeds === vNeeds ? `saves ₹${gap}` : 'in-house breaks a limit'}.`);
      // The in-house trip cost is mostly fixed (travel, food, stay); the vendor charges for every shop.
      const breakEven = best.perShopRate > 0 ? Math.ceil(inHouse.inHouse.total / best.perShopRate) : 0;
      if (breakEven > 0) reasons.push(channel === 'IN_HOUSE' ? `The team stays cheaper while one trip has at least ${breakEven} shops here (this area has ${count}).` : `The team would beat ${best.name} only with ${breakEven}+ shops in one trip (this area has ${count}).`);
      if (best.local) reasons.push(`${best.name} is based in ${g.district}.`);
      if (wanted.length && best.skillMatch) reasons.push(`Has the skills: ${body.skills.join(', ')}.`);
      if (wanted.length && !best.skillMatch) reasons.push('No covering vendor has every needed skill; the cheapest is shown.');
    }
    // Without a shop position the in-house travel is not counted, so its price is too low to compare: do not let it win.
    if (g.located === 0 && best && channel === 'IN_HOUSE') { channel = 'VENDOR'; reasons.unshift(`The in-house price is not reliable (no shop is on the map, so travel is not counted). ${best.name} is suggested until the shops are located.`); }
    if (body.mode === 'IN_HOUSE' && channel !== 'IN_HOUSE') { channel = 'IN_HOUSE'; reasons.unshift('In-house only was chosen, so the team is used for this area.'); }
    else if (body.mode === 'VENDOR') {
      if (best) { if (channel !== 'VENDOR') reasons.unshift(`Vendors only was chosen, so ${best.name} is used for this area.`); channel = 'VENDOR'; }
      else warnings.push('Vendors only was chosen but no active vendor covers this area. The team is shown; pick a vendor by hand or register one.');
    }
    reasons.push(`In-house trip: ${est.days} field day${est.days > 1 ? 's' : ''}, ${Math.max(0, est.days - 1)} night${est.days > 2 ? 's' : ''}, about ${Math.round(est.routeKm)} km (travel ₹${Math.round(inHouse.inHouse.fuel)}, local ₹${Math.round(inHouse.inHouse.local)}, food ₹${Math.round(inHouse.inHouse.food)}, stay ₹${Math.round(inHouse.inHouse.stay)}).`);
    if (channel === 'IN_HOUSE' && inHouse.needsApproval.IN_HOUSE) reasons.push(...inHouse.reasons.filter((r) => /In-house/.test(r)));
    const chosenTotal = channel === 'IN_HOUSE' ? inHouse.inHouse.total : best!.total;
    return {
      key: g.key, name: g.name, district: g.district, towns: g.towns, shops: count, located: g.located, distanceKm: g.distanceKm, routeKm: est.routeKm, siteIds: g.shops.map((s) => s.id),
      tripStart: est.tripStart, tripEnd: est.tripEnd,
      inHouse: { total: inHouse.inHouse.total, perShop: inHouse.inHouse.perShop, needsApproval: inHouse.needsApproval.IN_HOUSE, days: est.days, nights: Math.max(0, est.days - 1), travel: inHouse.inHouse.fuel, local: inHouse.inHouse.local, food: inHouse.inHouse.food, stay: inHouse.inHouse.stay },
      vendors: [...options.map(({ point: _p, hasCost: _h, approvalTag: _t, ...rest }) => ({ ...rest, registered: true })), ...outside],
      zohoNearby: zohoNear,
      recommended: { channel, vendorId: channel === 'VENDOR' ? best!.vendorId : null, vendorName: channel === 'VENDOR' ? best!.name : null, total: chosenTotal, perShop: Math.round((chosenTotal / count) * 100) / 100 },
      reasons, warnings,
    };
  });
  const round = (n: number) => Math.round(n * 100) / 100;
  const totals = {
    shops: proposals.reduce((a, p) => a + p.shops, 0),
    areas: proposals.length,
    suggested: round(proposals.reduce((a, p) => a + p.recommended.total, 0)),
    allInHouse: round(proposals.reduce((a, p) => a + p.inHouse.total, 0)),
    allVendor: round(proposals.reduce((a, p) => a + (p.vendors[0]?.total ?? p.inHouse.total), 0)),
    inHouseShops: proposals.filter((p) => p.recommended.channel === 'IN_HOUSE').reduce((a, p) => a + p.shops, 0),
    vendorShops: proposals.filter((p) => p.recommended.channel === 'VENDOR').reduce((a, p) => a + p.shops, 0),
  };
  const slim = proposals.map(({ tripStart: _a, tripEnd: _b, ...rest }) => rest);
  if (!body.apply) return { applied: false, groupBy: body.groupBy, proposals: slim, totals, verification: readiness, base, unlocated };

  const plan = await loadEditable(projectId, actor);
  if (!own) await Project.updateOne({ _id: projectId }, { originName: base.name, originLat: origin.lat, originLng: origin.lng });
  // One CRM record per Zoho vendor, even when several routes pick the same vendor (created once, one after the other).
  const adopted = new Map<string, Types.ObjectId>();
  const legOf = async (p: (typeof proposals)[number]) => {
    const v = p.recommended.channel === 'VENDOR' ? p.vendors.find((o) => o.vendorId === p.recommended.vendorId) : undefined;
    let vendorRecord: Types.ObjectId | null = null;
    if (v) {
      if (v.vendorId.startsWith('zoho:')) {
        vendorRecord = adopted.get(v.vendorId) ?? ((await adoptZohoVendor(v.vendorId.slice(5), actor))._id as Types.ObjectId);
        adopted.set(v.vendorId, vendorRecord);
      } else vendorRecord = new Types.ObjectId(v.vendorId);
    }
    return {
      key: p.key, name: p.name, district: p.district, shops: p.shops, distanceKm: p.distanceKm, routeKm: p.routeKm, deadline: isoDay(project.targetDate),
      channel: p.recommended.channel, vendor: vendorRecord, vendorName: v?.name ?? null, cardRate: v?.cardRate ?? null, cardFarRate: v?.cardFarRate ?? null,
      vendorOther: 0, tripStart: p.tripStart, tripEnd: p.tripEnd, clientsShared: 1, otherAmount: 0, clustered: body.groupBy === 'area', autoSelected: true,
    };
  };
  const legs = [];
  for (const p of proposals) legs.push(await legOf(p));
  // Shops carry their area so that "Confirm and assign" gives each group to its team or vendor.
  await Site.updateMany({ project: projectId, deletedAt: null }, { $unset: { planArea: 1 } });
  if (body.groupBy === 'area') for (const p of proposals) await Site.updateMany({ _id: { $in: p.siteIds } }, { $set: { planArea: p.key } });
  plan.set({ legs, updatedBy: actor.id });
  reopen(plan);
  await plan.save();
  await recordAudit({ actor, action: 'COST_SUGGEST_APPLY', entity: 'CostPlan', entityId: plan._id, project: projectId, reason: `${body.mode} mode, ${legs.length} area(s): ${totals.inHouseShops} shops in-house, ${totals.vendorShops} to vendors, ₹${totals.suggested}` });
  return { applied: true, groupBy: body.groupBy, proposals: slim, totals, verification: readiness, base, unlocated, plan: await getPlan(projectId) };
}

// ---------- Named start points (Adinn Factory, Adinn Head Office) ----------
export const baseBody = z.object({ name: z.string().trim().min(2, 'Enter the place name').max(80), lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });
export const findPlaceBody = z.object({ address: z.string().trim().min(6, 'Type the full address').max(300) });
/** Finds a typed address on the map. Tries the whole address, then shorter ones (dropping the first lines, e.g. the door number), then the pincode. */
export async function findPlace(body: z.infer<typeof findPlaceBody>) {
  const parts = body.address.split(',').map((p) => p.trim()).filter(Boolean);
  const pincode = /\b\d{6}\b/.exec(body.address)?.[0];
  const pause = () => new Promise<void>((r) => setTimeout(r, env.NODE_ENV === 'test' ? 0 : 1100));
  // Most exact first: the whole address, then without the first line (door number, building), and so on; the pincode is the last resort.
  const clean = parts.map((p) => p.replace(/\b\d{6}\b/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  // The whole address, then its last 5, 4, 3 and 2 lines (area, town, state), so a building OpenStreetMap does not know still lands on its locality.
  const tries = [...new Set([clean.length, 5, 4, 3, 2].filter((n) => n >= 2 && n <= clean.length))];
  for (const n of tries) {
    const hit = await geocode({ address: clean.slice(-n).join(', ') }, pause);
    if (hit) return { lat: hit.lat, lng: hit.lng, exact: n === clean.length, quality: hit.quality };
    await pause();
  }
  if (pincode) {
    const hit = await geocode({ pincode }, pause);
    if (hit) return { lat: hit.lat, lng: hit.lng, exact: false, quality: hit.quality };
  }
  throw AppError.notFound('That address was not found on the map. Click the place on the map instead');
}
export const listBases = () => BaseLocation.find().sort({ name: 1 }).select('name lat lng').lean();
export async function addBase(body: z.infer<typeof baseBody>, actor: Actor) {
  const nameKey = normKey(body.name);
  if (await BaseLocation.exists({ nameKey })) throw AppError.conflict(`${body.name} is already saved. Pick it from the list`);
  const b = await BaseLocation.create({ name: body.name, nameKey, lat: body.lat, lng: body.lng, createdBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'BaseLocation', entityId: b._id, reason: body.name });
  return { _id: b._id, name: b.name, lat: b.lat, lng: b.lng };
}
export async function removeBase(id: string, actor: Actor) {
  const b = await BaseLocation.findByIdAndDelete(id);
  if (!b) throw AppError.notFound('Place not found');
  await recordAudit({ actor, action: 'DELETE', entity: 'BaseLocation', entityId: b._id, reason: b.name });
  return { id };
}

// ---------- Editing the suggested areas, and who changed what ----------
export const editShopsBody = z.object({
  areaKey: z.string().trim().min(1).max(120),
  add: z.array(objectId).max(500).default([]),
  remove: z.array(objectId).max(500).default([]),
  reason: z.string().trim().min(3, 'Say why the shops are changed').max(300),
});

/** Every shop of the project with the planned area it sits in (none = not in any area), for the add / remove picker. */
export async function planShops(projectId: string) {
  await requireProject(projectId);
  const rows = await Site.find({ project: projectId, deletedAt: null }).sort({ seq: 1 }).limit(2000).select('shopName dealerName location district planArea lat lng pincode address1 address2 address3').lean();
  return rows.map((s) => ({ id: String(s._id), name: s.shopName || s.dealerName || '-', location: s.location ?? '', district: s.district ?? '', planArea: s.planArea ?? null, lat: s.lat ?? null, lng: s.lng ?? null, pincode: (s.pincode ?? '').replace(/\D/g, ''), address: [s.address3, s.address2, s.address1].filter(Boolean).join(' ') }));
}

/**
 * Operations adds extra shops to a suggested area or takes shops out of it. Added shops move from their old area; removed
 * shops are left out of the plan (nobody is assigned them). Counts are refreshed, an area left empty is dropped, the plan goes
 * back to draft and every change is written to the history that admin can read.
 */
export async function editPlanShops(projectId: string, body: z.infer<typeof editShopsBody>, actor: Actor) {
  const plan = await loadEditable(projectId, actor, false);
  const leg = plan.legs.find((l) => l.key === body.areaKey);
  if (!leg) throw AppError.notFound('That area is not in the plan');
  if (!leg.clustered) throw AppError.conflict('Shops can be moved only in a plan grouped by nearby areas. Analyse with "Nearby areas" and use the plan again');
  const overlap = body.add.filter((x) => body.remove.includes(x));
  if (overlap.length || (!body.add.length && !body.remove.length)) throw AppError.badRequest('Pick shops to add or to remove, not the same shop in both');
  const base = { project: projectId, deletedAt: null };
  const adding = await Site.find({ ...base, _id: { $in: body.add }, planArea: { $ne: body.areaKey } }).select('shopName dealerName planArea').lean();
  const removing = await Site.find({ ...base, _id: { $in: body.remove }, planArea: body.areaKey }).select('shopName dealerName').lean();
  if (!adding.length && !removing.length) throw AppError.conflict('Nothing to change: the shops are already where you asked');
  const nameOf = (s: { shopName?: string | null; dealerName?: string | null }) => s.shopName || s.dealerName || 'shop';
  if (adding.length) await Site.updateMany({ _id: { $in: adding.map((s) => s._id) } }, { $set: { planArea: body.areaKey } });
  if (removing.length) await Site.updateMany({ _id: { $in: removing.map((s) => s._id) } }, { $unset: { planArea: 1 } });
  const counts = new Map((await Site.aggregate([{ $match: { project: new Types.ObjectId(projectId), deletedAt: null, planArea: { $exists: true, $ne: '' } } }, { $group: { _id: '$planArea', n: { $sum: 1 } } }])).map((r) => [String(r._id), r.n as number]));
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  const kept = plan.legs.filter((l) => {
    const n = counts.get(l.key) ?? 0;
    if (n !== l.shops) changes.push({ field: `${l.name}: shops`, oldValue: l.shops, newValue: n });
    if (n === 0) return false;
    l.shops = n;
    return true;
  });
  if (adding.length) changes.push({ field: `${leg.name}: added`, oldValue: null, newValue: adding.map(nameOf).slice(0, 30).join(', ') });
  if (removing.length) changes.push({ field: `${leg.name}: removed`, oldValue: removing.map(nameOf).slice(0, 30).join(', '), newValue: null });
  plan.set({ legs: kept, updatedBy: actor.id });
  reopen(plan);
  await plan.save();
  await recordAudit({ actor, action: 'PLAN_SHOPS_EDIT', entity: 'CostPlan', entityId: plan._id, project: projectId, changes, reason: body.reason });
  return getPlan(projectId);
}

export const chooseBody = z.object({ areaKey: z.string().trim().min(1).max(120), channel: z.enum(CHANNELS), vendorId: z.string().regex(/^([a-f\d]{24}|zoho:\d{10,25})$/i, 'Invalid vendor').optional() });

/** Operations picks who does one area (the in-house team or a given vendor) after seeing the comparison. */
export async function chooseArea(projectId: string, body: z.infer<typeof chooseBody>, actor: Actor) {
  const plan = await loadEditable(projectId, actor, false);
  const leg = plan.legs.find((l) => l.key === body.areaKey);
  if (!leg) throw AppError.notFound('That area is not in the plan');
  const was = leg.channel === 'VENDOR' ? `Vendor: ${leg.vendorName ?? '-'}` : leg.channel === 'IN_HOUSE' ? 'In-house' : 'Not chosen';
  if (body.channel === 'VENDOR') {
    if (!body.vendorId) throw AppError.badRequest('Pick the vendor');
    // A Zoho vendor from Vendor master gets its CRM record now.
    const id = body.vendorId.startsWith('zoho:') ? String((await adoptZohoVendor(body.vendorId.slice(5), actor))._id) : body.vendorId;
    const v = await Vendor.findOne({ _id: id, deletedAt: null }).select('name status zohoContactId ratePerShop farRatePerShop').lean();
    if (!v) throw AppError.notFound('Vendor not found');
    await withOwnPrices([v]);
    if (v.status !== 'ACTIVE') throw AppError.conflict(`${v.name} is not an active vendor`);
    leg.set({ channel: 'VENDOR', vendor: v._id, vendorName: v.name, cardRate: v.ratePerShop ?? null, cardFarRate: v.farRatePerShop ?? null, autoSelected: false });
  } else {
    leg.set({ channel: 'IN_HOUSE', vendor: null, vendorName: null, cardRate: null, cardFarRate: null, autoSelected: false });
  }
  const now = body.channel === 'VENDOR' ? `Vendor: ${leg.vendorName}` : 'In-house';
  plan.set({ updatedBy: actor.id });
  reopen(plan);
  await plan.save();
  await recordAudit({ actor, action: 'PLAN_CHOOSE', entity: 'CostPlan', entityId: plan._id, project: projectId, changes: [{ field: `${leg.name}: who does it`, oldValue: was, newValue: now }], reason: 'Chosen by Operations' });
  return getPlan(projectId);
}

/** Everything done to the plan (suggestions, shop changes, who does which area), newest first. */
export const planHistory = (projectId: string) => listAudit({ project: new Types.ObjectId(projectId), entity: 'CostPlan' }, 200);

// ---------- Shop verification status and Zoho vendors near an area ----------

/** How many shops are verified (Operations, and BD for a measurement project) and how many cannot be verified yet. */
export async function verificationOf(projectId: string, requirementType?: string | null) {
  const base = { project: projectId, deletedAt: null };
  const [total, verified, noAddress] = await Promise.all([
    Site.countDocuments(base),
    Site.countDocuments({ ...base, ...verifiedFilter(requirementType) }),
    Site.countDocuments({ ...base, ...NO_ADDRESS }),
  ]);
  return { total, verified, unverified: total - verified, noAddress, allVerified: total > 0 && verified === total };
}
export async function planReadiness(projectId: string) {
  const project = await requireProject(projectId);
  return verificationOf(projectId, project.requirementType);
}

interface ZohoPlace { zohoContactId: string; vendorNo?: string | null; name: string; city: string; address: string; mobile?: string | null; ratePerShop: number | null }
/** Active Zoho vendors that have a cost (the Zoho list itself is not stored) and a city or address, with their price per shop. */
async function zohoVendorsWithPlace(): Promise<ZohoPlace[]> {
  const rows = await VendorPrice.find({ ratePerShop: { $ne: null }, name: { $nin: [null, ''] }, zohoStatus: { $ne: 'inactive' }, $or: [{ city: { $nin: [null, ''] } }, { address: { $nin: [null, ''] } }] }).select('zohoContactId vendorNo name city address mobile ratePerShop').lean();
  return rows.map((r) => ({ zohoContactId: r.zohoContactId, vendorNo: r.vendorNo ?? null, name: r.name ?? '', city: r.city ?? '', address: r.address ?? '', mobile: r.mobile ?? null, ratePerShop: r.ratePerShop ?? null }));
}

/**
 * Zoho vendors that work near an area, found from the shops' area (town), district and pincode against the vendor's city and
 * address: the same town or pincode first, then the same district. Used when an address cannot be placed on the map.
 */
function zohoMatches(list: ZohoPlace[], places: string[], pincodes: string[]) {
  const [district, ...towns] = places;
  const out: (ZohoPlace & { match: 'AREA' | 'DISTRICT' })[] = [];
  const has = (hay: string, needle?: string) => !!needle && normKey(needle).length >= 4 && normKey(hay).includes(normKey(needle));
  for (const z of list) {
    const hay = `${z.city} ${z.address}`;
    const area = towns.some((t) => has(hay, t)) || pincodes.some((p) => p.length >= 6 && hay.replace(/\s/g, '').includes(p));
    if (area) out.push({ ...z, match: 'AREA' });
    else if (has(hay, district)) out.push({ ...z, match: 'DISTRICT' });
  }
  return out.sort((a, b) => Number(b.match === 'AREA') - Number(a.match === 'AREA') || (a.ratePerShop ?? Infinity) - (b.ratePerShop ?? Infinity) || a.name.localeCompare(b.name));
}
