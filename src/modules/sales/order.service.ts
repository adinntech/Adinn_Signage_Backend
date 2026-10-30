import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeq } from '../../common/counter.model';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { linkZohoCustomer, registerCompany } from '../clients/client.service';
import { findZohoByGstin, getZohoClient } from '../zoho/zoho.customers';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, storedFileUrl, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { EmailTemplate } from '../templates/template.model';
import { User } from '../users/user.model';
import { Project } from '../projects/project.model';
import { ORDER_STAGES, SalesOrder, WITHOUT_ARRAYS, type OrderStage } from './sales.model';
import { revisionLabel } from '../ratecards/ratecard.model';
import type { boardQuery, createOrderBody, orderListQuery, registerBody } from './sales.validators';

const CLIENT_FIELDS = 'name clientName clientNo code zohoCustomerNo email phone customFields gstCertificates industry address city district state pincode gstin contacts clientType status';
export const STAGE_LABELS: Record<OrderStage, string> = {
  NEW_ORDER: 'New Order',
  COMPANY_PROFILE: 'Company Profile',
  RATE_CARD: 'Rate Card',
  CLIENT_APPROVAL: 'Client Approval Proof',
};

/** One salespipelineLogs entry. */
export const pipelineLog = (actor: Actor, action: string, fromStage: string | null, toStage: string | null, notes?: string) => ({
  _id: new Types.ObjectId(),
  action,
  fromStage,
  toStage,
  movedBy: new Types.ObjectId(actor.id),
  role: actor.role,
  movedAt: new Date(),
  notes,
});

/** 20261025ORD#1: India date + a counter that starts again at 1 every day. */
async function nextOrderNo() {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replaceAll('-', '');
  return `${day}ORD#${await nextSeq(`salesOrder:${day}`)}`;
}

/** Existing BD ownership rule (same as projects): the BD who creates it owns it; others leave it unassigned. */
const defaultOwner = (actor: Actor) => (actor.role === 'BD' ? actor.id : undefined);

/** Lead log entry (same shape as lead.service's; kept here because order.service is imported by it). */
export const leadLog = (
  actor: Actor,
  action: string,
  fromStage: string | null,
  toStage: string | null,
  note?: string,
  change: { step?: string; oldValue?: unknown; newValue?: unknown } = {},
) => ({
  _id: new Types.ObjectId(),
  action,
  fromStage,
  toStage,
  by: new Types.ObjectId(actor.id),
  role: actor.role,
  at: new Date(),
  note,
  ...change,
});

/**
 * Every order is a lead from the start: New Lead (choosing the client and creating the order) is done here, so the
 * lead opens at Project Assign.
 */
async function createOrder(client: { _id: Types.ObjectId; name?: string | null }, clientType: 'NEW' | 'EXISTING', requestKey: string | undefined, actor: Actor, initialNotes?: string) {
  const note = `Order created (${clientType === 'NEW' ? 'new' : 'existing'} client)`;
  const now = new Date();
  const order = await SalesOrder.create({
    lead: { stage: 'PROJECT_ASSIGN', stageChangedAt: now, startedAt: now, startedBy: actor.id, status: 'OPEN', initialNotes },
    leadLogsArray: [
      // The client branch the user selected (New / Existing) and the company, as chosen at Create Project.
      leadLog(actor, 'START', null, 'NEW_LEAD', 'Lead created with the order', { step: 'client', newValue: { clientType, name: client.name ?? null } }),
      leadLog(actor, 'COMPLETE', 'NEW_LEAD', 'PROJECT_ASSIGN'),
    ],
    orderNo: await nextOrderNo(),
    client: client._id,
    clientType,
    stage: 'NEW_ORDER',
    stageChangedAt: new Date(),
    owner: defaultOwner(actor),
    requestKey,
    salespipelineLogs: [pipelineLog(actor, 'CREATE', null, 'NEW_ORDER', note)],
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  await recordAudit({ actor, action: 'CREATE', entity: 'SalesOrder', entityId: order._id, changes: [{ field: 'stage', oldValue: null, newValue: 'NEW_ORDER' }], reason: `${order.orderNo}: ${note}` });
  return order;
}

/** Repeat submission of the same form: hand back what the first submission created. */
async function replay(requestKey: string | undefined) {
  if (!requestKey) return null;
  const order = await SalesOrder.findOne({ requestKey }).select('_id client').lean();
  return order ? { order: await getOrder(String(order._id)), client: await Client.findById(order.client).lean(), replayed: true } : null;
}

/** New Client: company + contacts + its first order (New Order column), all or nothing. */
export async function registerNewClient(input: z.infer<typeof registerBody>, actor: Actor) {
  const again = await replay(input.requestKey);
  if (again) return again;
  const { requestKey, ...company } = input;
  const client = await registerCompany(company, actor);
  try {
    const order = await createOrder(client, 'NEW', requestKey, actor);
    return { client: client.toObject(), order: await getOrder(String(order._id)), replayed: false };
  } catch (e) {
    await Client.deleteOne({ _id: client._id }); // no company without its order
    if ((e as { code?: number }).code === 11000 && requestKey) {
      const raced = await replay(requestKey);
      if (raced) return raced;
    }
    throw e;
  }
}

/**
 * Order Management / Lead Management: a new order (and its lead). New Client = a client from Client Management;
 * Existing Client = a Zoho customer, linked to (or added as) a local client first. A client can have many orders.
 */
export async function createOrderForClient(input: z.infer<typeof createOrderBody>, actor: Actor) {
  const again = await replay(input.requestKey);
  if (again) return again;
  const { client, flag } = await resolveOrderClient(input, actor);
  try {
    const order = await createOrder(client, flag, input.requestKey, actor, input.initialNotes);
    return { client, order: await getOrder(String(order._id)), replayed: false };
  } catch (e) {
    if ((e as { code?: number }).code === 11000 && input.requestKey) {
      const raced = await replay(input.requestKey);
      if (raced) return raced;
    }
    throw e;
  }
}

/**
 * The client an order (or a lead's client change) is for: a Client Management client (New) or a Zoho customer linked
 * to / added as a local client (Existing). Rejects drafts, inactive clients and a New Client with a Zoho GSTIN.
 */
export async function resolveOrderClient(input: { clientId?: string | undefined; zohoId?: string | undefined; clientType?: 'NEW' | 'EXISTING' | undefined }, actor: Actor) {
  let client;
  if (input.zohoId) {
    const z = await getZohoClient(input.zohoId);
    if (!z) throw AppError.notFound('This customer is no longer in Zoho. Refresh the list and choose again.');
    client = await linkZohoCustomer(z, actor);
  } else {
    client = await Client.findOne({ _id: input.clientId, deletedAt: null }).lean();
    if (!client) throw AppError.notFound('Client not found');
  }
  if (client.status === 'DRAFT') throw AppError.badRequest('This client is still a draft. Finish it in Client Management before creating an order.');
  if (client.status !== 'ACTIVE') throw AppError.badRequest('This client is inactive. Reactivate it before creating an order.');
  const flag = input.clientType ?? (input.zohoId ? 'EXISTING' : 'NEW');
  // A New Client order may not use a company that Zoho already has (same GSTIN): that is an Existing Client. An
  // unverified Zoho lookup never blocks; clients without a GSTIN or already linked to Zoho are not checked.
  if (flag === 'NEW' && client.gstin && !client.zohoId) {
    const { match } = await findZohoByGstin(client.gstin);
    if (match) {
      const message = `GSTIN ${client.gstin} belongs to the Zoho customer "${match.name}". Create this order under Existing Client.`;
      throw new AppError(409, 'ZOHO_DUPLICATE_GST', message, [{ path: 'gstin', message, zohoId: match.zohoId, name: match.name }]);
    }
  }
  return { client, flag };
}

/**
 * Order Management list: newest first, searchable by order no / client name / Client ID, with the rate card and
 * handover status. A Client Servicing person sees only the orders handed to them ("My Orders").
 */
/* ---------------------- Client Servicing: My Orders workflow status ---------------------- */

export type CsStatus = 'PROJECT_ASSIGN' | 'RECCE_ASSIGNED' | 'COMPLETED' | 'CLOSED';
const PROJECT_DONE = ['COMPLETED'];
const PROJECT_CLOSED = ['CANCELLED', 'LOSS'];

/** Operations projects of this person's orders by end state (the order's `recce.project`). */
async function csProjectIds(actorId: string) {
  const orders = await SalesOrder.find({ deletedAt: null, csAssignee: actorId, 'recce.project': { $ne: null } }).select('recce.project').lean();
  const ids = orders.map((o) => o.recce!.project!);
  const ended = ids.length ? await Project.find({ _id: { $in: ids }, status: { $in: [...PROJECT_DONE, ...PROJECT_CLOSED] } }).select('status').lean() : [];
  return {
    done: ended.filter((p) => PROJECT_DONE.includes(p.status as string)).map((p) => p._id),
    closed: ended.filter((p) => PROJECT_CLOSED.includes(p.status as string)).map((p) => p._id),
  };
}

/**
 * My Orders status from the Client Servicing workflow (not the BD's completed handover):
 * CLOSED: lead closed, or its operations project cancelled / lost. COMPLETED: operations project completed.
 * RECCE_ASSIGNED: the Recce / Operations person is assigned (project running). PROJECT_ASSIGN: Assign to Recce Team in progress.
 */
function csStatusFilter(status: CsStatus, p: { done: Types.ObjectId[]; closed: Types.ObjectId[] }): Record<string, unknown> {
  const closed = { $or: [{ 'lead.status': 'CLOSED' }, { 'recce.project': { $in: p.closed } }] };
  if (status === 'CLOSED') return closed;
  const notClosed = { 'lead.status': { $ne: 'CLOSED' }, 'recce.project': { $nin: p.closed } };
  if (status === 'COMPLETED') return { ...notClosed, 'recce.project': { $in: p.done, $nin: p.closed } };
  if (status === 'RECCE_ASSIGNED') return { ...notClosed, 'recce.assignee': { $ne: null }, 'recce.project': { $nin: [...p.done, ...p.closed] } };
  return { ...notClosed, 'recce.assignee': null };
}

/** Counts for the My Orders cards: every order assigned to this person (not just one page). */
export async function csOrderSummary(actor: Actor) {
  if (actor.role !== 'CLIENT_SERVICING') throw AppError.forbidden();
  const base = { deletedAt: null, csAssignee: new Types.ObjectId(actor.id) };
  const p = await csProjectIds(actor.id);
  const count = (s?: CsStatus) => SalesOrder.countDocuments(s ? { ...base, ...csStatusFilter(s, p) } : base);
  const [total, projectAssign, recceAssigned, completed, closed] = await Promise.all([count(), count('PROJECT_ASSIGN'), count('RECCE_ASSIGNED'), count('COMPLETED'), count('CLOSED')]);
  return { total, projectAssign, recceAssigned, completed, closed };
}

const EMAIL_SENT = ['SENT', 'SKIPPED'];
/** Current step of the Client Servicing workflow, with the labels of its mind map (assign-steps / lead-mind-map). */
function csStageOf(o: { lead?: { status?: string | null } | null; handoverFull?: boolean | null; recce?: { handoverDoneAt?: Date | null; projectCode?: string | null; clientId?: string | null; assignee?: unknown } | null; clientType?: string | null; salesprofile?: { kind?: string | null; status?: string | null }[] | null }, projectStatus: string | null): { status: CsStatus; stage: string } {
  if (o.lead?.status === 'CLOSED' || (projectStatus && PROJECT_CLOSED.includes(projectStatus))) return { status: 'CLOSED', stage: 'Closed' };
  if (o.recce?.assignee) return { status: projectStatus && PROJECT_DONE.includes(projectStatus) ? 'COMPLETED' : 'RECCE_ASSIGNED', stage: 'Lead Completed' };
  const sent = (o.salesprofile ?? []).some((e) => e.kind === 'PROJECT_CODE_REQUEST' && EMAIL_SENT.includes(e.status ?? ''));
  const stage =
    o.handoverFull === false && !o.recce?.handoverDoneAt && !sent
      ? 'Handover Type & Details'
      : !sent
        ? 'Project Code Request Email'
        : !o.recce?.projectCode || (o.clientType !== 'EXISTING' && !o.recce.clientId)
          ? 'Project Code & Estimation Code'
          : 'Assign to Recce / Operations';
  return { status: 'PROJECT_ASSIGN', stage };
}

export async function listOrders(q: z.infer<typeof orderListQuery>, actor: Actor) {
  const filter: Record<string, unknown> = { deletedAt: null };
  const cs = actor.role === 'CLIENT_SERVICING';
  if (cs) filter.csAssignee = new Types.ObjectId(actor.id);
  const csProjects = cs ? await csProjectIds(actor.id) : null;
  if (cs && q.csStatus) Object.assign(filter, csStatusFilter(q.csStatus, csProjects!));
  else if (q.handover === 'ASSIGNED') filter.csAssignee = { $ne: null };
  else if (q.handover === 'PENDING') filter.csAssignee = null;
  if (q.ownerId) filter.owner = new Types.ObjectId(q.ownerId);
  if (q.clientId) filter.client = new Types.ObjectId(q.clientId);
  if (q.clientType) filter.clientType = q.clientType;
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const clients = await Client.find({ deletedAt: null, $or: [{ name: re }, { clientName: re }, { clientNo: re }, { code: re }] }).select('_id').limit(500).lean();
    const search = [{ orderNo: re }, { client: { $in: clients.map((c) => c._id) } }];
    // The CLOSED status filter has its own $or: both must hold.
    if (filter.$or) filter.$and = [{ $or: filter.$or }, { $or: search }];
    else filter.$or = search;
    if (filter.$and) delete filter.$or;
  }
  const [rows, total] = await Promise.all([
    SalesOrder.find(filter)
      .select(`orderNo client clientType owner currentRevision rateCardPdf csAssignee handover shopList createdBy createdAt updatedAt${cs ? ' lead.status handoverFull recce.handoverDoneAt recce.projectCode recce.clientId recce.assignee recce.assignedAt recce.assignedBy recce.project salesprofile.kind salesprofile.status' : ''}`)
      .sort(parseSort(q.sort, ['createdAt', 'orderNo', 'updatedAt', 'handover.assignedAt'], '-createdAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('client', 'name clientName clientNo zohoCustomerNo city')
      .populate('owner', 'name')
      .populate('csAssignee', 'name')
      // Only selected for Client Servicing; a path that is not selected populates nothing.
      .populate('recce.assignee', 'name')
      .populate('recce.assignedBy', 'name')
      .populate('recce.project', 'status')
      .lean(),
    SalesOrder.countDocuments(filter),
  ]);
  // Recce assigned without a saved actor (older records): the person from the assignment entry in the lead history.
  const noActor = cs ? rows.filter((o) => o.recce?.assignee && !o.recce.assignedBy).map((o) => o._id) : [];
  const actorFromLog = new Map<string, string>();
  if (noActor.length) {
    const logs = await SalesOrder.find({ _id: { $in: noActor } }).select('leadLogsArray.step leadLogsArray.by leadLogsArray.at').lean();
    const byOrder = logs.map((l) => [String(l._id), (l.leadLogsArray ?? []).filter((x) => x.step === 'cs-recce-assign' && x.by).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))[0]?.by] as const);
    const users = await User.find({ _id: { $in: byOrder.map(([, by]) => by).filter(Boolean) } }).select('name').lean();
    const names = new Map(users.map((u) => [String(u._id), u.name]));
    for (const [oid, by] of byOrder) if (by && names.has(String(by))) actorFromLog.set(oid, names.get(String(by))!);
  }
  const items = rows.map((o) => {
    const base = { ...o, rateCardLabel: o.currentRevision ? revisionLabel(o.currentRevision) : null };
    if (!cs) return base;
    // My Orders: the workflow stage and the Recce assignment (separate from the BD -> CS handover.assignedAt).
    const { salesprofile: _mail, ...rest } = base as typeof base & { salesprofile?: unknown };
    const project = (o.recce?.project ?? null) as unknown as { status?: string } | null;
    const { status, stage } = csStageOf(o, project?.status ?? null);
    return {
      ...rest,
      csStatus: status,
      csStage: stage,
      // assignee: the Recce / Operations recipient; assignedBy: who assigned them (the Client Servicing person), with when.
      recce: {
        assignee: (o.recce?.assignee ?? null) as unknown as { name?: string } | null,
        assignedBy: o.recce?.assignedBy ? { name: (o.recce.assignedBy as unknown as { name?: string }).name ?? null } : actorFromLog.has(String(o._id)) ? { name: actorFromLog.get(String(o._id))! } : null,
        assignedAt: o.recce?.assignedAt ?? null,
      },
    };
  });
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

/** Kanban: each column's newest cards plus its total, with the same filters applied to every column. */
export async function orderBoard(q: z.infer<typeof boardQuery>) {
  const filter: Record<string, unknown> = { deletedAt: null };
  if (q.ownerId) filter.owner = new Types.ObjectId(q.ownerId);
  if (q.clientType) filter.clientType = q.clientType;
  if (q.from || q.to) {
    const range: Record<string, Date> = {};
    // The browser sends exact bounds (start / end of the user's local day), so no server-timezone guessing here.
    if (q.from) range.$gte = q.from;
    if (q.to) range.$lte = q.to;
    filter.createdAt = range;
  }
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const clients = await Client.find({ deletedAt: null, $or: [{ name: re }, { clientNo: re }, { code: re }] }).select('_id').limit(500).lean();
    filter.$or = [{ orderNo: re }, { client: { $in: clients.map((c) => c._id) } }];
  }
  const columns = await Promise.all(
    ORDER_STAGES.map(async (stage) => {
      const f = { ...filter, stage };
      const [items, total] = await Promise.all([
        SalesOrder.find(f).select(WITHOUT_ARRAYS).sort({ createdAt: -1 }).limit(q.limit).populate('client', 'name clientNo zohoCustomerNo').populate('owner', 'name').lean(),
        SalesOrder.countDocuments(f),
      ]);
      return { stage, label: STAGE_LABELS[stage], total, items };
    }),
  );
  return { columns };
}

export async function getOrder(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select(WITHOUT_ARRAYS)
    .populate('client', CLIENT_FIELDS)
    .populate('owner', 'name email phone role')
    .populate('csAssignee', 'name email phone')
    .populate('createdBy', 'name role')
    .populate('approvalCompletedBy', 'name role')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  return { ...o, stageLabel: STAGE_LABELS[o.stage as OrderStage], latestRevision: o.currentRevision || null };
}

/** The order without its activity arrays (for checks and simple updates). */
export async function liveOrder(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select(WITHOUT_ARRAYS);
  if (!o) throw AppError.notFound('Order not found');
  return o;
}

/** Forward one stage at a time. Rate Card -> Client Approval needs a saved quotation. */
export async function moveStage(id: string, stage: OrderStage, actor: Actor) {
  const o = await liveOrder(id);
  if (o.stage === stage) return getOrder(id); // idempotent
  const from = ORDER_STAGES.indexOf(o.stage as OrderStage);
  if (ORDER_STAGES.indexOf(stage) !== from + 1) throw AppError.conflict(`An order in ${STAGE_LABELS[o.stage as OrderStage]} can only move to the next stage`);
  if (stage === 'CLIENT_APPROVAL' && !o.currentRevision) throw AppError.conflict('Save the rate card before moving to Client Approval Proof');
  const old = o.stage;
  // Conditional on the stage we read, so two people moving the same card at once cannot log two moves.
  const r = await SalesOrder.updateOne(
    { _id: o._id, stage: old },
    { $set: { stage, stageChangedAt: new Date(), updatedBy: actor.id }, $push: { salespipelineLogs: pipelineLog(actor, 'STAGE_CHANGE', old, stage) } },
  );
  if (r.modifiedCount) await recordAudit({ actor, action: 'STAGE_CHANGE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'stage', oldValue: old, newValue: stage }] });
  return getOrder(id);
}

/** Authorized reassignment to another active BD employee (BD or admin). */
export async function reassignOwner(id: string, ownerId: string, actor: Actor) {
  const o = await liveOrder(id);
  const bd = await User.findOne({ _id: ownerId, role: 'BD', isActive: true, deletedAt: null }).select('name').lean();
  if (!bd) throw AppError.badRequest('Choose an active BD employee');
  const previous = o.owner ? String(o.owner) : null;
  if (previous === ownerId) return getOrder(id);
  const note = `Assigned to ${bd.name}`;
  await SalesOrder.updateOne(
    { _id: o._id },
    { $set: { owner: bd._id, updatedBy: actor.id }, $push: { salespipelineLogs: pipelineLog(actor, 'ASSIGN', o.stage, o.stage, note) } },
  );
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'owner', oldValue: previous, newValue: ownerId }], reason: note });
  return getOrder(id);
}

/** Loads one activity array of an order (with user names), newest first by `dateField`. */
export async function orderArray(
  id: string,
  key: 'salescommentsArray' | 'salesprofile' | 'rateCardArray' | 'approvalDocumentsArray' | 'salespipelineLogs' | 'handoverDocumentsArray',
  userPaths: string[],
) {
  let q = SalesOrder.findOne({ _id: id, deletedAt: null }).select(`${key} client orderNo stage clientType approvalStatus currentRevision rateCardPdf`);
  for (const p of userPaths) q = q.populate(`${key}.${p}`, 'name role');
  const o = await q.lean();
  if (!o) throw AppError.notFound('Order not found');
  return o;
}

const newestFirst = <T extends { _id: unknown }>(rows: T[], at: (r: T) => Date | null | undefined) =>
  [...rows].sort((a, b) => (at(b)?.getTime() ?? 0) - (at(a)?.getTime() ?? 0) || (String(b._id) > String(a._id) ? 1 : -1));

/** Pipeline history (salespipelineLogs): creation, every stage change, reassignment and approval completion. */
export async function orderHistory(id: string) {
  const o = await orderArray(id, 'salespipelineLogs', ['movedBy']);
  return newestFirst(o.salespipelineLogs ?? [], (l) => l.movedAt).map((l) => ({
    id: String(l._id),
    action: l.action,
    fromStage: l.fromStage ?? null,
    toStage: l.toStage ?? null,
    note: l.notes ?? null,
    changedBy: (l.movedBy as unknown as { name?: string } | null)?.name ?? '',
    role: l.role ?? '',
    at: l.movedAt,
  }));
}

/* --------------------------------- comments --------------------------------- */

export async function listComments(id: string) {
  const o = await orderArray(id, 'salescommentsArray', ['createdBy']);
  return newestFirst(o.salescommentsArray ?? [], (c) => c.createdAt).slice(0, 200);
}

export async function addComment(id: string, body: string, files: UploadedFile[], actor: Actor) {
  const o = await liveOrder(id);
  if (!body && !files.length) throw new AppError(422, 'VALIDATION_ERROR', 'Write a comment or attach a file', [{ path: 'body', message: 'Write a comment or attach a file' }]);
  const client = await Client.findById(o.client).select('name').lean();
  const attachments: StoredFile[] = [];
  const commentId = new Types.ObjectId();
  try {
    for (const f of files) {
      attachments.push(await storeEmbeddedFile({ category: 'SALES_COMMENT_ATTACHMENT', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file: f, actor, owner: { entity: 'SalesOrder', id: o._id } }));
    }
    await SalesOrder.updateOne(
      { _id: o._id },
      { $push: { salescommentsArray: { _id: commentId, body, attachments, createdBy: actor.id, role: actor.role, createdAt: new Date() } } },
    );
  } catch (e) {
    await discardStoredFiles(attachments);
    throw e;
  }
  const comments = await listComments(id);
  return comments.find((c) => String(c._id) === String(commentId)) ?? null;
}

/** One comment of a live order (positional projection, so the rest of the array is not loaded). */
async function commentOf(id: string, commentId: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null, 'salescommentsArray._id': commentId }, { 'salescommentsArray.$': 1 }).lean();
  const c = o?.salescommentsArray?.[0];
  if (!o || !c) throw AppError.notFound('Comment not found');
  return { orderId: o._id, comment: c };
}

/** Only the person who wrote a comment (or a Super Admin) may delete it or its files. */
const assertCommentAuthor = (createdBy: unknown, actor: Actor) => {
  if (String(createdBy) !== actor.id && actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the person who wrote this comment can delete it');
};

/** Deletes a comment; its attachments are erased from storage (local disk or Spaces). */
export async function deleteComment(id: string, commentId: string, actor: Actor) {
  const { orderId, comment } = await commentOf(id, commentId);
  assertCommentAuthor(comment.createdBy, actor);
  const r = await SalesOrder.updateOne({ _id: orderId }, { $pull: { salescommentsArray: { _id: comment._id } } });
  if (!r.modifiedCount) throw AppError.notFound('Comment not found');
  const owner = { entity: 'SalesOrder' as const, id: orderId };
  for (const a of comment.attachments ?? []) await eraseStoredFile(a, actor, owner);
  await recordAudit({ actor, action: 'COMMENT_DELETED', entity: 'SalesOrder', entityId: orderId, reason: comment.body?.slice(0, 200) || `${comment.attachments?.length ?? 0} attachment(s)` });
  return { id: commentId, deleted: true };
}

/**
 * Removes one attachment from a comment and erases it from storage. A comment left with no text and no files is
 * removed too (the same rule as when adding one). Returns the updated comment, or null when it was removed.
 */
export async function deleteCommentAttachment(id: string, commentId: string, fileId: string, actor: Actor) {
  const { orderId, comment } = await commentOf(id, commentId);
  assertCommentAuthor(comment.createdBy, actor);
  const file = comment.attachments?.find((a) => String(a.fileId) === fileId);
  if (!file) throw AppError.notFound('Attachment not found');
  const emptied = !comment.body && (comment.attachments?.length ?? 0) <= 1;
  const r = emptied
    ? await SalesOrder.updateOne({ _id: orderId }, { $pull: { salescommentsArray: { _id: comment._id } } })
    : await SalesOrder.updateOne({ _id: orderId }, { $pull: { 'salescommentsArray.$[c].attachments': { fileId: file.fileId } } }, { arrayFilters: [{ 'c._id': comment._id }] });
  if (!r.modifiedCount) throw AppError.notFound('Attachment not found');
  await eraseStoredFile(file, actor, { entity: 'SalesOrder', id: orderId });
  if (emptied) return null;
  return (await listComments(id)).find((c) => String(c._id) === commentId) ?? null;
}

/* ----------------------------------- files ----------------------------------- */

/**
 * Signed link for any file shown on an order: comment and requirement note attachments, approval proof, rate card PDFs, sent email
 * attachments, handover documents / shop list, and the Company Profile PDF shown in the email draft.
 */
export async function orderFileUrl(id: string, fileId: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select(
      'client clientType salescommentsArray.attachments approvalDocumentsArray.file rateCardArray.pdf rateCardPdf salesprofile.attachments handoverDocumentsArray.file handoverShopsArray.attachments handoverVoiceNotesArray.file handoverMessagesArray.attachments handoverMessagesArray.voice requirementNotesArray.attachments onboardingPdf handoverClient.gstCertificates',
    )
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  // GST certificates of a New client, as handed over or as on the client now (Client Servicing / Operations open them through the order).
  const certs = o.clientType === 'EXISTING' ? [] : ((await Client.findById(o.client).select('gstCertificates').lean())?.gstCertificates ?? []);
  const all: (StoredFile | null | undefined)[] = [
    ...((o.handoverClient?.gstCertificates ?? []) as StoredFile[]),
    ...(certs as StoredFile[]),
    o.onboardingPdf,
    ...(o.salescommentsArray ?? []).flatMap((c) => c.attachments ?? []),
    ...(o.requirementNotesArray ?? []).flatMap((n) => n.attachments ?? []),
    ...(o.approvalDocumentsArray ?? []).map((d) => d.file),
    ...(o.rateCardArray ?? []).map((r) => r.pdf),
    o.rateCardPdf,
    ...(o.salesprofile ?? []).flatMap((e) => e.attachments ?? []),
    ...(o.handoverDocumentsArray ?? []).map((d) => d.file),
    ...(o.handoverShopsArray ?? []).flatMap((s) => s.attachments ?? []),
    ...(o.handoverVoiceNotesArray ?? []).map((v) => v.file),
    ...(o.handoverMessagesArray ?? []).flatMap((m) => [...(m.attachments ?? []), m.voice?.file]),
  ];
  let file = all.find((f) => f && String(f.fileId) === fileId);
  if (!file) {
    const t = await EmailTemplate.findOne({ 'pdf.fileId': fileId }).select('pdf').lean();
    file = t?.pdf;
  }
  if (!file) throw AppError.notFound('File not found');
  return storedFileUrl(file);
}
