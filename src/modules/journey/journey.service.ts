import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { Client } from '../clients/client.model';
import { CodeRequest } from '../codeRequests/codeRequest.model';
import { Project } from '../projects/project.model';
import { SalesOrder } from '../sales/sales.model';
import { User } from '../users/user.model';
import { JourneyComment } from './journeyComment.model';
import type { commentBody, portfolioQuery } from './journey.validators';
import type { Actor } from '../../common/query';

/**
 * The project journey, built only from what the system records. The first four stages come from the BD handover and the
 * code requests; the rest are the real project statuses (RECCE_ASSIGNED -> PLANNING -> IN_PROGRESS -> CLIENT_APPROVAL ->
 * COMPLETED). Nothing here invents a workflow step the project does not have.
 */
export const STAGES = [
  { key: 'HANDOVER', label: 'BD Handover', dependsOn: [] },
  { key: 'CLIENT_CODE', label: 'Client Code', dependsOn: ['HANDOVER'] },
  { key: 'PROJECT_CODE', label: 'Project Code', dependsOn: ['HANDOVER'] },
  { key: 'RECCE_ASSIGNED', label: 'Recce Assigned', dependsOn: ['CLIENT_CODE', 'PROJECT_CODE'] },
  { key: 'PLANNING', label: 'Planning', dependsOn: ['RECCE_ASSIGNED'] },
  { key: 'FIELD_RECCE', label: 'Field Recce', dependsOn: ['PLANNING'] },
  { key: 'CLIENT_APPROVAL', label: 'Client Approval', dependsOn: ['FIELD_RECCE'] },
  { key: 'COMPLETED', label: 'Completed', dependsOn: ['CLIENT_APPROVAL'] },
] as const;
export type StageKey = (typeof STAGES)[number]['key'];
export type StageState = 'COMPLETED' | 'IN_PROGRESS' | 'PENDING' | 'BLOCKED' | 'NOT_APPLICABLE';

/** Project status -> the index (in STAGES) of the stage it means is current. */
const OPS_INDEX: Record<string, number> = { RECCE_ASSIGNED: 3, PLANNING: 4, IN_PROGRESS: 5, CLIENT_APPROVAL: 6, COMPLETED: 7 };
const HALTED = ['ON_HOLD', 'CANCELLED', 'LOSS'];
const LIVE = ['RECCE_ASSIGNED', 'PLANNING', 'IN_PROGRESS', 'CLIENT_APPROVAL'];
const DAY = 86_400_000;
const CODE_WAIT_DAYS = 3;

interface P {
  status: string;
  targetDate?: Date | null;
  assignedAt?: Date | null;
  createdAt?: Date;
}
/** The live status a halted project stopped at (from its last change), else its own status. */
const effectiveStatus = (p: P, changes: { at: Date; from: string; to: string }[]) => {
  if (!HALTED.includes(p.status)) return p.status;
  const last = [...changes].reverse().find((c) => c.to === p.status);
  return last?.from && OPS_INDEX[last.from] !== undefined ? last.from : 'RECCE_ASSIGNED';
};

async function statusChanges(projectId: Types.ObjectId | string) {
  const logs = await AuditLog.find({ entity: 'Project', entityId: projectId, action: 'STATUS_CHANGE' }).sort({ at: 1 }).lean();
  return logs.map((l) => ({ at: l.at as Date, from: String(l.changes?.[0]?.oldValue ?? ''), to: String(l.changes?.[0]?.newValue ?? ''), reason: l.reason ?? '', user: l.user as Types.ObjectId }));
}

export async function projectJourney(id: string) {
  const p = await Project.findOne({ _id: id, deletedAt: null }).select('+files').populate('client', 'name clientNo approvedCode').populate('assignedTo', 'name').populate('owner', 'name').lean();
  if (!p) throw AppError.notFound('Project not found');
  const [order, changes, commentRows] = await Promise.all([
    p.salesOrder ? SalesOrder.findById(p.salesOrder).select('orderNo owner csAssignee handover createdAt handoverDocumentsArray recce').populate('owner', 'name').populate('csAssignee', 'name').lean() : null,
    statusChanges(p._id),
    JourneyComment.find({ project: p._id }).sort({ createdAt: -1 }).limit(300).populate('author', 'name').lean(),
  ]);
  const rows = await CodeRequest.find({ order: order?._id ?? new Types.ObjectId() }).lean();
  const clientRef = p.client as unknown as { _id: Types.ObjectId; name: string; clientNo?: string; approvedCode?: string };
  const now = Date.now();

  const when = (status: string) => changes.find((c) => c.to === status)?.at;
  const current = effectiveStatus(p, changes);
  const idx = OPS_INDEX[current] ?? -1; // -1: not assigned to Recce yet
  const name = (u: unknown) => (u as { name?: string } | null | undefined)?.name ?? null;
  const cs = name(order?.csAssignee);
  const bd = name(order?.owner) ?? name(p.owner);
  const recce = name(p.assignedTo);

  const codeRow = (kind: 'CLIENT_CODE' | 'PROJECT_CODE') => rows.find((r) => r.kind === kind && r.status === 'CONFIRMED') ?? rows.find((r) => r.kind === kind && r.active);
  const clientRow = codeRow('CLIENT_CODE');
  const projectRow = codeRow('PROJECT_CODE');
  const clientDone = !!clientRow && clientRow.status === 'CONFIRMED';
  const hasOrder = !!order;

  type Draft = { state: StageState; assignee: string | null; startedAt?: Date | null; completedAt?: Date | null; pending: string[]; detail?: string };
  const D: Record<StageKey, Draft> = {
    HANDOVER: { state: 'COMPLETED', assignee: bd, startedAt: order?.createdAt ?? p.createdAt, completedAt: order?.handover?.assignedAt ?? p.createdAt, pending: [], detail: order ? `Order ${order.orderNo}${cs ? ` handed to ${cs}` : ''}` : 'Project created directly' },
    CLIENT_CODE: hasOrder
      ? clientDone || clientRef.approvedCode
        ? { state: 'COMPLETED', assignee: cs, startedAt: clientRow?.sentAt, completedAt: clientRow?.confirmedAt, pending: [], detail: `Code ${clientRow?.confirmedCode ?? clientRef.approvedCode}` }
        : clientRow
          ? { state: 'IN_PROGRESS', assignee: cs, startedAt: clientRow.sentAt, pending: ['Enter the confirmed client code'] }
          : { state: 'PENDING', assignee: cs, pending: ['Request the client code'] }
      : { state: 'NOT_APPLICABLE', assignee: null, pending: [], detail: 'Project was not created from a BD order' },
    PROJECT_CODE: { state: 'COMPLETED', assignee: cs, startedAt: projectRow?.sentAt ?? p.createdAt, completedAt: projectRow?.confirmedAt ?? p.createdAt, pending: [], detail: `Code ${p.code}` },
    RECCE_ASSIGNED: p.assignedAt ? { state: 'COMPLETED', assignee: recce, startedAt: p.assignedAt, completedAt: when('PLANNING'), pending: [], detail: recce ? `Assigned to ${recce}` : undefined } : { state: 'PENDING', assignee: null, pending: ['Assign the project to the Recce team'] },
    PLANNING: { state: 'PENDING', assignee: recce, startedAt: when('PLANNING'), completedAt: when('IN_PROGRESS'), pending: [] },
    FIELD_RECCE: { state: 'PENDING', assignee: recce, startedAt: when('IN_PROGRESS'), completedAt: when('CLIENT_APPROVAL'), pending: [] },
    CLIENT_APPROVAL: { state: 'PENDING', assignee: name(p.owner) ?? bd, startedAt: when('CLIENT_APPROVAL'), completedAt: when('COMPLETED'), pending: [] },
    COMPLETED: { state: 'PENDING', assignee: null, startedAt: when('COMPLETED'), completedAt: when('COMPLETED'), pending: [] },
  };
  // The Recce part follows the project's status.
  const NEXT: Record<number, string> = { 3: 'Start planning', 4: 'Start the field recce', 5: 'Send for client approval', 6: 'Mark completed after the client approves' };
  for (const [i, s] of STAGES.entries()) {
    if (i < 3) continue;
    const d = D[s.key];
    if (s.key === 'RECCE_ASSIGNED' && !p.assignedAt) continue;
    if (idx >= 0 && i < idx) d.state = 'COMPLETED';
    else if (idx >= 0 && i === idx) {
      d.state = current === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS';
      if (current !== 'COMPLETED' && NEXT[i]) d.pending = [NEXT[i]!];
      d.startedAt ??= p.assignedAt;
    } else if (i > idx) d.state = 'PENDING';
    if (s.key === 'RECCE_ASSIGNED' && p.assignedAt && idx >= 0 && idx > 3) d.state = 'COMPLETED';
  }
  if (HALTED.includes(p.status) && idx >= 0) {
    const d = D[STAGES[idx]!.key];
    d.state = 'BLOCKED';
    d.pending = [`Project is ${p.status.replace('_', ' ').toLowerCase()}`];
  }

  const byKey = new Map<StageKey, Draft>(STAGES.map((s) => [s.key, D[s.key]]));
  const stages = STAGES.map((s, i) => {
    const d = D[s.key];
    const unmet = s.dependsOn.filter((k) => {
      const st = byKey.get(k)!.state;
      return st !== 'COMPLETED' && st !== 'NOT_APPLICABLE';
    });
    const started = d.startedAt ? new Date(d.startedAt).getTime() : null;
    const ended = d.completedAt ? new Date(d.completedAt).getTime() : null;
    const elapsedDays = started ? Math.max(0, Math.round(((d.state === 'COMPLETED' && ended ? ended : now) - started) / DAY)) : null;
    const liveOverdue = d.state === 'IN_PROGRESS' && i >= 3 && LIVE.includes(current) && !!p.targetDate && new Date(p.targetDate).getTime() < now;
    const codeOverdue = d.state === 'IN_PROGRESS' && i < 3 && !!started && now - started > CODE_WAIT_DAYS * DAY;
    const notes = changes
      .filter((c) => c.reason && ((s.key === 'PLANNING' && c.to === 'PLANNING') || (s.key === 'FIELD_RECCE' && c.to === 'IN_PROGRESS') || (s.key === 'CLIENT_APPROVAL' && c.to === 'CLIENT_APPROVAL') || (s.key === 'COMPLETED' && c.to === 'COMPLETED')))
      .map((c) => ({ text: c.reason, at: c.at }));
    const attachments = s.key === 'HANDOVER' ? (order?.handoverDocumentsArray?.length ?? 0) : s.key === 'FIELD_RECCE' ? ((p as { files?: { deletedAt?: Date }[] }).files ?? []).filter((f) => !f.deletedAt).length : 0;
    return {
      key: s.key,
      label: s.label,
      index: i,
      state: d.state,
      assignee: d.assignee,
      startedAt: d.startedAt ?? null,
      completedAt: d.completedAt ?? null,
      elapsedDays,
      detail: d.detail ?? null,
      dependsOn: s.dependsOn.map((k) => STAGES.find((x) => x.key === k)!.label),
      waitingOn: unmet.map((k) => STAGES.find((x) => x.key === k)!.label),
      pendingActions: d.pending,
      overdue: liveOverdue || codeOverdue,
      overdueReason: liveOverdue ? `Target date ${new Date(p.targetDate!).toISOString().slice(0, 10)} has passed` : codeOverdue ? `Waiting more than ${CODE_WAIT_DAYS} days` : null,
      notes,
      attachments,
      comments: commentRows.filter((c) => c.stage === s.key).map((c) => ({ id: String(c._id), text: c.body, at: c.createdAt as Date, author: name(c.author) ?? 'Removed user', authorId: String((c.author as { _id?: Types.ObjectId } | null)?._id ?? '') })),
    };
  });
  const currentStage = stages.find((s) => s.state === 'IN_PROGRESS' || s.state === 'BLOCKED') ?? stages.find((s) => s.state === 'PENDING') ?? stages[stages.length - 1]!;
  return {
    project: { _id: String(p._id), code: p.code, name: p.name, status: p.status, priority: p.priority, targetDate: p.targetDate ?? null, startDate: p.startDate ?? null, client: { _id: String(clientRef._id), name: clientRef.name, clientNo: clientRef.clientNo ?? null }, assignedTo: recce, owner: name(p.owner) },
    currentStage: currentStage.key,
    progress: Math.round((stages.filter((s) => s.state === 'COMPLETED' || s.state === 'NOT_APPLICABLE').length / stages.length) * 100),
    overdue: stages.some((s) => s.overdue),
    stages,
  };
}

/** Portfolio matrix: every project with the state of each stage, cheaply (no per-project audit reads). */
export async function portfolio(q: z.infer<typeof portfolioQuery>) {
  const filter: Record<string, unknown> = { deletedAt: null };
  if (q.status) filter.status = q.status;
  if (q.clientId) filter.client = new Types.ObjectId(q.clientId);
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const clients = await Client.find({ name: re }).select('_id').limit(200).lean();
    filter.$or = [{ code: re }, { name: re }, { campaign: re }, { client: { $in: clients.map((c) => c._id) } }];
  }
  if (q.stage) {
    const s = STAGES.findIndex((x) => x.key === q.stage);
    const st = Object.entries(OPS_INDEX).filter(([, i]) => i === s).map(([k]) => k);
    if (st.length) filter.status = { $in: st };
  }
  if (q.overdue) {
    filter.status = { $in: LIVE };
    filter.targetDate = { $lt: new Date() };
  }
  const [rows, total, byStatus] = await Promise.all([
    Project.find(filter).select('code name status targetDate assignedAt assignedTo client salesOrder priority createdAt').sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('client', 'name clientNo approvedCode').populate('assignedTo', 'name').lean(),
    Project.countDocuments(filter),
    Project.aggregate<{ _id: string; n: number }>([{ $match: { deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const orderIds = rows.map((r) => r.salesOrder).filter((x): x is Types.ObjectId => !!x);
  const codes = await CodeRequest.find({ order: { $in: orderIds }, kind: 'CLIENT_CODE' }).select('order status active').lean();
  const now = Date.now();
  const items = rows.map((p) => {
    const idx = OPS_INDEX[p.status] ?? -1;
    const c = p.client as unknown as { name: string; clientNo?: string; approvedCode?: string };
    const mine = codes.filter((x) => String(x.order) === String(p.salesOrder));
    const clientState: StageState = !p.salesOrder ? 'NOT_APPLICABLE' : c.approvedCode || mine.some((x) => x.status === 'CONFIRMED') ? 'COMPLETED' : mine.some((x) => x.active) ? 'IN_PROGRESS' : 'PENDING';
    const states: StageState[] = STAGES.map((s, i) => {
      if (s.key === 'HANDOVER' || s.key === 'PROJECT_CODE') return 'COMPLETED';
      if (s.key === 'CLIENT_CODE') return clientState;
      if (s.key === 'RECCE_ASSIGNED' && !p.assignedAt) return 'PENDING';
      if (idx < 0) return 'PENDING';
      if (HALTED.includes(p.status)) return i < 3 ? 'COMPLETED' : 'PENDING';
      return i < idx || p.status === 'COMPLETED' ? 'COMPLETED' : i === idx ? 'IN_PROGRESS' : 'PENDING';
    });
    return {
      _id: String(p._id),
      code: p.code,
      name: p.name,
      status: p.status,
      priority: p.priority,
      targetDate: p.targetDate ?? null,
      client: { name: c.name, clientNo: c.clientNo ?? null },
      assignedTo: (p.assignedTo as unknown as { name?: string } | null)?.name ?? null,
      states,
      overdue: LIVE.includes(p.status) && !!p.targetDate && new Date(p.targetDate).getTime() < now,
    };
  });
  const count = (...s: string[]) => byStatus.filter((b) => s.includes(b._id)).reduce((a, b) => a + b.n, 0);
  return {
    items,
    meta: {
      ...pageMeta(q.page, q.limit, total),
      stages: STAGES.map((s) => ({ key: s.key, label: s.label })),
      summary: {
        total: byStatus.reduce((a, b) => a + b.n, 0),
        recceAssigned: count('RECCE_ASSIGNED'),
        planning: count('PLANNING'),
        inProgress: count('IN_PROGRESS'),
        clientApproval: count('CLIENT_APPROVAL'),
        completed: count('COMPLETED'),
        halted: count(...HALTED),
        overdue: await Project.countDocuments({ deletedAt: null, status: { $in: LIVE }, targetDate: { $lt: new Date() } } as Record<string, unknown>),
      },
    },
  };
}

export const userNameOf = async (id: Types.ObjectId) => (await User.findById(id).select('name').lean())?.name ?? null;

export async function addComment(projectId: string, input: z.infer<typeof commentBody>, a: Actor) {
  if (!(await Project.exists({ _id: projectId, deletedAt: null }))) throw AppError.notFound('Project not found');
  await JourneyComment.create({ project: projectId, stage: input.stage, body: input.body, author: a.id });
  return projectJourney(projectId);
}

/** The author or Super Admin removes a comment. */
export async function deleteComment(projectId: string, commentId: string, a: Actor) {
  const c = await JourneyComment.findOne({ _id: commentId, project: projectId });
  if (!c) throw AppError.notFound('Comment not found');
  if (String(c.author) !== a.id && a.role !== 'SUPER_ADMIN') throw AppError.forbidden();
  await c.deleteOne();
  return projectJourney(projectId);
}
