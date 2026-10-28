import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { objectId, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { User } from '../users/user.model';
import { EXPENSE_CATEGORIES, Expense } from './expense.model';

export const expenseBody = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.coerce.number().positive('Enter the amount').max(1_000_000),
  date: z.coerce.date(),
  note: z.string().trim().max(500).optional(),
  /** The bill / ticket / receipt, uploaded first in the RECCE_EXPENSE file category. */
  receiptFileId: objectId.optional(),
});
export const reviewBody = z
  .object({ status: z.enum(['APPROVED', 'REJECTED', 'PENDING']), remark: z.string().trim().max(500).optional() })
  .refine((v) => v.status !== 'REJECTED' || !!v.remark, { path: ['remark'], message: 'Say why the claim is rejected' });

async function requireProject(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('code client').lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}

/** Admin and Finance: the people who approve claims and special costs. */
export async function approverIds() {
  const users = await User.find({ role: { $in: ['SUPER_ADMIN', 'FINANCE'] }, isActive: true, deletedAt: null }).select('_id').lean();
  return users.map((u) => u._id);
}

export async function notifyApprovers(project: { _id: Types.ObjectId; code: string; client: unknown }, title: string, body: string, key: string, actor: Actor) {
  const client = await Client.findById(project.client).select('name').lean();
  await notify({ kind: 'COST_APPROVAL', recipients: await approverIds(), title, body, project: { _id: project._id, code: project.code, clientName: client?.name }, actorId: actor.id, dedupe: (r) => `${key}:${r}` });
}

async function assertReceipt(projectId: string, fileId: string) {
  const ok = await Project.exists({ _id: projectId, files: { $elemMatch: { _id: fileId, category: 'RECCE_EXPENSE', deletedAt: null } } });
  if (!ok) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'receiptFileId', message: 'Upload the bill first (Expenses category) and attach it here' }]);
}

export async function listExpenses(projectId: string) {
  await requireProject(projectId);
  const items = await Expense.find({ project: projectId }).sort({ date: -1, createdAt: -1 }).populate('submittedBy', 'name role').populate('reviewedBy', 'name').lean();
  const sum = (f: (e: (typeof items)[number]) => boolean) => Math.round(items.filter(f).reduce((a, e) => a + e.amount, 0) * 100) / 100;
  const byCategory: Record<string, number> = {};
  for (const e of items.filter((x) => x.status !== 'REJECTED')) byCategory[e.category] = Math.round(((byCategory[e.category] ?? 0) + e.amount) * 100) / 100;
  return {
    items,
    totals: { all: sum((e) => e.status !== 'REJECTED'), approved: sum((e) => e.status === 'APPROVED'), pending: sum((e) => e.status === 'PENDING'), rejected: sum((e) => e.status === 'REJECTED'), withoutProof: items.filter((e) => !e.receiptFileId && e.status !== 'REJECTED').length },
    byCategory,
  };
}

export async function createExpense(projectId: string, body: z.infer<typeof expenseBody>, actor: Actor) {
  const project = await requireProject(projectId);
  await assertNotCancelled(projectId);
  if (body.receiptFileId) await assertReceipt(projectId, body.receiptFileId);
  const e = await Expense.create({ ...body, project: projectId, submittedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'Expense', entityId: e._id, project: projectId, reason: `${body.category} ₹${body.amount}` });
  await notifyApprovers(project, `Expense claim: ${project.code}`, `A ${body.category.toLowerCase()} claim of ₹${body.amount} was submitted${body.receiptFileId ? ' with proof' : ' WITHOUT proof'}.`, `expense:${e._id}`, actor);
  return e.toObject();
}

export async function reviewExpense(id: string, body: z.infer<typeof reviewBody>, actor: Actor) {
  const e = await Expense.findById(id);
  if (!e) throw AppError.notFound('Expense not found');
  if (body.status === 'APPROVED' && !e.receiptFileId) throw AppError.conflict('A claim without a bill or ticket cannot be approved');
  const old = e.status;
  e.set({ status: body.status, reviewRemark: body.remark, reviewedBy: actor.id, reviewedAt: new Date() });
  await e.save();
  await recordAudit({ actor, action: 'EXPENSE_REVIEW', entity: 'Expense', entityId: e._id, project: e.project, changes: [{ field: 'status', oldValue: old, newValue: body.status }], reason: body.remark });
  return e.toObject();
}

export async function deleteExpense(id: string, actor: Actor) {
  const e = await Expense.findById(id);
  if (!e) throw AppError.notFound('Expense not found');
  const finance = actor.role === 'SUPER_ADMIN' || actor.role === 'FINANCE';
  if (!finance && String(e.submittedBy) !== actor.id) throw AppError.forbidden('You can delete only your own claims');
  if (!finance && e.status !== 'PENDING') throw AppError.conflict('A reviewed claim cannot be deleted');
  await assertNotCancelled(e.project);
  await Expense.deleteOne({ _id: id });
  await recordAudit({ actor, action: 'DELETE', entity: 'Expense', entityId: id, project: e.project });
}
