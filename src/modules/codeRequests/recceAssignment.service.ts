import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { AuditLog } from '../audit/auditLog.model';
import { Project } from '../projects/project.model';
import { assignProject } from '../projects/project.service';
import { liveOrder } from '../sales/order.service';
import { SalesOrder } from '../sales/sales.model';
import { User } from '../users/user.model';
import { assertCodeActor } from './codeRequest.service';
import type { recceAssignmentBody } from './codeRequest.validators';

const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);
/** Statuses in which a project counts as someone's open work. */
const OPEN = ['RECCE_ASSIGNED', 'PLANNING', 'IN_PROGRESS', 'CLIENT_APPROVAL'];
/** The project is no longer movable once the field recce started. */
const MOVABLE = ['DRAFT', 'ENQUIRY', 'NEW', 'RECCE_ASSIGNED', 'PLANNING'];
const ROLES = ['OPERATIONS', 'RECCE_COORDINATOR', 'RECCE_EXECUTIVE'] as const;

async function projectOf(orderId: string) {
  const o = await liveOrder(orderId);
  const p = await Project.findOne({ salesOrder: o._id, deletedAt: null }).populate('assignedTo', 'name role').lean();
  if (!p) throw AppError.notFound('Create the project for this order first.');
  return { o, p };
}

/**
 * The Recce Assignment screen: the project, the people it can go to with their current workload, and who it was
 * assigned to before. A Recce executive can take the project directly only for an ASO survey (no shop list to plan).
 */
export async function recceAssignment(orderId: string, actor: Actor) {
  assertCodeActor(actor);
  const { o, p } = await projectOf(orderId);
  const [users, load, logs] = await Promise.all([
    User.find({ role: { $in: ROLES as never }, isActive: true, deletedAt: null }).select('name role email phone').sort({ name: 1 }).lean(),
    Project.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { deletedAt: null, status: { $in: OPEN }, assignedTo: { $ne: null } } }, { $group: { _id: '$assignedTo', n: { $sum: 1 } } }]),
    AuditLog.find({ entity: 'Project', entityId: p._id, action: 'ASSIGN' }).sort({ at: -1 }).limit(50).populate('user', 'name').lean(),
  ]);
  const aso = p.requirementType === 'ASO';
  const assignee = p.assignedTo as unknown as { _id: Types.ObjectId; name: string; role: string } | null;
  return {
    order: { _id: String(o._id), orderNo: o.orderNo },
    project: {
      _id: String(p._id),
      code: p.code,
      campaign: p.campaign ?? null,
      district: p.district ?? null,
      status: p.status,
      priority: p.priority,
      requirementType: p.requirementType ?? null,
      expectedShops: p.expectedShops ?? null,
      startDate: p.startDate ?? null,
      targetDate: p.targetDate ?? null,
      assignedTo: assignee ? { id: String(assignee._id), name: assignee.name, role: assignee.role } : null,
      assignedAt: p.assignedAt ?? null,
    },
    canAssign: MOVABLE.includes(p.status),
    people: users.map((u) => ({
      id: String(u._id),
      name: u.name,
      role: u.role,
      email: u.email,
      phone: u.phone ?? null,
      openProjects: load.find((l) => String(l._id) === String(u._id))?.n ?? 0,
      eligible: u.role !== 'RECCE_EXECUTIVE' || aso,
      current: !!assignee && String(assignee._id) === String(u._id),
    })),
    history: logs.map((l) => ({ id: String(l._id), at: l.at as Date, by: (l.user as unknown as { name?: string } | null)?.name ?? null, text: l.reason ?? 'Assigned' })),
  };
}

export async function assignRecceTeam(orderId: string, input: z.infer<typeof recceAssignmentBody>, actor: Actor) {
  assertCodeActor(actor);
  const { o, p } = await projectOf(orderId);
  if (!MOVABLE.includes(p.status)) throw AppError.conflict(`A ${p.status.toLowerCase().replace('_', ' ')} project cannot be (re)assigned.`);
  if (input.targetDate) {
    if (p.startDate && new Date(input.targetDate) < new Date(p.startDate)) throw invalid('targetDate', 'End date must be on or after the start date');
    if (String(p.targetDate ?? '') !== String(new Date(input.targetDate))) {
      await Project.updateOne({ _id: p._id }, { $set: { targetDate: new Date(input.targetDate), updatedBy: actor.id } });
      await recordAudit({ actor, action: 'UPDATE', entity: 'Project', entityId: p._id, project: p._id, changes: [{ field: 'targetDate', oldValue: p.targetDate ?? null, newValue: input.targetDate }], reason: 'Due date changed while assigning' });
    }
  }
  await assignProject(String(p._id), { assigneeId: input.assigneeId, note: input.note }, actor);
  const person = await User.findById(input.assigneeId).select('name').lean();
  const now = new Date();
  await SalesOrder.updateOne({ _id: o._id }, { $set: { recce: { ...(o.toObject().recce ?? {}), assignee: input.assigneeId, assignedAt: now, assignedBy: actor.id, note: input.note ?? null }, updatedBy: actor.id } });
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'recce.assignee', oldValue: o.recce?.assignee ? String(o.recce.assignee) : null, newValue: input.assigneeId }], reason: `Project ${p.code} assigned to ${person?.name ?? 'the Recce team'}${input.note ? `: ${input.note}` : ''}` });
  return recceAssignment(orderId, actor);
}
