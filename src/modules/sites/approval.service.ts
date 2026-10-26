import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { assertNotCancelled } from '../../common/project-access';
import { recordAudit } from '../audit/audit.service';
import { notifyProjectParty } from '../notifications/notification.service';
import { permissionsFor, type Permission, type Role } from '../roles/roles';
import { APPROVAL_STATES, Site } from './site.model';
import { requireProject } from './site.service';

export const approvalBody = z
  .object({ level: z.enum(['ops', 'bd']), value: z.enum(APPROVAL_STATES), note: z.string().trim().max(500).optional() })
  .refine((v) => v.value !== 'CORRECTION' || !!v.note, { path: ['note'], message: 'Say what needs correcting' });
export const approveAllBody = z.object({ level: z.enum(['ops', 'bd']) });

const FIELD = { ops: 'opsApproval', bd: 'bdApproval' } as const;
const NEEDS: Record<'ops' | 'bd', Permission> = { ops: 'verification:manage', bd: 'approvals:client' };

/** Operations approves the ops level, BD approves the BD level; neither can act for the other (Super Admin can). */
function assertLevel(actor: Actor, level: 'ops' | 'bd') {
  if (!permissionsFor(actor.role as Role).includes(NEEDS[level])) throw AppError.forbidden(`Only ${level === 'ops' ? 'Operations' : 'BD'} can set the ${level === 'ops' ? 'Operations' : 'BD'} approval`);
}

export async function setApproval(siteId: string, body: z.infer<typeof approvalBody>, actor: Actor) {
  assertLevel(actor, body.level);
  const site = await Site.findOne({ _id: siteId, deletedAt: null });
  if (!site) throw AppError.notFound('Site not found');
  await assertNotCancelled(site.project);
  if (site.scenario === 'CLIENT_PROVIDED' && body.value === 'APPROVED' && (!site.width || !site.height))
    throw new AppError(422, 'VALIDATION_ERROR', 'A shop without a measurement cannot be approved', [{ path: 'width', message: 'Add the board width and height first' }]);
  const field = FIELD[body.level];
  const old = site.get(field) as string;
  site.set({ [field]: body.value, [`${body.level}ApprovalAt`]: new Date(), [`${body.level}ApprovalBy`]: actor.id, approvalNote: body.value === 'CORRECTION' ? body.note : undefined, approvalUpdatedAt: new Date(), approvalUpdatedBy: actor.id });
  await site.save();
  await recordAudit({ actor, action: 'APPROVAL', entity: 'Site', entityId: site._id, project: site.project, changes: [{ field, oldValue: old, newValue: body.value }], reason: body.note });
  if (body.value === 'CORRECTION') {
    // A correction asked by Operations goes to BD, and one asked by BD goes to Operations.
    const label = site.shopName || site.dealerName || site.siteCode;
    await notifyProjectParty(
      site.project,
      body.level === 'ops' ? 'owner' : 'assignee',
      {
        kind: 'APPROVAL_CORRECTION',
        title: `Correction requested: ${label}`,
        body: `${body.level === 'ops' ? 'Operations' : 'BD'} asked for a correction on ${label}: ${body.note}`,
        dedupe: (r) => `correction:${site._id}:${body.level}:${site.approvalUpdatedAt?.getTime()}:${r}`,
      },
      actor.id,
    );
  }
  return site.toObject();
}

/** Approves every still-pending shop that has a measurement. Never touches shops already approved or sent for correction. */
export async function approveAllPending(projectId: string, level: 'ops' | 'bd', actor: Actor) {
  assertLevel(actor, level);
  const project = await requireProject(projectId);
  await assertNotCancelled(projectId);
  const field = FIELD[level];
  // Only measurement projects need a size before approval; for shop-details projects approval means "details verified".
  const needsSize = project.requirementType === 'SHOP_MEASUREMENT' ? { width: { $gt: 0 }, height: { $gt: 0 } } : {};
  const res = await Site.updateMany(
    { project: projectId, deletedAt: null, [field]: 'PENDING', ...needsSize },
    { $set: { [field]: 'APPROVED', [`${level}ApprovalAt`]: new Date(), [`${level}ApprovalBy`]: actor.id, approvalUpdatedAt: new Date(), approvalUpdatedBy: actor.id } },
  );
  await recordAudit({ actor, action: 'APPROVAL', entity: 'Project', entityId: projectId, project: projectId, reason: `${level.toUpperCase()} approved ${res.modifiedCount} shop(s)` });
  const skipped = await Site.countDocuments({ project: projectId, deletedAt: null, [field]: 'PENDING' });
  return { approved: res.modifiedCount, stillPending: skipped };
}

/** For each level: how many shops are approved / pending / need correction, who approved last and when, and the latest correction note. */
export async function approvalSummary(projectId: string) {
  await requireProject(projectId);
  const base = { project: projectId, deletedAt: null };
  const out: Record<'ops' | 'bd', { approved: number; pending: number; correction: number; total: number; lastBy?: string; lastAt?: Date; note?: string }> = {
    ops: { approved: 0, pending: 0, correction: 0, total: 0 },
    bd: { approved: 0, pending: 0, correction: 0, total: 0 },
  };
  for (const level of ['ops', 'bd'] as const) {
    const field = FIELD[level];
    const counts = await Site.aggregate([{ $match: { ...base, project: new Types.ObjectId(projectId) } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
    for (const c of counts) {
      const k = c._id === 'APPROVED' ? 'approved' : c._id === 'CORRECTION' ? 'correction' : 'pending';
      out[level][k] += c.n;
      out[level].total += c.n;
    }
    const last = await Site.findOne({ ...base, [`${level}ApprovalAt`]: { $ne: null } }).sort({ [`${level}ApprovalAt`]: -1 }).select(`${level}ApprovalAt ${level}ApprovalBy`).populate(`${level}ApprovalBy`, 'name').lean();
    if (last) {
      out[level].lastAt = (last as Record<string, any>)[`${level}ApprovalAt`];
      out[level].lastBy = (last as Record<string, any>)[`${level}ApprovalBy`]?.name;
    }
    const corr = await Site.findOne({ ...base, [field]: 'CORRECTION' }).sort({ approvalUpdatedAt: -1 }).select('approvalNote').lean();
    if (corr?.approvalNote) out[level].note = corr.approvalNote;
  }
  return out;
}
