import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { User } from '../users/user.model';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { revisionLabel } from '../ratecards/ratecard.model';
import { approvalGaps } from './approval.service';
import { getOrder } from './order.service';
import { phpMailAvailable } from './phpMail';
import { LEAD_FLOW, LEAD_STAGES, SalesOrder, type LeadStage } from './sales.model';
import type { leadListQuery } from './sales.validators';

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  NEW_LEAD: 'New Lead',
  PROJECT_ASSIGN: 'Project Assign',
  CLIENT_REGISTERED: 'Client Registered',
  REQUIREMENT_DISCUSSION: 'Requirement Discussion',
  RATE_CARD: 'Rate Card Preparation',
  NEGOTIATION: 'Negotiation in Progress',
  CLIENT_APPROVAL: 'Client Rate Approval',
};

/** Stages that can be worked in today. The older stages are kept (switched off) for later reuse. */
const AVAILABLE: readonly LeadStage[] = LEAD_FLOW;

/** Every lead follows New Lead -> Project Assign, for new and existing clients alike. */
export const stagesFor = (_clientType: string): LeadStage[] => [...LEAD_FLOW];

/** The project can be handed to Client Servicing (or the Recce team) at Project Assign. */
export const handoverUnlocked = (lead: { stage?: string | null; status?: string | null } | null | undefined) => lead?.stage === 'PROJECT_ASSIGN';

/**
 * Leads still open in a stage of the previous six-stage flow move to Project Assign, keeping that stage in
 * `lead.legacyStage` (their notes, rate cards and documents stay on the order). Runs once per server start.
 */
let legacyMoved: Promise<unknown> | null = null;
const moveLegacyLeads = () =>
  (legacyMoved ??= SalesOrder.updateMany(
    { lead: { $ne: null }, 'lead.status': { $ne: 'COMPLETED' }, 'lead.stage': { $nin: LEAD_FLOW } },
    [{ $set: { 'lead.legacyStage': '$lead.stage', 'lead.stage': 'PROJECT_ASSIGN' } }],
    { updatePipeline: true },
  ).catch((e) => {
    legacyMoved = null;
    throw e;
  }));

const leadLog = (actor: Actor, action: string, fromStage: string | null, toStage: string | null, note?: string) => ({
  _id: new Types.ObjectId(),
  action,
  fromStage,
  toStage,
  by: new Types.ObjectId(actor.id),
  role: actor.role,
  at: new Date(),
  note,
});

const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);

/** Lead Management is BD work; Client Servicing only sees the orders handed to them. */
export function assertLeadAccess(actor: Actor) {
  if (actor.role === 'CLIENT_SERVICING') throw AppError.forbidden();
}

async function liveLead(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('orderNo client clientType stage lead currentRevision onboardingPdf csAssignee requirementNotesArray._id');
  if (!o) throw AppError.notFound('Order not found');
  if (!o.lead) throw AppError.notFound('This order is not a lead yet');
  return o as typeof o & { lead: NonNullable<typeof o.lead> };
}

const assertOpen = (lead: { status?: string | null }) => {
  if (lead.status === 'CLOSED') throw AppError.conflict('This lead is closed. Reopen it to continue.');
  if (lead.status === 'COMPLETED') throw AppError.conflict('This lead is completed: the client approved the rate card.');
};

/** Current approval proof types of an order (replaced documents left out). */
async function approvalTypes(orderId: unknown) {
  const o = await SalesOrder.findById(orderId).select('approvalDocumentsArray.docType approvalDocumentsArray.supersededAt').lean();
  return (o?.approvalDocumentsArray ?? []).filter((d) => !d.supersededAt).map((d) => d.docType);
}

/** What still has to be done before `stage` can be completed (empty when it can). */
async function missingFor(
  stage: LeadStage,
  o: { _id: unknown; client: unknown; clientType: string; currentRevision?: number | null; requirementNotesArray?: unknown[]; onboardingPdf?: { fileId?: unknown } | null; csAssignee?: unknown; recceAssignee?: unknown },
) {
  if (stage === 'PROJECT_ASSIGN') return o.csAssignee || o.recceAssignee ? [] : ['Assign the project to Client Servicing or the Recce team'];
  if (stage === 'CLIENT_REGISTERED') {
    const c = await Client.findById(o.client).select('email contacts').lean();
    const missing: string[] = [];
    if (!c?.email) missing.push('Add the company email to the client details');
    if (!c?.contacts?.some((k) => k.phone)) missing.push('Add a contact person with a mobile number');
    if (!o.onboardingPdf?.fileId) missing.push('Save the Customer Onboarding Form to generate its PDF');
    // The email is required once the PHP mail service is connected; until then the PDF is enough to move on.
    else if (phpMailAvailable() && !(await SalesOrder.exists({ _id: o._id, salesprofile: { $elemMatch: { kind: 'ONBOARDING', status: 'SENT' } } })))
      missing.push('Send the Customer Onboarding Form email');
    return missing;
  }
  if (stage === 'REQUIREMENT_DISCUSSION' && !o.requirementNotesArray?.length) return ['Add at least one requirement note'];
  if ((stage === 'RATE_CARD' || stage === 'NEGOTIATION') && !o.currentRevision) return ['Save the rate card'];
  if (stage === 'CLIENT_APPROVAL') return approvalGaps(o.clientType, await approvalTypes(o._id));
  return [];
}

/* ---------------------------------- reads ---------------------------------- */

/** Orders that are not leads yet (New Lead stage: "Select Order"). */
export async function leadCandidates(q: { q?: string | undefined }) {
  const filter: Record<string, unknown> = { deletedAt: null, lead: null };
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const clients = await Client.find({ deletedAt: null, $or: [{ name: re }, { clientName: re }, { clientNo: re }] }).select('_id').limit(500).lean();
    filter.$or = [{ orderNo: re }, { client: { $in: clients.map((c) => c._id) } }];
  }
  const rows = await SalesOrder.find(filter)
    .select('orderNo client clientType createdAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .populate({ path: 'client', select: 'name clientName clientNo city', match: { deletedAt: null } })
    .lean();
  // An order whose client was deleted (hidden) cannot become a lead.
  return rows.filter((o) => o.client).slice(0, 25);
}

/** Lead list: newest movement first, filterable by stage, status and client flag. */
export async function listLeads(q: z.infer<typeof leadListQuery>) {
  await moveLegacyLeads();
  const filter: Record<string, unknown> = { deletedAt: null, lead: { $ne: null } };
  if (q.stage) filter['lead.stage'] = q.stage;
  if (q.status === 'CLOSED') filter['lead.status'] = 'CLOSED';
  if (q.status === 'COMPLETED') filter['lead.status'] = 'COMPLETED';
  if (q.status === 'OPEN') filter['lead.status'] = { $nin: ['CLOSED', 'COMPLETED'] };
  if (q.clientType) filter.clientType = q.clientType;
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const clients = await Client.find({ deletedAt: null, $or: [{ name: re }, { clientName: re }, { clientNo: re }] }).select('_id').limit(500).lean();
    filter.$or = [{ orderNo: re }, { client: { $in: clients.map((c) => c._id) } }];
  }
  const [rows, total] = await Promise.all([
    SalesOrder.find(filter)
      .select('orderNo client clientType owner lead csAssignee handover.assignedAt currentRevision createdAt')
      .sort(parseSort(q.sort, ['lead.stageChangedAt', 'lead.startedAt', 'orderNo', 'createdAt'], '-lead.stageChangedAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('client', 'name clientName clientNo city')
      .populate('owner', 'name')
      .populate('csAssignee', 'name')
      .lean(),
    SalesOrder.countDocuments(filter),
  ]);
  const items = rows.map((o) => ({
    ...o,
    stageLabel: LEAD_STAGE_LABELS[o.lead!.stage as LeadStage],
    stageNumber: stagesFor(o.clientType).indexOf(o.lead!.stage as LeadStage) + 1,
    stageCount: stagesFor(o.clientType).length,
    rateCardLabel: o.currentRevision ? revisionLabel(o.currentRevision) : null,
  }));
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

/** KPI cards: open leads per stage, completed (won) and closed leads, and orders still waiting to become a lead. */
export async function leadSummary() {
  await moveLegacyLeads();
  const [byStage, closed, completed, waiting] = await Promise.all([
    SalesOrder.aggregate<{ _id: LeadStage; n: number }>([
      { $match: { deletedAt: null, lead: { $ne: null }, 'lead.status': { $nin: ['CLOSED', 'COMPLETED'] } } },
      { $group: { _id: '$lead.stage', n: { $sum: 1 } } },
    ]),
    SalesOrder.countDocuments({ deletedAt: null, 'lead.status': 'CLOSED' }),
    SalesOrder.countDocuments({ deletedAt: null, 'lead.status': 'COMPLETED' }),
    SalesOrder.countDocuments({ deletedAt: null, lead: null }),
  ]);
  const stages = Object.fromEntries(LEAD_FLOW.map((s) => [s, byStage.find((b) => b._id === s)?.n ?? 0])) as Record<LeadStage, number>;
  return { open: byStage.reduce((n, b) => n + b.n, 0), closed, completed, waiting, stages };
}

/** One lead for the mind map: the order, every stage with its status and dates, the handover branch and the history. */
export async function getLead(id: string) {
  await moveLegacyLeads();
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select('lead clientType currentRevision leadLogsArray requirementNotesArray._id requirementNotesArray.attachments.fileId rateCardArray.revision rateCardArray.phase approvalDocumentsArray.supersededAt')
    .populate('lead.startedBy', 'name role')
    .populate('lead.closedBy', 'name role')
    .populate('lead.completedBy', 'name role')
    .populate('leadLogsArray.by', 'name role')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  if (!o.lead) throw AppError.notFound('This order is not a lead yet');
  const order = await getOrder(id);
  const recceAssignee = order.recce?.assignee ? await User.findById(order.recce.assignee).select('name role').lean() : null;
  const lead = o.lead;
  const flow = stagesFor(o.clientType);
  const won = lead.status === 'COMPLETED';
  // A completed lead has every stage of its flow done.
  const current = won ? flow.length : flow.indexOf(lead.stage as LeadStage);
  const logs = [...(o.leadLogsArray ?? [])].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const byName = (u: unknown) => (u as { name?: string } | null)?.name ?? '';

  const stages = flow.map((key) => {
    const i = flow.indexOf(key);
    const status = i < 0 ? 'SKIPPED' : i < current ? 'DONE' : i === current ? 'CURRENT' : 'PENDING';
    const done = status === 'DONE' ? logs.find((l) => l.action === 'COMPLETE' && l.fromStage === key) : undefined;
    return {
      key,
      label: LEAD_STAGE_LABELS[key],
      number: flow.indexOf(key) + 1,
      status,
      available: AVAILABLE.includes(key),
      startedAt: status === 'CURRENT' ? lead.stageChangedAt : null,
      completedAt: done?.at ?? null,
      completedBy: done ? byName(done.by) : null,
    };
  });
  const notes = o.requirementNotesArray ?? [];
  const revisions = o.rateCardArray ?? [];
  const open = (lead.status ?? 'OPEN') === 'OPEN';
  return {
    order,
    lead: { ...lead, status: lead.status ?? 'OPEN' },
    stages,
    /** Still to do before the current stage can be completed. */
    missing: open
      ? await missingFor(lead.stage as LeadStage, { _id: o._id, client: order.client._id, clientType: o.clientType, currentRevision: o.currentRevision, requirementNotesArray: notes, onboardingPdf: order.onboardingPdf, csAssignee: order.csAssignee, recceAssignee: order.recce?.assignee })
      : [],
    onboarding: { pdf: order.onboardingPdf ?? null, mailEnabled: phpMailAvailable() },
    nextStage: won ? null : (flow[current + 1] ?? null),
    // New Lead is done when the order is created; there is no going back to it.
    previousStage: won || flow[current - 1] === 'NEW_LEAD' ? null : (flow[current - 1] ?? null),
    /** The current stage is the last one: completing it completes the lead. */
    lastStage: !won && current === flow.length - 1,
    nextAvailable: !!flow[current + 1] && AVAILABLE.includes(flow[current + 1]!),
    handover: { unlocked: handoverUnlocked(lead), assignee: order.csAssignee ?? null, assignedAt: order.handover?.assignedAt ?? null, type: order.handoverType ?? null },
    /** Project Assign: Recce team branch (codes, then the operations project assigned to a Recce / Operations person). */
    recce: { available: true, assignee: recceAssignee, assignedAt: order.recce?.assignedAt ?? null, projectCode: order.recce?.projectCode ?? null },
    summary: {
      notes: notes.length,
      documents: notes.reduce((n, x) => n + (x.attachments?.length ?? 0), 0),
      rateCardLabel: o.currentRevision ? revisionLabel(o.currentRevision) : null,
      negotiationRounds: revisions.filter((r) => r.phase === 'NEGOTIATION').length,
      approvalDocuments: (o.approvalDocumentsArray ?? []).filter((d) => !d.supersededAt).length,
    },
    history: logs.slice(0, 100).map((l) => ({ id: String(l._id), action: l.action, fromStage: l.fromStage ?? null, toStage: l.toStage ?? null, note: l.note ?? null, by: byName(l.by), role: l.role ?? '', at: l.at })),
  };
}

/* ---------------------------------- moves ---------------------------------- */

/** New Lead / Client Approach: the selected order becomes a lead and moves on to its next stage. */
export async function startLead(input: { orderId: string; initialNotes?: string | undefined }, actor: Actor) {
  const o = await SalesOrder.findOne({ _id: input.orderId, deletedAt: null }).select('orderNo clientType lead');
  if (!o) throw invalid('orderId', 'Choose an order');
  if (o.lead) throw AppError.conflict(`${o.orderNo} is already a lead.`);
  const next = stagesFor(o.clientType)[1]!;
  const now = new Date();
  // Conditional on "not a lead yet", so two people starting the same order at once create one lead.
  const r = await SalesOrder.updateOne(
    { _id: o._id, lead: null },
    {
      $set: { lead: { stage: next, stageChangedAt: now, startedAt: now, startedBy: actor.id, initialNotes: input.initialNotes, status: 'OPEN' }, updatedBy: actor.id },
      $push: { leadLogsArray: { $each: [leadLog(actor, 'START', null, 'NEW_LEAD', 'Lead created'), leadLog(actor, 'COMPLETE', 'NEW_LEAD', next)] } },
    },
  );
  if (!r.modifiedCount) throw AppError.conflict(`${o.orderNo} was made a lead meanwhile.`);
  await recordAudit({ actor, action: 'CREATE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'lead.stage', oldValue: null, newValue: next }], reason: `${o.orderNo}: lead created` });
  return getLead(String(o._id));
}

export async function updateInitialNotes(id: string, initialNotes: string, actor: Actor) {
  const o = await liveLead(id);
  assertOpen(o.lead);
  await SalesOrder.updateOne({ _id: o._id }, { $set: { 'lead.initialNotes': initialNotes, updatedBy: actor.id } });
  return getLead(id);
}

/** Marks `stage` (the lead's current stage) as done and moves to the next stage of this lead's flow. */
export async function completeStage(id: string, stage: LeadStage, note: string | undefined, actor: Actor) {
  const o = await liveLead(id);
  assertOpen(o.lead);
  if (o.lead.stage !== stage) throw AppError.conflict(`This lead is now in ${LEAD_STAGE_LABELS[o.lead.stage as LeadStage]}. Reload to see the latest.`);
  const flow = stagesFor(o.clientType);
  const next = flow[flow.indexOf(stage) + 1];
  if (!next) return completeLead(o, stage, note, actor);
  if (!AVAILABLE.includes(next)) throw AppError.conflict(`${LEAD_STAGE_LABELS[next]} opens in the next Lead Management update.`);
  const missing = await missingFor(stage, o);
  if (missing.length) throw new AppError(422, 'VALIDATION_ERROR', missing.join('. '), missing.map((message) => ({ path: 'stage', message })));
  const r = await SalesOrder.updateOne(
    { _id: o._id, 'lead.stage': stage, 'lead.status': { $ne: 'CLOSED' } },
    { $set: { 'lead.stage': next, 'lead.stageChangedAt': new Date(), updatedBy: actor.id }, $push: { leadLogsArray: leadLog(actor, 'COMPLETE', stage, next, note) } },
  );
  if (!r.modifiedCount) throw AppError.conflict('This lead was moved meanwhile. Reload to see the latest.');
  await recordAudit({ actor, action: 'STAGE_CHANGE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'lead.stage', oldValue: stage, newValue: next }], reason: `${o.orderNo}: ${LEAD_STAGE_LABELS[stage]} completed` });
  return getLead(id);
}

/** Project Assign done (the project is handed to Client Servicing or the Recce team): the lead is completed. */
async function completeLead(o: Awaited<ReturnType<typeof liveLead>>, stage: LeadStage, note: string | undefined, actor: Actor) {
  const missing = await missingFor(stage, o);
  if (missing.length) throw new AppError(422, 'VALIDATION_ERROR', missing.join('. '), missing.map((message) => ({ path: 'stage', message })));
  const now = new Date();
  const r = await SalesOrder.updateOne(
    { _id: o._id, 'lead.stage': stage, 'lead.status': 'OPEN' },
    {
      $set: { 'lead.status': 'COMPLETED', 'lead.completedAt': now, 'lead.completedBy': actor.id, 'lead.stageChangedAt': now, updatedBy: actor.id },
      $push: { leadLogsArray: leadLog(actor, 'COMPLETE', stage, null, note ?? 'Project assigned: lead completed') },
    },
  );
  if (!r.modifiedCount) throw AppError.conflict('This lead was moved meanwhile. Reload to see the latest.');
  await recordAudit({ actor, action: 'STAGE_CHANGE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'lead.status', oldValue: 'OPEN', newValue: 'COMPLETED' }], reason: `${o.orderNo}: lead completed` });
  return getLead(String(o._id));
}

/** Back to the previous stage of this lead's flow (recorded in the lead history). */
export async function previousStage(id: string, stage: LeadStage, note: string | undefined, actor: Actor) {
  const o = await liveLead(id);
  assertOpen(o.lead);
  if (o.lead.stage !== stage) throw AppError.conflict(`This lead is now in ${LEAD_STAGE_LABELS[o.lead.stage as LeadStage]}. Reload to see the latest.`);
  const flow = stagesFor(o.clientType);
  const prev = flow[flow.indexOf(stage) - 1];
  if (!prev || prev === 'NEW_LEAD') throw AppError.conflict('This is the first stage of the lead.');
  const r = await SalesOrder.updateOne(
    { _id: o._id, 'lead.stage': stage, 'lead.status': { $ne: 'CLOSED' } },
    { $set: { 'lead.stage': prev, 'lead.stageChangedAt': new Date(), updatedBy: actor.id }, $push: { leadLogsArray: leadLog(actor, 'BACK', stage, prev, note) } },
  );
  if (!r.modifiedCount) throw AppError.conflict('This lead was moved meanwhile. Reload to see the latest.');
  await recordAudit({ actor, action: 'STAGE_CHANGE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'lead.stage', oldValue: stage, newValue: prev }], reason: `${o.orderNo}: moved back to ${LEAD_STAGE_LABELS[prev]}` });
  return getLead(id);
}

export async function closeLead(id: string, reason: string, actor: Actor) {
  const o = await liveLead(id);
  assertOpen(o.lead);
  const r = await SalesOrder.updateOne(
    { _id: o._id, 'lead.status': { $ne: 'CLOSED' } },
    {
      $set: { 'lead.status': 'CLOSED', 'lead.closedAt': new Date(), 'lead.closedBy': actor.id, 'lead.closeReason': reason, updatedBy: actor.id },
      $push: { leadLogsArray: leadLog(actor, 'CLOSE', o.lead.stage, o.lead.stage, reason) },
    },
  );
  if (r.modifiedCount) await recordAudit({ actor, action: 'UPDATE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'lead.status', oldValue: 'OPEN', newValue: 'CLOSED' }], reason });
  return getLead(id);
}

export async function reopenLead(id: string, actor: Actor) {
  const o = await liveLead(id);
  if (o.lead.status !== 'CLOSED') return getLead(id);
  const r = await SalesOrder.updateOne(
    { _id: o._id, 'lead.status': 'CLOSED' },
    {
      $set: { 'lead.status': 'OPEN', 'lead.stageChangedAt': new Date(), updatedBy: actor.id },
      $unset: { 'lead.closedAt': 1, 'lead.closedBy': 1, 'lead.closeReason': 1 },
      $push: { leadLogsArray: leadLog(actor, 'REOPEN', o.lead.stage, o.lead.stage) },
    },
  );
  if (r.modifiedCount) await recordAudit({ actor, action: 'UPDATE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'lead.status', oldValue: 'CLOSED', newValue: 'OPEN' }], reason: 'Lead reopened' });
  return getLead(id);
}

/* ------------------------- requirement discussion ------------------------- */

export async function listRequirementNotes(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('requirementNotesArray').populate('requirementNotesArray.createdBy', 'name role').lean();
  if (!o) throw AppError.notFound('Order not found');
  return [...(o.requirementNotesArray ?? [])].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

/** A requirement note: text and / or documents and reference images. */
export async function addRequirementNote(id: string, body: string, files: UploadedFile[], actor: Actor) {
  const o = await liveLead(id);
  assertOpen(o.lead);
  if (!body && !files.length) throw invalid('body', 'Write the requirement or attach a file');
  const client = await Client.findById(o.client).select('name').lean();
  const attachments: StoredFile[] = [];
  const noteId = new Types.ObjectId();
  try {
    for (const f of files) {
      attachments.push(await storeEmbeddedFile({ category: 'LEAD_REQUIREMENT_DOCUMENT', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file: f, actor, owner: { entity: 'SalesOrder', id: o._id } }));
    }
    await SalesOrder.updateOne(
      { _id: o._id },
      { $push: { requirementNotesArray: { _id: noteId, body, attachments, createdBy: actor.id, role: actor.role, createdAt: new Date() } }, $set: { updatedBy: actor.id } },
    );
  } catch (e) {
    await discardStoredFiles(attachments);
    throw e;
  }
  return (await listRequirementNotes(id)).find((n) => String(n._id) === String(noteId)) ?? null;
}

/** Only the person who wrote a note (or a Super Admin) may delete it; its files are erased from storage. */
export async function deleteRequirementNote(id: string, noteId: string, actor: Actor) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null, 'requirementNotesArray._id': noteId }, { 'requirementNotesArray.$': 1, lead: 1 }).lean();
  const note = o?.requirementNotesArray?.[0];
  if (!o || !note) throw AppError.notFound('Note not found');
  if (o.lead) assertOpen(o.lead);
  if (String(note.createdBy) !== actor.id && actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the person who wrote this note can delete it');
  const r = await SalesOrder.updateOne({ _id: o._id }, { $pull: { requirementNotesArray: { _id: note._id } } });
  if (!r.modifiedCount) throw AppError.notFound('Note not found');
  for (const a of note.attachments ?? []) await eraseStoredFile(a as StoredFile, actor, { entity: 'SalesOrder', id: o._id });
  await recordAudit({ actor, action: 'COMMENT_DELETED', entity: 'SalesOrder', entityId: o._id, reason: `Requirement note: ${note.body?.slice(0, 180) || `${note.attachments?.length ?? 0} file(s)`}` });
  return { id: noteId, deleted: true };
}
