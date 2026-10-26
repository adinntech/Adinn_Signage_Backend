import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { objectId, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { listExpenses, notifyApprovers } from '../expenses/expense.service';
import { Project } from '../projects/project.model';
import { changeStatus } from '../projects/project.service';
import { Site } from '../sites/site.model';
import { Vendor } from '../vendors/vendor.model';
import { calculateCosts, DEFAULT_RATES, type Channel, type CostRates } from './costing.calc';
import { CHANNELS, CostPlan, CostPolicy, VENDOR_TYPES } from './costing.model';
import { notify } from '../notifications/notification.service';
import { Client } from '../clients/client.model';

const money = z.coerce.number().min(0).max(100_000_000);
export const planBody = z.object({
  vendorType: z.enum(VENDOR_TYPES).optional(),
  vendorName: z.string().trim().max(120).optional(),
  vendorId: objectId.optional(),
  shops: z.coerce.number().int().min(1, 'Enter the number of shops').max(100000),
  shopsCovered: z.coerce.number().int().min(1).max(100000).optional(),
  vendorDistanceKm: money.default(0),
  vendorOther: money.default(0),
  days: z.coerce.number().int().min(0).max(90).default(1),
  nights: z.coerce.number().int().min(0).max(90).default(0),
  totalKm: money.default(0),
  fuelAmount: money.default(0),
  otherAmount: money.default(0),
  clientsShared: z.coerce.number().int().min(1).max(20).default(1),
  refreshRates: z.boolean().optional(),
});
export const chooseBody = z.object({ channel: z.enum(CHANNELS), justification: z.string().trim().max(1000).optional() });
export const decideBody = z
  .object({ approve: z.boolean(), remark: z.string().trim().max(1000).optional() })
  .refine((v) => v.approve || !!v.remark, { path: ['remark'], message: 'Say why it is rejected' });
export const clientBody = z
  .object({ decision: z.enum(['ACCEPTED', 'REJECTED', 'PENDING']), remark: z.string().trim().max(1000).optional() })
  .refine((v) => v.decision !== 'REJECTED' || (v.remark?.length ?? 0) >= 3, { path: ['remark'], message: 'Give the client\'s reason for rejecting the cost' });
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
  return ratesOf(d);
}

async function requireProject(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('code client siteCount expectedShops additionalShops status owner createdBy assignedTo').lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}

const inputOf = (p: Record<string, any>) => ({
  shops: p.shops, shopsCovered: p.shopsCovered ?? undefined, vendorDistanceKm: p.vendorDistanceKm ?? 0, vendorOther: p.vendorOther ?? 0,
  days: p.days ?? 1, nights: p.nights ?? 0, totalKm: p.totalKm ?? 0, fuelAmount: p.fuelAmount ?? 0, otherAmount: p.otherAmount ?? 0, clientsShared: p.clientsShared ?? 1,
});

/** The plan (or an unsaved starting point from the project) with every figure worked out, plus real expenses and sq.ft. */
export async function getPlan(projectId: string) {
  const project = await requireProject(projectId);
  const [saved, policy, sqft, expenses] = await Promise.all([
    CostPlan.findOne({ project: projectId }).lean(),
    getPolicy(),
    Site.aggregate([{ $match: { project: new Types.ObjectId(projectId), deletedAt: null } }, { $group: { _id: null, s: { $sum: '$sqft' }, n: { $sum: 1 } } }]),
    listExpenses(projectId),
  ]);
  const shops = (project.expectedShops ?? 0) + (project.additionalShops ?? 0) || project.siteCount || 1;
  const plan = saved ?? { _id: null, project: projectId, ...inputOf({ shops }), days: 1, status: 'DRAFT', clientDecision: 'PENDING', rates: policy };
  const rates = ratesOf((plan as Record<string, unknown>).rates as Record<string, unknown>);
  const calc = calculateCosts(inputOf(plan), rates);
  const chosen = (plan as { chosen?: Channel }).chosen;
  const chosenTotal = chosen ? (chosen === 'VENDOR' ? calc.vendor.total : calc.inHouse.total) : undefined;
  const totalSqft = Math.round((sqft[0]?.s ?? 0) * 100) / 100;
  return {
    plan,
    saved: !!saved,
    rates,
    calc,
    policy,
    shopsRecorded: sqft[0]?.n ?? 0,
    totalSqft,
    // What the client is shown after the recce: the chosen channel's cost per shop and per square foot.
    clientCost: chosenTotal === undefined ? null : { total: chosenTotal, perShop: Math.round((chosenTotal / Math.max(1, (plan as { shops: number }).shops)) * 100) / 100, perSqft: totalSqft ? Math.round((chosenTotal / totalSqft) * 100) / 100 : null },
    actual: { ...expenses.totals, byCategory: expenses.byCategory, perShop: Math.round((expenses.totals.all / Math.max(1, calc.inHouse.shopsCovered)) * 100) / 100 },
  };
}

export async function savePlan(projectId: string, body: z.infer<typeof planBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const { refreshRates, vendorId, ...input } = body;
  const existing = await CostPlan.findOne({ project: projectId });
  if (existing && existing.clientDecision === 'ACCEPTED') throw AppError.conflict('The client already accepted this cost, so it can no longer be edited');
  let rates: CostRates | undefined = !existing || refreshRates ? await getPolicy() : undefined;
  let vendorFields: Record<string, unknown> = { vendor: undefined };
  if (vendorId) {
    const v = await Vendor.findOne({ _id: vendorId, deletedAt: null }).select('name type status ratePerShop farRatePerShop').lean();
    if (!v) throw AppError.notFound('Vendor not found');
    if (v.status !== 'ACTIVE') throw AppError.conflict(`${v.name} is not an active vendor`);
    // The vendor's own rate card replaces the company rates for this plan.
    rates = { ...(rates ?? ratesOf(existing?.rates as Record<string, unknown>)), ...(v.ratePerShop != null ? { vendorRatePerShop: v.ratePerShop } : {}), ...(v.farRatePerShop != null ? { vendorFarRatePerShop: v.farRatePerShop } : {}) };
    vendorFields = { vendor: v._id, vendorName: v.name, vendorType: v.type };
  }
  if (!existing) {
    await CostPlan.create({ ...input, ...vendorFields, rates: rates as unknown as Record<string, number>, project: projectId, createdBy: actor.id, updatedBy: actor.id });
  } else {
    existing.set({ ...input, ...(vendorId ? vendorFields : { vendor: undefined }), ...(rates ? { rates: rates as unknown as Record<string, number> } : {}), updatedBy: actor.id });
    // Changed numbers must be re-chosen and, if needed, re-approved.
    if (existing.status !== 'DRAFT') existing.set({ status: 'DRAFT', chosen: undefined, justification: undefined, reviewRemark: undefined, reviewedBy: undefined, reviewedAt: undefined });
    await existing.save();
  }
  await recordAudit({ actor, action: existing ? 'UPDATE' : 'CREATE', entity: 'CostPlan', entityId: (existing?._id ?? (await CostPlan.findOne({ project: projectId }).select('_id').lean())!._id), project: projectId });
  return getPlan(projectId);
}

/** Operations picks vendor or in-house. If that choice breaks a limit it goes to admin as a special approval request. */
export async function chooseChannel(projectId: string, body: z.infer<typeof chooseBody>, actor: Actor) {
  const project = await requireProject(projectId);
  await assertNotCancelled(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan) throw AppError.conflict('Save the cost details first');
  if (plan.clientDecision === 'ACCEPTED') throw AppError.conflict('The client already accepted this cost');
  const { calc } = await getPlan(projectId);
  const needs = calc.needsApproval[body.channel];
  if (needs && (body.justification?.length ?? 0) < 5) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'justification', message: 'This choice is over the limit. Explain why it is needed' }]);
  plan.set({
    chosen: body.channel, justification: body.justification, status: needs ? 'APPROVAL_PENDING' : 'CONFIRMED',
    requestedBy: actor.id, requestedAt: new Date(), reviewRemark: undefined, reviewedBy: undefined, reviewedAt: undefined, updatedBy: actor.id,
  });
  await plan.save();
  await recordAudit({ actor, action: needs ? 'COST_APPROVAL_REQUEST' : 'COST_CONFIRM', entity: 'CostPlan', entityId: plan._id, project: projectId, changes: [{ field: 'chosen', oldValue: null, newValue: body.channel }], reason: body.justification });
  if (needs) {
    await notifyApprovers(project, `Special approval needed: ${project.code}`, `${body.channel === 'IN_HOUSE' ? 'In-house' : 'Vendor'} recce is over the cost limit. ${calc.reasons.join(' ')} Reason given: ${body.justification}`, `cost-request:${plan._id}:${plan.requestedAt?.getTime()}`, actor);
  }
  return getPlan(projectId);
}

/** Admin / Finance approve or reject the special-approval request. */
export async function decideApproval(projectId: string, body: z.infer<typeof decideBody>, actor: Actor) {
  const project = await requireProject(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan || plan.status !== 'APPROVAL_PENDING') throw AppError.conflict('There is no special approval waiting for this project');
  plan.set({ status: body.approve ? 'APPROVED' : 'REJECTED', reviewRemark: body.remark, reviewedBy: actor.id, reviewedAt: new Date(), ...(body.approve ? {} : { chosen: undefined }), updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: 'COST_APPROVAL', entity: 'CostPlan', entityId: plan._id, project: projectId, changes: [{ field: 'status', oldValue: 'APPROVAL_PENDING', newValue: plan.status }], reason: body.remark });
  const client = await Client.findById(project.client).select('name').lean();
  await notify({
    kind: 'COST_APPROVAL', recipients: [plan.requestedBy, project.assignedTo], actorId: actor.id,
    title: `Special approval ${body.approve ? 'granted' : 'rejected'}: ${project.code}`,
    body: body.approve ? `Your ${plan.chosen === 'IN_HOUSE' ? 'in-house' : 'vendor'} recce cost was approved.${body.remark ? ` ${body.remark}` : ''}` : `Your cost request was rejected: ${body.remark}. Choose another option.`,
    project: { _id: project._id, code: project.code, clientName: client?.name }, dedupe: (r) => `cost-decision:${plan._id}:${plan.reviewedAt?.getTime()}:${r}`,
  });
  return getPlan(projectId);
}

/** The client's answer to the cost. A rejected cost closes the project as LOSS, with the reason. */
export async function clientDecision(projectId: string, body: z.infer<typeof clientBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const plan = await CostPlan.findOne({ project: projectId });
  if (!plan) throw AppError.conflict('Save the cost details first');
  if (body.decision === 'ACCEPTED' && !['CONFIRMED', 'APPROVED'].includes(plan.status)) throw AppError.conflict('Confirm the vendor / in-house choice (and get any special approval) before the client accepts');
  plan.set({ clientDecision: body.decision, clientRemark: body.remark, clientDecidedAt: body.decision === 'PENDING' ? undefined : new Date(), updatedBy: actor.id });
  await plan.save();
  await recordAudit({ actor, action: 'CLIENT_COST_DECISION', entity: 'CostPlan', entityId: plan._id, project: projectId, changes: [{ field: 'clientDecision', oldValue: null, newValue: body.decision }], reason: body.remark });
  if (body.decision === 'REJECTED') await changeStatus(projectId, 'LOSS', `Client rejected the cost: ${body.remark}`, actor);
  return getPlan(projectId);
}
