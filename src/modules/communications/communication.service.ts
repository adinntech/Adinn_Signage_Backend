import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { User } from '../users/user.model';
import { Project } from '../projects/project.model';
import { createProject, systemMessage } from '../projects/project.service';
import { CommunicationChannel, CommunicationMessage } from './communication.model';
import type { actionedBody, approvalDecisionBody, approvalRequestBody, channelBody, createProjectFromMessage, messageCreate, messageListQuery } from './communication.validators';

const USERS = { path: 'createdBy', select: 'name role' };
type Addr = { name?: string | null | undefined; email?: string | null | undefined };

export async function listMessages(q: z.infer<typeof messageListQuery>) {
  const filter: Record<string, unknown> = {};
  if (q.projectId) filter.project = q.projectId;
  if (q.unlinked === 'true') filter.project = null;
  if (q.type) filter.type = q.type;
  if (q.actioned) filter.actioned = q.actioned === 'true';
  if (q.threadId) filter.threadId = q.threadId;
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ subject: re }, { body: re }, { 'from.email': re }, { 'from.name': re }];
  }
  const [items, total] = await Promise.all([
    CommunicationMessage.find(filter)
      .sort(parseSort(q.sort, ['sentAt', 'createdAt'], '-sentAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate(USERS)
      .populate({ path: 'project', select: 'code name' })
      .populate('approval.requestedTo', 'name role')
      .lean(),
    CommunicationMessage.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

export async function getMessage(id: string) {
  const m = await CommunicationMessage.findById(id).populate(USERS).populate({ path: 'project', select: 'code name' }).lean();
  if (!m) throw AppError.notFound('Message not found');
  return m;
}

const uniq = (list: Addr[]) => {
  const seen = new Set<string>();
  return list.filter((a) => a.email && !seen.has(a.email) && seen.add(a.email));
};

export async function createMessage(input: z.infer<typeof messageCreate>, actor: Actor) {
  const _id = new Types.ObjectId();
  const doc: Record<string, unknown> = {
    _id, threadId: String(_id), type: input.type, body: input.body, createdBy: actor.id,
    direction: input.direction ?? (input.type === 'EMAIL' ? 'OUTBOUND' : 'INTERNAL'),
    project: input.projectId, subject: input.subject, from: input.from, to: input.to, cc: input.cc,
    attachments: input.attachments, sentAt: input.sentAt,
  };

  if (input.replyToId) {
    const parent = await CommunicationMessage.findById(input.replyToId).lean();
    if (!parent) throw AppError.badRequest('Message to reply to was not found');
    doc.parent = parent._id;
    doc.threadId = parent.threadId;
    doc.project = input.projectId ?? parent.project;
    const base = (parent.subject ?? '').replace(/^(re|fwd?):\s*/i, '');
    const me = await User.findById(actor.id).lean();
    const mine = me?.email;
    if (input.mode === 'forward') {
      doc.subject = input.subject ?? `Fwd: ${base}`;
      doc.attachments = input.attachments ?? parent.attachments;
    } else {
      doc.subject = input.subject ?? `Re: ${base}`;
      const target = input.mode === 'reply_all'
        ? uniq([...(parent.from ? [parent.from] : []), ...(parent.to ?? [])]).filter((a) => a.email !== mine)
        : parent.from ? [parent.from] : [];
      doc.to = input.to ?? target;
      doc.cc = input.cc ?? (input.mode === 'reply_all' ? (parent.cc ?? []).filter((a) => a.email !== mine) : []);
    }
    doc.direction = 'OUTBOUND';
  }
  if (doc.project && !(await Project.exists({ _id: doc.project as never, deletedAt: null }))) {
    throw AppError.badRequest('Project not found');
  }
  if (input.type === 'EMAIL') doc.deliveryStatus = doc.direction === 'INBOUND' ? 'RECEIVED' : 'LOGGED';
  const m = await CommunicationMessage.create(doc);
  await recordAudit({ actor, action: 'CREATE', entity: 'CommunicationMessage', entityId: m._id, project: m.project ?? undefined });
  return getMessage(String(m._id));
}

export async function setActioned(id: string, b: z.infer<typeof actionedBody>, actor: Actor) {
  const m = await CommunicationMessage.findById(id);
  if (!m) throw AppError.notFound('Message not found');
  m.actioned = b.actioned;
  m.actionedBy = b.actioned ? new Types.ObjectId(actor.id) : (undefined as never);
  m.actionedAt = b.actioned ? new Date() : (undefined as never);
  m.actionNote = b.note as never;
  await m.save();
  await recordAudit({ actor, action: b.actioned ? 'MARK_ACTIONED' : 'UNMARK_ACTIONED', entity: 'CommunicationMessage', entityId: id, project: m.project ?? undefined });
  return getMessage(id);
}

export async function requestApproval(id: string, b: z.infer<typeof approvalRequestBody>, actor: Actor) {
  const src = await getMessage(id);
  const users = await User.find({ _id: { $in: b.to }, isActive: true, deletedAt: null }).select('_id').lean();
  if (users.length !== new Set(b.to).size) throw AppError.badRequest('One or more approvers are invalid');
  const _id = new Types.ObjectId();
  await CommunicationMessage.create({
    _id, threadId: src.threadId, parent: src._id, project: (src.project as { _id?: Types.ObjectId } | null)?._id, type: 'APPROVAL', direction: 'INTERNAL',
    subject: `Approval requested: ${src.subject ?? 'message'}`, body: b.comment ?? '', createdBy: actor.id,
    approval: { status: 'PENDING', requestedTo: b.to, comment: b.comment },
  });
  return getMessage(String(_id));
}

export async function decideApproval(id: string, b: z.infer<typeof approvalDecisionBody>, actor: Actor) {
  const m = await CommunicationMessage.findById(id);
  if (!m || m.type !== 'APPROVAL' || !m.approval) throw AppError.notFound('Approval request not found');
  if (m.approval.status !== 'PENDING') throw AppError.conflict('Approval already decided');
  const allowed = m.approval.requestedTo.some((u) => String(u) === actor.id) || actor.role === 'SUPER_ADMIN';
  if (!allowed) throw AppError.forbidden('You are not an approver for this request');
  m.approval.status = b.status;
  m.approval.decidedBy = new Types.ObjectId(actor.id);
  m.approval.decidedAt = new Date();
  m.approval.comment = b.comment ?? m.approval.comment;
  await m.save();
  await recordAudit({ actor, action: `APPROVAL_${b.status}`, entity: 'CommunicationMessage', entityId: id, project: m.project ?? undefined, reason: b.comment });
  return getMessage(id);
}

export async function createProjectFromMail(id: string, b: z.infer<typeof createProjectFromMessage>, actor: Actor) {
  const m = await CommunicationMessage.findById(id).lean();
  if (!m) throw AppError.notFound('Message not found');
  if (m.type !== 'EMAIL') throw AppError.badRequest('Only an email can be converted to a project');
  if (m.project) throw AppError.conflict('This mail is already linked to a project');
  return createProject(
    {
      clientId: b.clientId, campaign: b.campaign, priority: b.priority, targetDate: b.targetDate, coordinatorId: b.coordinatorId, status: 'NEW',
      description: m.body.slice(0, 5000), sourceMessageId: String(m._id),
      requirement: {
        source: 'EMAIL', contact: { name: m.from?.name ?? undefined, email: m.from?.email ?? undefined },
        expectedSites: b.expectedSites, locations: [], description: m.body.slice(0, 5000), recceRequired: true,
        siteDataScenario: 'MEASUREMENT_REQUIRED',
        // attachments carried over so nobody retypes them
        attachments: (m.attachments ?? []).map((a) => ({ name: a.name ?? 'attachment', size: a.size ?? undefined, mimeType: a.mimeType ?? undefined, fileId: a.fileId ?? undefined, url: a.url ?? undefined })),
      },
    },
    actor,
  );
}

// ---- WhatsApp / group channels ----
export async function listChannels(projectId: string) {
  return CommunicationChannel.find({ project: projectId }).lean();
}

export async function upsertChannel(projectId: string, kind: 'WITH_CLIENT' | 'INTERNAL', b: z.infer<typeof channelBody>, actor: Actor) {
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).lean();
  if (!project) throw AppError.notFound('Project not found');
  const linked = !!(b.externalGroupId || b.externalGroupUrl);
  const prev = await CommunicationChannel.findOne({ project: projectId, kind }).lean();
  const ch = await CommunicationChannel.findOneAndUpdate(
    { project: projectId, kind },
    {
      groupName: b.groupName ?? `${project.code} - ${kind === 'WITH_CLIENT' ? 'Client' : 'Internal'}`,
      participants: b.participants.map(({ userId, ...p }) => ({ ...p, user: userId })),
      externalGroupId: b.externalGroupId, externalGroupUrl: b.externalGroupUrl,
      status: linked ? 'LINKED' : 'NOT_CREATED',
      ...(linked && prev?.status !== 'LINKED' ? { linkedAt: new Date(), linkedBy: actor.id } : {}),
      updatedBy: actor.id, $setOnInsert: { createdBy: actor.id },
    },
    { returnDocument: 'after', upsert: true },
  ).lean();
  if (linked && prev?.status !== 'LINKED') await systemMessage(projectId, `${kind === 'WITH_CLIENT' ? 'Client' : 'Internal'} group linked`, actor);
  await recordAudit({ actor, action: prev ? 'UPDATE' : 'CREATE', entity: 'CommunicationChannel', entityId: ch!._id, project: projectId });
  return ch;
}

export async function introMessage(projectId: string, kind: 'WITH_CLIENT' | 'INTERNAL') {
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).populate('client', 'name').lean();
  if (!project) throw AppError.notFound('Project not found');
  const ch = await CommunicationChannel.findOne({ project: projectId, kind }).lean();
  const people = (ch?.participants ?? []).filter((p) => p.included);
  const client = (project.client as unknown as { name: string }).name;
  const text = [
    `Hi Team,`,
    `This group is for the signage recce of ${client} - ${project.campaign ?? project.name} (${project.code}).`,
    people.length ? `Participants:\n${people.map((p) => `- ${p.name}${p.role ? ` (${p.role})` : ''}`).join('\n')}` : '',
    `Please share site details here and coordinate the recce plan.`,
    `Thanks`,
  ].filter(Boolean).join('\n\n');
  return { text, phones: people.map((p) => p.phone).filter(Boolean) };
}

