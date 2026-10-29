import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeq } from '../../common/counter.model';
import { projectScope } from '../../common/project-access';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, listAudit, recordAudit } from '../audit/audit.service';
import { removeProjectFiles } from '../files/file.service';
import { purgeProjectData } from './project.cascade';
import { notify, type NotifySpec } from '../notifications/notification.service';
import { Client } from '../clients/client.model';
import { CommunicationMessage } from '../communications/communication.model';
import { Site } from '../sites/site.model';
import { removeProjectConnectData } from '../connect/connect.service';
import { removeProjectWorkspaceData } from '../workspace/workspace.service';
import { User } from '../users/user.model';
import { SurveyArea } from './surveyArea.model';
import { PROJECT_STATUSES, Project, Requirement, type RequirementType } from './project.model';
import type { additionalShopsBody, assignBody, projectCreate, projectListQuery, projectPatch, requirementBody, stageBody } from './project.validators';

const POPULATE_CLIENT = { path: 'client', select: 'name code' };
const POPULATE_USERS = [
  { path: 'owner', select: 'name role' },
  { path: 'coordinator', select: 'name role' },
  { path: 'assignedTo', select: 'name role email phone' },
];
const PROJECT_FIELDS = ['name', 'code', 'campaign', 'priority', 'startDate', 'targetDate', 'district', 'instructions', 'requirementType', 'expectedShops', 'contacts', 'description', 'owner', 'coordinator'];
const REQ_FIELDS = ['source', 'sourceNote', 'contact', 'expectedSites', 'locations', 'description', 'commercialNotes', 'recceRequired', 'siteDataScenario', 'attachments'];

/** Shop-with-measurements projects carry the client's own sizes; everything else is measured on site. */
const scenarioOf = (t?: RequirementType) => (t === 'SHOP_MEASUREMENT' ? ('CLIENT_PROVIDED' as const) : ('MEASUREMENT_REQUIRED' as const));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const UNASSIGNED = ['DRAFT', 'ENQUIRY', 'NEW'];
const NOT_DELETABLE_HINT = 'Only unassigned drafts and enquiries can be deleted. Cancel the project instead.';

export async function systemMessage(project: Types.ObjectId | string, body: string, actor: Actor) {
  const _id = new Types.ObjectId();
  await CommunicationMessage.create({
    _id, threadId: String(_id), project, type: 'SYSTEM', direction: 'INTERNAL', body, createdBy: actor.id,
  });
}

/** One client cannot have two live projects with the same campaign name, and codes are globally unique. Drafts are unfinished and never count as a clash. */
async function assertUniqueProject(input: { code?: string | undefined; clientId?: unknown; campaign?: string | undefined }, exceptId?: string) {
  const notSelf = exceptId ? { _id: { $ne: exceptId } } : {};
  if (input.code) {
    const clash = await Project.findOne({ code: input.code, ...notSelf }).select('code').lean();
    if (clash) throw AppError.conflict(`Project code ${input.code} already exists`);
  }
  if (input.clientId && input.campaign) {
    const rows = await Project.find({ client: input.clientId, deletedAt: null, status: { $nin: ['CANCELLED', 'DRAFT'] }, ...notSelf }).select('code campaign').lean();
    const clash = rows.find((r) => norm(r.campaign ?? '') === norm(input.campaign!));
    if (clash) throw AppError.conflict(`This client already has a project for campaign "${clash.campaign}" (${clash.code}). Use a different campaign name.`);
  }
}

const STAGE_TEXT: Record<string, string> = { PLANNING: 'in planning', IN_PROGRESS: 'in progress', CLIENT_APPROVAL: 'awaiting client approval', COMPLETED: 'completed' };

type NotifyArgs = Omit<NotifySpec, 'project' | 'actorId'> & { actor: Actor };
async function notifyProject(p: { _id: Types.ObjectId; code: string; client: unknown }, a: NotifyArgs) {
  const client = await Client.findById(p.client).select('name').lean();
  const { actor, ...spec } = a;
  await notify({ ...spec, project: { _id: p._id, code: p.code, clientName: client?.name }, actorId: actor.id });
}

/** Tells the new owner (and the previous one, if the project moved) about an assignment. Email + in-app, stored per person. */
async function notifyAssignment(p: InstanceType<typeof Project>, previous: string | null, assigneeName: string, actor: Actor, assigneeRole = 'OPERATIONS') {
  const [client, by] = await Promise.all([Client.findById(p.client).select('name').lean(), User.findById(actor.id).select('name').lean()]);
  const when = p.assignedAt!.getTime();
  const shops = p.requirementType === 'ASO' ? 'Shop count unknown (ASO survey)' : p.expectedShops ? `${p.expectedShops} shops` : '';
  const due = p.targetDate ? `Due ${p.targetDate.toISOString().slice(0, 10)}` : '';
  const detail = [client?.name, p.campaign, shops, due].filter(Boolean).join(' | ');
  const id = String(p._id);
  await notifyProject(p, {
    kind: 'PROJECT_ASSIGNED',
    recipients: [String(p.assignedTo)],
    title: assigneeRole === 'RECCE_EXECUTIVE' ? 'New Recce Job Assigned' : 'New Project Assigned',
    body: `Project ${p.code}: ${detail}. Assigned by ${by?.name ?? 'BD'}.${assigneeRole === 'RECCE_EXECUTIVE' ? ' Go to the area and add each shop\'s details as you reach it.' : ''}`,
    dedupe: (r) => `assigned:${id}:${r}:${when}`,
    actor,
  });
  if (previous) {
    await notifyProject(p, {
      kind: 'PROJECT_REASSIGNED',
      recipients: [previous],
      title: `Project ${p.code} was reassigned`,
      body: `Project ${p.code} has been reassigned to ${assigneeName}. You no longer need to work on it.`,
      dedupe: (r) => `reassigned:${id}:${r}:${when}`,
      actor,
    });
  }
}

export async function createProject(input: z.infer<typeof projectCreate>, actor: Actor) {
  const client = await Client.findOne({ _id: input.clientId, deletedAt: null });
  if (!client) throw AppError.badRequest('Client not found');
  if (client.status !== 'ACTIVE') throw AppError.badRequest('Client is inactive');

  let sourceMessage: Types.ObjectId | undefined;
  if (input.sourceMessageId) {
    const m = await CommunicationMessage.findById(input.sourceMessageId);
    if (!m) throw AppError.badRequest('Source message not found');
    sourceMessage = m._id;
  }

  await assertUniqueProject({ code: input.code, clientId: input.clientId, campaign: input.campaign });

  let code = input.code;
  if (!code) {
    const year = new Date().getFullYear();
    const seq = await nextSeq(`project:${client.code}:${year}`);
    code = `SGN-${client.code}-${year}-${String(seq).padStart(3, '0')}`;
  }
  const { requirement, clientId, ownerId, coordinatorId, sourceMessageId: _s, code: _c, status, expectedShops, ...rest } = input;
  const scenario = input.requirementType ? scenarioOf(input.requirementType) : requirement.siteDataScenario;

  const project = await Project.create({
    ...rest,
    code,
    status,
    expectedShops: input.requirementType === 'ASO' ? null : expectedShops,
    name: rest.name ?? `${client.name} - ${rest.campaign}`,
    client: clientId,
    owner: ownerId ?? (actor.role === 'BD' ? actor.id : undefined),
    coordinator: coordinatorId,
    sourceMessage,
    recceRequired: requirement.recceRequired,
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  try {
    await Requirement.create({
      ...requirement,
      siteDataScenario: scenario,
      expectedSites: expectedShops ?? requirement.expectedSites,
      project: project._id, sourceMessage, createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    await Project.deleteOne({ _id: project._id });
    throw e;
  }
  await systemMessage(project._id, `Project ${code} created${status === 'DRAFT' ? ' as a draft' : ` from ${requirement.source.toLowerCase()} requirement`}`, actor);
  await recordAudit({ actor, action: 'CREATE', entity: 'Project', entityId: project._id, project: project._id });
  if (sourceMessage) {
    await CommunicationMessage.updateOne(
      { _id: sourceMessage },
      { project: project._id, actioned: true, actionedBy: actor.id, actionedAt: new Date(), actionNote: `Converted to ${code}` },
    );
  }
  return getProject(String(project._id));
}

export async function getProject(id: string) {
  const p = await Project.findOne({ _id: id, deletedAt: null }).populate(POPULATE_CLIENT).populate(POPULATE_USERS).populate('createdBy', 'name').lean();
  if (!p) throw AppError.notFound('Project not found');
  const requirement = await Requirement.findOne({ project: id }).lean();
  return { ...p, requirement };
}

const LIVE = ['RECCE_ASSIGNED', 'PLANNING', 'IN_PROGRESS', 'CLIENT_APPROVAL'];
const overdueFilter = (): Record<string, unknown> => ({ targetDate: { $lt: new Date(new Date().toISOString().slice(0, 10)) }, status: { $in: LIVE } });

export async function listProjects(q: z.infer<typeof projectListQuery>, actor: Actor) {
  const filter: Record<string, unknown> = { deletedAt: null };
  for (const [k, f] of [['status', 'status'], ['priority', 'priority'], ['clientId', 'client'], ['ownerId', 'owner'], ['assigneeId', 'assignedTo'], ['requirementType', 'requirementType']] as const) {
    if (q[k]) filter[f] = q[k];
  }
  if (q.statuses?.length) filter.status = { $in: q.statuses };
  if (q.assigned === 'true') filter.assignedTo = { $ne: null };
  if (q.assigned === 'false') filter.assignedTo = null;
  if (q.overdue) Object.assign(filter, overdueFilter());
  // ANDed with everything above, so no query parameter (assigned, assigneeId) can widen what an Operations user may see.
  const scope = await projectScope(actor);
  if (Object.keys(scope).length) filter.$and = [scope];
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ code: re }, { name: re }, { campaign: re }, { district: re }];
  }
  const [items, total] = await Promise.all([
    Project.find(filter)
      .sort(parseSort(q.sort, ['createdAt', 'code', 'name', 'targetDate', 'startDate', 'assignedAt', 'priority', 'status', 'district', 'expectedShops'], '-createdAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate(POPULATE_CLIENT)
      .populate(POPULATE_USERS)
      .lean(),
    Project.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

export async function projectSummary(actor: Actor) {
  const rows = await Project.aggregate<{ _id: string; n: number }>([
    { $match: { deletedAt: null, ...(await projectScope(actor)) } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of rows) byStatus[r._id] = r.n;
  const overdue = await Project.countDocuments({ deletedAt: null, ...(await projectScope(actor)), ...overdueFilter() } as Record<string, unknown>);
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), newRequests: byStatus.NEW ?? 0, overdue, byStatus };
}

export async function updateProject(id: string, patch: z.infer<typeof projectPatch>, actor: Actor) {
  const before = await Project.findOne({ _id: id, deletedAt: null }).lean();
  if (!before) throw AppError.notFound('Project not found');
  if (patch.code && patch.code !== before.code && !UNASSIGNED.includes(before.status)) {
    throw AppError.conflict('The project code cannot change after the project is assigned');
  }
  if ((patch.code && patch.code !== before.code) || (patch.campaign && patch.campaign !== before.campaign)) {
    await assertUniqueProject({ code: patch.code !== before.code ? patch.code : undefined, clientId: before.client, campaign: patch.campaign }, id);
  }
  const { ownerId, coordinatorId, ...rest } = patch;
  const set: Record<string, unknown> = { ...rest, updatedBy: actor.id };
  if (patch.requirementType === 'ASO') set.expectedShops = null;
  if (ownerId !== undefined) set.owner = ownerId;
  if (coordinatorId !== undefined) set.coordinator = coordinatorId;
  await Project.updateOne({ _id: id }, set);
  if (patch.requirementType || patch.expectedShops !== undefined) {
    await Requirement.updateOne(
      { project: id },
      {
        ...(patch.requirementType ? { siteDataScenario: scenarioOf(patch.requirementType) } : {}),
        ...(patch.expectedShops !== undefined ? { expectedSites: patch.expectedShops ?? undefined } : {}),
        updatedBy: actor.id,
      },
    );
  }
  const changes = diff(before as never, set, PROJECT_FIELDS).map((c) => ({
    ...c,
    oldValue: c.oldValue != null ? JSON.stringify(c.oldValue) : null,
    newValue: c.newValue != null ? JSON.stringify(c.newValue) : null,
  }));
  if (changes.length) await recordAudit({ actor, action: 'UPDATE', entity: 'Project', entityId: id, project: id, changes });
  return getProject(id);
}

export async function changeStatus(id: string, status: string, reason: string | undefined, actor: Actor) {
  const p = await Project.findOne({ _id: id, deletedAt: null });
  if (!p) throw AppError.notFound('Project not found');
  if (p.status === status) return getProject(id);
  const old = p.status;
  p.status = status as never;
  p.statusReason = reason ?? undefined as never;
  p.updatedBy = new Types.ObjectId(actor.id);
  await p.save();
  await recordAudit({ actor, action: 'STATUS_CHANGE', entity: 'Project', entityId: id, project: id, changes: [{ field: 'status', oldValue: old, newValue: status }], reason });
  await systemMessage(id, `Status changed ${old} -> ${status}${reason ? ` (${reason})` : ''}`, actor);
  if (status === 'CANCELLED' && p.assignedTo) {
    await notifyProject(p, { kind: 'PROJECT_CANCELLED', recipients: [p.assignedTo], title: `Project ${p.code} was cancelled`, body: `BD cancelled project ${p.code}${reason ? `: ${reason}` : '.'} No further work is needed.`, dedupe: (r) => `cancelled:${id}:${r}`, actor });
  }
  if (status === 'LOSS') {
    await notifyProject(p, { kind: 'PROJECT_LOSS', recipients: [p.assignedTo, p.owner ?? p.createdBy], title: `Project ${p.code} moved to LOSS`, body: `The client rejected the cost for ${p.code}${reason ? `: ${reason}` : '.'} No further work is needed.`, dedupe: (r) => `loss:${id}:${r}`, actor });
  }
  return getProject(id);
}

/**
 * BD can delete only what Operations has never seen; everything else is cancelled so history survives. Super Admin can
 * delete any project (to clear test data). Deleting removes the project AND everything linked to it: stored files, shops,
 * survey areas, notifications, chat and audit history.
 */
export async function deleteProject(id: string, actor: Actor) {
  const p = await Project.findOne({ _id: id, deletedAt: null });
  if (!p) throw AppError.notFound('Project not found');
  if (actor.role !== 'SUPER_ADMIN' && (p.assignedTo || !(UNASSIGNED.includes(p.status) || p.status === 'CANCELLED'))) throw AppError.conflict(NOT_DELETABLE_HINT);
  // Files first: if one cannot be erased from storage, nothing is deleted and the person can simply try again.
  const { failed: connectFailed } = await removeProjectConnectData(id);
  const { failed: workspaceFailed } = await removeProjectWorkspaceData(id);
  const { failed: projectFailed } = await removeProjectFiles(id);
  const failed = [...connectFailed, ...workspaceFailed, ...projectFailed];
  if (failed.length) throw AppError.conflict(`Could not remove these files from storage, so the project was not deleted: ${failed.join(', ')}. Try again.`);
  return { id, removed: await purgeProjectData(id) };
}

/* ------------------------- BD -> Operations assignment ------------------------- */

export async function listAssignees() {
  // Recce executives are listed too: an ASO project can be given straight to them (the web app shows them only for ASO).
  const users = await User.find({ role: { $in: ['OPERATIONS', 'RECCE_COORDINATOR', 'RECCE_EXECUTIVE'] }, isActive: true, deletedAt: null }).select('name role email phone').sort({ name: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, role: u.role, email: u.email, phone: u.phone ?? null }));
}

/** What a project needs before Operations can act on it. Drafts may be incomplete; assigned projects may not. */
function missingForAssignment(p: { startDate?: Date | null; targetDate?: Date | null; district?: string | null; requirementType?: string | null; expectedShops?: number | null; contacts?: unknown[] }) {
  const m: string[] = [];
  if (!p.requirementType) m.push('requirement type');
  if (!p.startDate) m.push('start date');
  if (!p.targetDate) m.push('expected end date');
  if (!p.district) m.push('district / location');
  if (!p.contacts?.length) m.push('at least one client contact');
  if (p.requirementType && p.requirementType !== 'ASO' && !p.expectedShops) m.push('number of shops');
  return m;
}

export async function assignProject(id: string, body: z.infer<typeof assignBody>, actor: Actor) {
  const p = await Project.findOne({ _id: id, deletedAt: null });
  if (!p) throw AppError.notFound('Project not found');
  if (['CANCELLED', 'COMPLETED', 'CLIENT_APPROVAL', 'IN_PROGRESS'].includes(p.status)) throw AppError.conflict(`A ${p.status.toLowerCase().replace('_', ' ')} project cannot be (re)assigned`);
  // Drafts never block a new project, so the campaign clash is checked here, when the draft becomes live.
  if (UNASSIGNED.includes(p.status)) await assertUniqueProject({ clientId: p.client, campaign: p.campaign ?? undefined }, id);
  const missing = missingForAssignment(p);
  if (missing.length) throw new AppError(422, 'VALIDATION_ERROR', `Complete the project before assigning: ${missing.join(', ')}`, missing.map((m) => ({ path: m, message: `Missing ${m}` })));
  // An ASO survey has no shop list, so it can go straight to a recce executive on the mobile app.
  const roles = p.requirementType === 'ASO' ? ['OPERATIONS', 'RECCE_COORDINATOR', 'RECCE_EXECUTIVE'] : ['OPERATIONS', 'RECCE_COORDINATOR'];
  const assignee = await User.findOne({ _id: body.assigneeId, isActive: true, deletedAt: null, role: { $in: roles as never } }).select('name role').lean();
  if (!assignee) throw AppError.badRequest(p.requirementType === 'ASO' ? 'Choose an active Operations, Recce Coordinator or Recce executive user' : 'Choose an active Operations or Recce Coordinator user');

  const previous = p.assignedTo ? String(p.assignedTo) : null;
  if (previous === body.assigneeId) return getProject(id); // idempotent: no duplicate notification
  p.assignedTo = assignee._id as never;
  p.assignedAt = new Date();
  if (UNASSIGNED.includes(p.status)) p.status = 'RECCE_ASSIGNED';
  p.updatedBy = new Types.ObjectId(actor.id);
  await p.save();
  await recordAudit({ actor, action: 'ASSIGN', entity: 'Project', entityId: id, project: id, changes: [{ field: 'assignedTo', oldValue: previous, newValue: body.assigneeId }], reason: `Assigned to ${assignee.name}` });
  await systemMessage(id, `Assigned to ${assignee.name} (${assignee.role.toLowerCase().replace('_', ' ')})`, actor);
  await notifyAssignment(p, previous, assignee.name, actor, assignee.role);
  return getProject(id);
}

/** Operations moves a project forward one step at a time. Each step has its own precondition. */
const NEXT_STAGE: Record<string, string> = { RECCE_ASSIGNED: 'PLANNING', PLANNING: 'IN_PROGRESS', IN_PROGRESS: 'CLIENT_APPROVAL', CLIENT_APPROVAL: 'COMPLETED' };

export async function advanceStage(id: string, body: z.infer<typeof stageBody>, actor: Actor) {
  const p = await Project.findOne({ _id: id, deletedAt: null });
  if (!p) throw AppError.notFound('Project not found');
  if (p.status === body.stage) return getProject(id); // idempotent
  if (NEXT_STAGE[p.status] !== body.stage) throw AppError.conflict(`A project in ${p.status} cannot move to ${body.stage}`);

  if (body.stage === 'IN_PROGRESS') {
    const sites = await Site.countDocuments({ project: id, deletedAt: null });
    if (p.requirementType === 'ASO') {
      if (!sites && !(await SurveyArea.countDocuments({ project: id }))) throw AppError.conflict('Record at least one survey area (or shop) before starting the recce');
    } else {
      if (!sites) throw AppError.conflict('Import or add shops before starting the recce');
      if (p.requirementType === 'SHOP_DETAILS') {
        const unverified = await Site.countDocuments({ project: id, deletedAt: null, opsApproval: { $ne: 'APPROVED' } });
        if (unverified) throw AppError.conflict(`${unverified} shop(s) are not verified yet. Verify the shop details before starting the recce`);
      }
      if (p.requirementType === 'SHOP_MEASUREMENT') {
        const pending = await Site.countDocuments({ project: id, deletedAt: null, $or: [{ opsApproval: { $ne: 'APPROVED' } }, { bdApproval: { $ne: 'APPROVED' } }] });
        if (pending) throw AppError.conflict(`${pending} shop(s) still need both approvals (Operations and BD) before the recce can start`);
      }
    }
  }
  const old = p.status;
  p.status = body.stage as never;
  p.updatedBy = new Types.ObjectId(actor.id);
  await p.save();
  await recordAudit({ actor, action: 'STATUS_CHANGE', entity: 'Project', entityId: id, project: id, changes: [{ field: 'status', oldValue: old, newValue: body.stage }] });
  await systemMessage(id, `Operations moved the project ${old} -> ${body.stage}`, actor);
  await notifyProject(p, { kind: 'STAGE_CHANGED', recipients: [p.owner ?? p.createdBy], title: `${p.code} is now ${STAGE_TEXT[body.stage] ?? body.stage}`, body: `Operations moved project ${p.code} from ${old.toLowerCase().replace('_', ' ')} to ${body.stage.toLowerCase().replace('_', ' ')}.`, dedupe: (r) => `stage:${id}:${body.stage}:${r}`, actor });
  return getProject(id);
}

export async function getRequirement(projectId: string) {
  const r = await Requirement.findOne({ project: projectId }).lean();
  if (!r) throw AppError.notFound('Requirement not found');
  return r;
}

export async function upsertRequirement(projectId: string, body: z.infer<typeof requirementBody>, actor: Actor) {
  const project = await Project.findOne({ _id: projectId, deletedAt: null });
  if (!project) throw AppError.notFound('Project not found');
  const before = (await Requirement.findOne({ project: projectId }).lean()) ?? {};
  const r = await Requirement.findOneAndUpdate(
    { project: projectId },
    { ...body, updatedBy: actor.id, $setOnInsert: { createdBy: actor.id } },
    { returnDocument: 'after', upsert: true },
  ).lean();
  await Project.updateOne({ _id: projectId }, { recceRequired: body.recceRequired, updatedBy: actor.id });
  await recordAudit({ actor, action: 'UPDATE', entity: 'Requirement', entityId: r!._id, project: projectId, changes: diff(before as never, body as never, REQ_FIELDS) });
  return r;
}

export const projectHistory = (id: string) => listAudit({ project: new Types.ObjectId(id) });

/** Latest things that happened across projects, for the dashboard's "Recent activity" panel. */
export async function recentActivity(actor: Actor, limit = 8) {
  const logs = await listAudit({ entity: { $in: ['Project', 'FileAsset', 'ImportBatch'] } }, 40);
  const ids = [...new Set(logs.map((l) => (l.project ? String(l.project) : '')).filter(Boolean))];
  const projects = await Project.find({ _id: { $in: ids }, deletedAt: null, ...(await projectScope(actor)) }).populate<{ client: { name: string } }>('client', 'name').select('code client').lean();
  const byId = new Map(projects.map((p) => [String(p._id), p]));
  const text = (l: (typeof logs)[number]) =>
    l.action === 'CREATE' ? 'Project created'
    : l.action === 'ASSIGN' ? (l.reason ?? 'Assigned to Operations')
    : l.action === 'STATUS_CHANGE' ? `Status: ${l.changes?.[0]?.oldValue ?? '-'} -> ${l.changes?.[0]?.newValue ?? '-'}`
    : l.action === 'UPLOAD' ? 'Client document uploaded'
    : l.action === 'IMPORT_SITES' ? (l.reason ?? 'Shops imported')
    : l.action === 'UPDATE' ? 'Project details updated'
    : l.action.toLowerCase();
  return logs
    .filter((l) => l.project && byId.has(String(l.project)))
    .slice(0, limit)
    .map((l) => {
      const p = byId.get(String(l.project))!;
      return { id: String(l._id), at: l.at, text: text(l), by: (l.user as unknown as { name?: string } | null)?.name ?? '', projectId: String(p._id), code: p.code, client: p.client?.name ?? '' };
    });
}

/** Shops found beyond the client's list (details-only and measurement projects). Raises the total expected shop count. */
export async function setAdditionalShops(id: string, body: z.infer<typeof additionalShopsBody>, actor: Actor) {
  const p = await Project.findOne({ _id: id, deletedAt: null });
  if (!p) throw AppError.notFound('Project not found');
  if (p.requirementType === 'ASO') throw AppError.badRequest('ASO projects have no fixed shop count, so there is nothing to add to');
  if (p.status === 'CANCELLED') throw AppError.conflict('This project is cancelled');
  const old = p.additionalShops ?? 0;
  p.set({ additionalShops: body.count, additionalShopsNote: body.note, updatedBy: actor.id });
  await p.save();
  await recordAudit({
    actor, action: 'UPDATE', entity: 'Project', entityId: id, project: id,
    changes: [{ field: 'additionalShops', oldValue: old, newValue: body.count }], reason: body.note ?? `Additional shops: ${body.count}`,
  });
  return getProject(id);
}
