import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeq } from '../../common/counter.model';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, listAudit, recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { CommunicationMessage } from '../communications/communication.model';
import { PROJECT_STATUSES, Project, Requirement } from './project.model';
import type { projectCreate, projectListQuery, projectPatch, requirementBody } from './project.validators';

const POPULATE_CLIENT = { path: 'client', select: 'name code' };
const POPULATE_USERS = [
  { path: 'owner', select: 'name role' },
  { path: 'coordinator', select: 'name role' },
];
const PROJECT_FIELDS = ['name', 'campaign', 'priority', 'targetDate', 'description', 'owner', 'coordinator'];
const REQ_FIELDS = ['source', 'sourceNote', 'contact', 'expectedSites', 'locations', 'description', 'commercialNotes', 'recceRequired', 'siteDataScenario', 'attachments'];

export async function systemMessage(project: Types.ObjectId | string, body: string, actor: Actor) {
  const _id = new Types.ObjectId();
  await CommunicationMessage.create({
    _id, threadId: String(_id), project, type: 'SYSTEM', direction: 'INTERNAL', body, createdBy: actor.id,
  });
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

  const year = new Date().getFullYear();
  const seq = await nextSeq(`project:${client.code}:${year}`);
  const code = `SGN-${client.code}-${year}-${String(seq).padStart(3, '0')}`;
  const { requirement, clientId, ownerId, coordinatorId, sourceMessageId: _s, ...rest } = input;

  const project = await Project.create({
    ...rest,
    code,
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
    await Requirement.create({ ...requirement, project: project._id, sourceMessage, createdBy: actor.id, updatedBy: actor.id });
  } catch (e) {
    await Project.deleteOne({ _id: project._id });
    throw e;
  }
  await systemMessage(project._id, `Project ${code} created from ${requirement.source.toLowerCase()} requirement`, actor);
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

export async function listProjects(q: z.infer<typeof projectListQuery>) {
  const filter: Record<string, unknown> = { deletedAt: null };
  for (const [k, f] of [['status', 'status'], ['priority', 'priority'], ['clientId', 'client'], ['ownerId', 'owner']] as const) {
    if (q[k]) filter[f] = q[k];
  }
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ code: re }, { name: re }, { campaign: re }];
  }
  const [items, total] = await Promise.all([
    Project.find(filter)
      .sort(parseSort(q.sort, ['createdAt', 'code', 'name', 'targetDate', 'priority', 'status'], '-createdAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate(POPULATE_CLIENT)
      .populate(POPULATE_USERS)
      .lean(),
    Project.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

export async function projectSummary() {
  const rows = await Project.aggregate<{ _id: string; n: number }>([
    { $match: { deletedAt: null } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const r of rows) byStatus[r._id] = r.n;
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), newRequests: byStatus.NEW ?? 0, byStatus };
}

export async function updateProject(id: string, patch: z.infer<typeof projectPatch>, actor: Actor) {
  const before = await Project.findOne({ _id: id, deletedAt: null }).lean();
  if (!before) throw AppError.notFound('Project not found');
  const { ownerId, coordinatorId, ...rest } = patch;
  const set: Record<string, unknown> = { ...rest, updatedBy: actor.id };
  if (ownerId !== undefined) set.owner = ownerId;
  if (coordinatorId !== undefined) set.coordinator = coordinatorId;
  await Project.updateOne({ _id: id }, set);
  const changes = diff(before as never, set, PROJECT_FIELDS).map((c) => ({
    ...c, oldValue: c.oldValue != null ? String(c.oldValue) : null, newValue: c.newValue != null ? String(c.newValue) : null,
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
  await systemMessage(id, `Status changed ${old} ? ${status}${reason ? ` (${reason})` : ''}`, actor);
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

