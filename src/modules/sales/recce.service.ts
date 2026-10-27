import { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { CommunicationMessage } from '../communications/communication.model';
import { discardStoredFiles, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { mailAvailable } from '../notifications/mail.service';
import { Project, Requirement } from '../projects/project.model';
import { assignProject, createProject } from '../projects/project.service';
import { projectCreate } from '../projects/project.validators';
import { User } from '../users/user.model';
import { clientSnapshot, HANDOVER_TYPE_LABELS, handoverGaps } from './handover.service';
import { leadLog, liveOrder, pipelineLog } from './order.service';
import { SalesOrder, type HandoverType } from './sales.model';
import { deliver, listEmails } from './salesMail.service';
import type { recceAssignBody, recceCodesBody, sendEmailBody } from './sales.validators';

/** Recce / Operations people a project can be assigned to (same rule as the projects module). */
export const recceUsers = () =>
  User.find({ role: { $in: ['OPERATIONS', 'RECCE_COORDINATOR'] }, isActive: true, deletedAt: null }).select('name email phone role').sort({ name: 1 }).lean();

const ownerOf = (id: Types.ObjectId) => ({ entity: 'SalesOrder' as const, id });

type OrderDoc = Awaited<ReturnType<typeof liveOrder>>;

/** The Recce branch can be worked on only while the lead is open at Project Assign and nobody has the project yet. */
function assertBranchOpen(o: OrderDoc) {
  if (o.csAssignee) throw AppError.conflict('This project is already assigned to Client Servicing.');
  if (o.recce?.assignee) throw AppError.conflict('This project is already assigned to the Recce team.');
  if (!(o.lead?.status === 'OPEN' && o.lead.stage === 'PROJECT_ASSIGN')) throw AppError.conflict('Assign the Recce team from the Project Assign stage in Lead Management.');
}

const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);

/** Recce branch for one order: codes, project code request emails, what is still missing, and the assignment. */
export async function getRecce(id: string, actor: Actor) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select('orderNo client clientType lead recce csAssignee handoverType shopList declaredShopTotal shopsVerifiedAt salesprofile.kind salesprofile.status salesprofile.sentAt')
    .populate('recce.assignee', 'name email phone role')
    .populate('recce.assignedBy', 'name')
    .populate('recce.codesSavedBy', 'name')
    .populate('recce.project', 'code status')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  const client = await Client.findById(o.client).select('name clientNo contacts').lean();
  const r = o.recce ?? null;
  const requests = (o.salesprofile ?? []).filter((e) => e.kind === 'PROJECT_CODE_REQUEST').sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
  const codes = r?.projectCode ? { projectCode: r.projectCode, estimationCode: r.estimationCode ?? '', savedAt: r.codesSavedAt ?? null, savedBy: (r.codesSavedBy as unknown as { name?: string } | null)?.name ?? null } : null;
  const contacts = client?.contacts ?? [];
  // The Recce team always gets the full handover (there is no "client details only" option here).
  const handoverMissing = handoverGaps({ ...o, handoverFull: true }, contacts.length);
  const missing = r?.assignee ? [] : [...(codes ? [] : ['Enter the project code and estimation code']), ...handoverMissing];
  const bd = await User.findById(actor.id).select('name').lean();
  const typeLabel = o.handoverType ? HANDOVER_TYPE_LABELS[o.handoverType as HandoverType] : 'To be confirmed';
  const shops = o.handoverType && o.handoverType !== 'ASO' && o.shopList ? `${o.shopList.total} shops` : o.handoverType === 'ASO' ? 'ASO (shop details to be collected)' : 'To be confirmed';
  // Plain lines (no table): the composer's rich-text editor keeps paragraphs, line breaks and bold only.
  const row = (k: string, v: string) => `${k}: <strong>${escapeHtml(v)}</strong>`;
  return {
    orderId: String(o._id),
    orderNo: o.orderNo,
    unlocked: o.lead?.status === 'OPEN' && o.lead.stage === 'PROJECT_ASSIGN' && !o.csAssignee,
    codes,
    requests: { count: requests.length, lastSentAt: requests[0]?.sentAt ?? null, lastStatus: requests[0]?.status ?? null },
    /** Contacts that can go on the operations project (name, mobile and email all present). */
    projectContacts: contacts.filter((k) => k.phone && k.email).length,
    assignee: r?.assignee ?? null,
    assignedAt: r?.assignedAt ?? null,
    assignedBy: (r?.assignedBy as unknown as { name?: string } | null)?.name ?? null,
    note: r?.note ?? null,
    project: r?.project ?? null,
    missing,
    mail: { enabled: mailAvailable(), from: env.MAIL_FROM ?? null },
    draft: {
      to: [] as string[],
      cc: [] as string[],
      subject: `Project Code Request - ${client?.name ?? 'Client'} (${o.orderNo})`,
      body:
        `<p>Dear Team,</p><p>Please create a project code for the order below.</p>` +
        `<p>${[row('Client', client?.name ?? '-'), row('Client ID', client?.clientNo ?? '-'), row('Order No', o.orderNo), row('Client Flag', o.clientType === 'NEW' ? 'New Client' : 'Existing Client'), row('Handover Type', typeLabel), row('Shops', shops)].join('<br>')}</p>` +
        `<p>Regards,<br>${escapeHtml(bd?.name ?? 'BD Team')}</p>`,
    },
  };
}

/** Project code request email: To / CC / subject / message with optional attachments, recorded in the email history. */
export async function sendCodeRequest(id: string, input: z.infer<typeof sendEmailBody>, files: UploadedFile[], actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o);
  // Same request sent twice (double click / retry): hand back the first one without storing the files again.
  if (input.requestKey) {
    const again = (await listEmails(id, 'PROJECT_CODE_REQUEST')).find((e) => e.requestKey === input.requestKey);
    if (again) return again;
  }
  const client = await Client.findById(o.client).select('name').lean();
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeEmbeddedFile({ category: 'SALES_HANDOVER_DOCUMENT', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file: f, actor, owner: ownerOf(o._id) }));
    return await deliver({ order: o._id, client: o.client, kind: 'PROJECT_CODE_REQUEST', to: input.to, cc: input.cc, subject: input.subject, body: sanitizeHtml(input.body), attachments: stored, requestKey: input.requestKey, actor });
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
}

/** Codes are unique across operations projects and other orders. */
async function assertCodesFree(orderId: Types.ObjectId, projectCode: string, estimationCode: string) {
  if (await Project.exists({ code: projectCode })) throw invalid('projectCode', `Project code ${projectCode} already exists`);
  const other = await SalesOrder.findOne({ _id: { $ne: orderId }, deletedAt: null, $or: [{ 'recce.projectCode': projectCode }, { 'recce.estimationCode': estimationCode }] })
    .select('orderNo recce.projectCode')
    .lean();
  if (other?.recce?.projectCode === projectCode) throw invalid('projectCode', `Project code ${projectCode} is already used by order ${other.orderNo}`);
  if (other) throw invalid('estimationCode', `Estimation code ${estimationCode} is already used by order ${other.orderNo}`);
}

export async function saveCodes(id: string, input: z.infer<typeof recceCodesBody>, actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o);
  await assertCodesFree(o._id, input.projectCode, input.estimationCode);
  const previous = o.recce ? (o.recce as unknown as { toObject?: () => object }).toObject?.() ?? o.recce : {};
  try {
    const r = await SalesOrder.updateOne(
      { _id: o._id, csAssignee: null, 'recce.assignee': null },
      { $set: { recce: { ...previous, projectCode: input.projectCode, estimationCode: input.estimationCode, codesSavedAt: new Date(), codesSavedBy: actor.id }, updatedBy: actor.id } },
    );
    if (!r.matchedCount) throw AppError.conflict('This project was assigned meanwhile. Reload the page.');
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw AppError.conflict('That project or estimation code was just used by another order. Check the codes.');
    throw e;
  }
  await recordAudit({ actor, action: 'UPDATE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'recce.projectCode', oldValue: o.recce?.projectCode ?? null, newValue: input.projectCode }], reason: `Project code ${input.projectCode}, estimation code ${input.estimationCode}` });
  return getRecce(id, actor);
}

/** Removes a project created for an assignment that did not go through (with its requirement and system messages). */
async function dropProject(projectId: Types.ObjectId | string) {
  await Promise.all([Project.deleteOne({ _id: projectId }), Requirement.deleteMany({ project: projectId }), CommunicationMessage.deleteMany({ project: projectId })]);
}

/**
 * Assign to Recce Team: creates the operations project from the order (code = project code, handover type, shops,
 * client contacts, notes), assigns it to the Recce / Operations person (who is notified) and completes the lead.
 */
export async function assignRecce(id: string, input: z.infer<typeof recceAssignBody>, actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o);
  const codes = o.recce?.projectCode && o.recce.estimationCode ? { projectCode: o.recce.projectCode, estimationCode: o.recce.estimationCode } : null;
  if (!codes) throw invalid('projectCode', 'Enter the project code and estimation code first');
  const client = await Client.findById(o.client).select('name contacts').lean();
  const gaps = handoverGaps({ ...o.toObject(), handoverFull: true }, client?.contacts?.length ?? 0);
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', gaps[0]!, gaps.map((message) => ({ path: 'handover', message })));
  const contacts = (client?.contacts ?? []).filter((k) => k.phone && k.email).map((k) => ({ name: k.name, email: k.email!, phone: k.phone! }));
  if (!contacts.length) throw invalid('contacts', 'Add a contact person with both a mobile number and an email: the Recce team needs one to call');
  const person = await User.findOne({ _id: input.assigneeId, role: { $in: ['OPERATIONS', 'RECCE_COORDINATOR'] }, isActive: true, deletedAt: null }).select('name').lean();
  if (!person) throw invalid('assigneeId', 'Choose an active Recce / Operations person');
  await assertCodesFree(o._id, codes.projectCode, codes.estimationCode);

  const type = o.handoverType as HandoverType;
  const notes = [o.handoverNotes, input.note].filter(Boolean).join('\n\n');
  const parsed = projectCreate.safeParse({
    clientId: String(o.client),
    code: codes.projectCode,
    campaign: `Order ${o.orderNo}`,
    name: `${client?.name ?? 'Client'} - ${o.orderNo}`,
    priority: input.priority,
    startDate: input.startDate,
    targetDate: input.targetDate,
    district: input.district,
    instructions: notes || undefined,
    requirementType: type,
    expectedShops: type === 'ASO' ? null : (o.declaredShopTotal ?? o.shopList?.total ?? null),
    contacts,
    status: 'NEW',
    requirement: {
      source: 'OTHER',
      sourceNote: `Lead Management: ${o.orderNo} (estimation ${codes.estimationCode})`,
      description: notes || undefined,
      recceRequired: true,
      siteDataScenario: type === 'SHOP_MEASUREMENT' ? 'CLIENT_PROVIDED' : 'MEASUREMENT_REQUIRED',
    },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalid(String(issue.path[0] ?? 'project'), issue.message);
  }

  const project = await createProject(parsed.data, actor);
  const projectId = project._id as Types.ObjectId;
  try {
    await Project.updateOne({ _id: projectId }, { $set: { estimationCode: codes.estimationCode, salesOrder: o._id } });
    await assignProject(String(projectId), { assigneeId: input.assigneeId }, actor);
  } catch (e) {
    await dropProject(projectId);
    throw e;
  }

  const now = new Date();
  const note = `Assigned to ${person.name} (Recce team) · project ${codes.projectCode}`;
  const snapshot = await clientSnapshot(o);
  const r = await SalesOrder.updateOne(
    { _id: o._id, csAssignee: null, 'recce.assignee': null, 'recce.projectCode': codes.projectCode, 'lead.status': 'OPEN', 'lead.stage': 'PROJECT_ASSIGN' },
    {
      $set: {
        'recce.assignee': person._id,
        'recce.assignedAt': now,
        'recce.assignedBy': actor.id,
        'recce.note': input.note,
        'recce.project': projectId,
        handoverClient: snapshot,
        'lead.status': 'COMPLETED',
        'lead.completedAt': now,
        'lead.completedBy': actor.id,
        'lead.stageChangedAt': now,
        updatedBy: actor.id,
      },
      $push: {
        salespipelineLogs: pipelineLog(actor, 'HANDOVER', o.stage, o.stage, note),
        leadLogsArray: leadLog(actor, 'COMPLETE', 'PROJECT_ASSIGN', null, `Assigned to the Recce team (${person.name}): lead completed`),
      },
    },
  );
  if (!r.modifiedCount) {
    await dropProject(projectId);
    throw AppError.conflict('This project was assigned meanwhile. Reload the page.');
  }
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'recce.assignee', oldValue: null, newValue: String(person._id) }], reason: note });
  return getRecce(id, actor);
}
