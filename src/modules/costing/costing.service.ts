import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { escapeRegex, objectId, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { hasCoords, roadKm, type LatLng } from '../allocation/allocation.geo';
import { googleMapsAddressUrl } from '../allocation/allocation.maps';
import { notifyNewShops } from '../allocation/allocation.notify';
import { addressOf, planRoute, type RouteSite } from '../allocation/allocation.route';
import { clientNameOf } from '../clients/clientDetails';
import { listExpenses, notifyApprovers } from '../expenses/expense.service';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { changeStatus } from '../projects/project.service';
import { normKey } from '../sites/site.fields';
import { Site } from '../sites/site.model';
import { Vendor } from '../vendors/vendor.model';
import { calculateLeg, DEFAULT_RATES, totalsOf, type Channel, type CostRates, type LegInput } from './costing.calc';
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

const PROJECT_FIELDS = 'code client clientDetails siteCount status targetDate owner createdBy assignedTo originName originLat originLng';
async function requireProject(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select(PROJECT_FIELDS).lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}
const originOf = (p: { originLat?: number | null; originLng?: number | null }): LatLng | null => (hasCoords({ lat: p.originLat, lng: p.originLng }) ? { lat: p.originLat as number, lng: p.originLng as number } : null);
const isoDay = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);
const districtRe = (name: string) => new RegExp(`^\\s*${escapeRegex(name.trim())}\\s*$`, 'i');

type LegDoc = {
  key: string; name: string; district?: string | null; shops: number; distanceKm?: number | null; routeKm?: number | null; deadline?: string | null;
  channel?: Channel | null; vendor?: Types.ObjectId | null; vendorName?: string | null; vendorRate?: number | null; cardRate?: number | null; cardFarRate?: number | null;
  vendorOther?: number | null; tripStart?: string | null; tripEnd?: string | null; clientsShared?: number | null; otherAmount?: number | null;
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
  const legs = body.legs.map(({ vendorId, ...l }) => {
    const v = vendorId ? byId.get(vendorId) : undefined;
    if (vendorId && !v) throw AppError.notFound('Vendor not found');
    if (l.channel === 'VENDOR' && v && v.status !== 'ACTIVE') throw AppError.conflict(`${v.name} is not an active vendor`);
    return { ...l, vendor: v?._id ?? null, vendorName: v?.name ?? null, cardRate: v?.ratePerShop ?? null, cardFarRate: v?.farRatePerShop ?? null, channel: l.channel ?? null };
  });
  if (body.refreshRates) plan.set({ rates: (await getPolicy()) as unknown as Record<string, number> });
  plan.set({ legs, updatedBy: actor.id });
  reopen(plan);
  await plan.save();
  await recordAudit({ actor, action: 'UPDATE', entity: 'CostPlan', entityId: plan._id, project: projectId, reason: `${legs.length} area(s) saved` });
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
    project: { _id: project._id, code: project.code, clientName: client?.name }, dedupe: (r) => `cost-decision:${plan._id}:${plan.reviewedAt?.getTime()}:${r}`,
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
      { project: projectId, deletedAt: null, district: districtRe(leg.district) },
      leg.channel === 'VENDOR'
        ? { $set: { channel: 'VENDOR', vendor: leg.vendor, allocatedAt: now, allocatedBy: actor.id } }
        : { $set: { channel: 'IN_HOUSE', allocatedAt: now, allocatedBy: actor.id }, $unset: { vendor: 1 } },
    );
    assigned += r.modifiedCount;
    if (r.modifiedCount > 0) await notifyNewShops(projectId, leg.channel === 'VENDOR' ? { kind: 'VENDOR', vendorId: String(leg.vendor) } : { kind: 'IN_HOUSE' }, r.modifiedCount, actor);
  }
  plan.set({ status: 'ASSIGNED', assignedAt: new Date(), assignedBy: actor.id, updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: 'COST_ASSIGN', entity: 'CostPlan', entityId: plan._id, project: projectId, reason: `${assigned} shop(s) assigned${skipped.length ? `; not matched: ${skipped.join(', ')}` : ''}` });
  return { ...(await getPlan(projectId)), assigned, skipped };
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
