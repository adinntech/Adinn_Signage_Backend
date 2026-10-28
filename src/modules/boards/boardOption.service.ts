import { Types } from 'mongoose';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { objectId, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Project } from '../projects/project.model';
import { sqftOf, UNITS } from '../sites/site.fields';
import { Site } from '../sites/site.model';
import { BOARD_DECISIONS, BoardOption } from './boardOption.model';

const num = z.coerce.number().positive('Must be more than 0').max(100000);
export const boardBody = z.object({
  siteId: objectId,
  boardType: z.string().trim().min(2, 'Enter the board type').max(120),
  width: num.optional(),
  height: num.optional(),
  unit: z.enum(UNITS).default('ft'),
  quantity: z.coerce.number().int().min(1).max(1000).default(1),
  notes: z.string().trim().max(1000).optional(),
});
// No defaults here: a PATCH that omits quantity or unit must keep the stored values.
export const boardPatch = z.object({
  boardType: boardBody.shape.boardType.optional(),
  width: num.optional(),
  height: num.optional(),
  unit: z.enum(UNITS).optional(),
  quantity: z.coerce.number().int().min(1).max(1000).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export const decisionBody = z
  .object({ decision: z.enum(BOARD_DECISIONS), remark: z.string().trim().max(1000).optional() })
  .refine((v) => v.decision === 'APPROVED' || v.decision === 'PENDING' || !!v.remark, { path: ['remark'], message: 'Give the reason for rejecting or changing this board' });

async function requireProject(projectId: string) {
  if (!(await Project.exists({ _id: projectId, deletedAt: null }))) throw AppError.notFound('Project not found');
}
async function requireSite(projectId: string, siteId: string) {
  if (!(await Site.exists({ _id: siteId, project: projectId, deletedAt: null }))) throw AppError.notFound('Shop not found in this project');
}
const sqftFor = (b: { width?: number | null | undefined; height?: number | null | undefined; unit?: string | null | undefined; quantity?: number | null | undefined }) =>
  sqftOf(b.width, b.height, (b.unit as never) ?? 'ft', b.quantity ?? 1);

export async function listBoards(projectId: string, siteId?: string) {
  await requireProject(projectId);
  return BoardOption.find({ project: projectId, ...(siteId && /^[a-f\d]{24}$/i.test(siteId) ? { site: siteId } : {}) }).sort({ createdAt: 1 }).lean();
}

/** Per shop: how many options and how they stand, for the shop list and the summary strip. */
export async function boardSummary(projectId: string) {
  await requireProject(projectId);
  const rows = await BoardOption.aggregate([
    { $match: { project: new Types.ObjectId(projectId) } },
    { $group: { _id: { site: '$site', decision: '$decision' }, n: { $sum: 1 } } },
  ]);
  const totals: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, CHANGED: 0 };
  const perSite: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    totals[r._id.decision] = (totals[r._id.decision] ?? 0) + r.n;
    (perSite[String(r._id.site)] ??= {})[r._id.decision] = r.n;
  }
  return { totals, perSite };
}

export async function createBoard(projectId: string, body: z.infer<typeof boardBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  await requireSite(projectId, body.siteId);
  const { siteId, ...rest } = body;
  const b = await BoardOption.create({ ...rest, sqft: sqftFor(rest), project: projectId, site: siteId, createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'BoardOption', entityId: b._id, project: projectId, reason: `Board option ${b.boardType}` });
  return b.toObject();
}

export async function updateBoard(id: string, patch: z.infer<typeof boardPatch>, actor: Actor) {
  const b = await BoardOption.findById(id);
  if (!b) throw AppError.notFound('Board option not found');
  await assertNotCancelled(b.project);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  b.set({ ...clean, updatedBy: actor.id });
  b.set('sqft', sqftFor(b));
  // A changed board must be shown to the client again.
  if (b.decision !== 'PENDING' && ['boardType', 'width', 'height', 'unit', 'quantity'].some((k) => k in clean)) {
    b.set({ decision: 'PENDING', decisionRemark: undefined, decidedAt: undefined, decidedBy: undefined });
  }
  await b.save();
  await recordAudit({ actor, action: 'UPDATE', entity: 'BoardOption', entityId: b._id, project: b.project });
  return b.toObject();
}

export async function decideBoard(id: string, body: z.infer<typeof decisionBody>, actor: Actor) {
  const b = await BoardOption.findById(id);
  if (!b) throw AppError.notFound('Board option not found');
  await assertNotCancelled(b.project);
  const old = b.decision;
  const pending = body.decision === 'PENDING';
  b.set({
    decision: body.decision,
    decisionRemark: pending ? undefined : body.remark,
    decidedAt: pending ? undefined : new Date(),
    decidedBy: pending ? undefined : actor.id,
    updatedBy: actor.id,
  });
  await b.save();
  await recordAudit({
    actor, action: 'BOARD_DECISION', entity: 'BoardOption', entityId: b._id, project: b.project,
    changes: [{ field: 'decision', oldValue: old, newValue: body.decision }], reason: body.remark ?? `${b.boardType}: ${body.decision}`,
  });
  return b.toObject();
}

export async function deleteBoard(id: string, actor: Actor) {
  const b = await BoardOption.findById(id).select('project').lean();
  if (!b) throw AppError.notFound('Board option not found');
  await assertNotCancelled(b.project);
  await BoardOption.deleteOne({ _id: id });
  await recordAudit({ actor, action: 'DELETE', entity: 'BoardOption', entityId: id, project: b.project });
}

const LABEL: Record<string, string> = { PENDING: 'Waiting for client', APPROVED: 'OK', REJECTED: 'Cancelled', CHANGED: 'Board changed' };
const COLUMNS: [string, string, number][] = [
  ['Shop code', 'siteCode', 16], ['Shop name', 'shopName', 26], ['Dealer', 'dealerName', 22], ['Area', 'location', 18], ['District', 'district', 16], ['Mobile', 'mobile', 14],
  ['Board type', 'boardType', 22], ['Width', 'width', 9], ['Height', 'height', 9], ['Unit', 'unit', 7], ['Qty', 'quantity', 6], ['Sq.ft', 'sqft', 9],
  ['Client decision', 'decision', 18], ['Reason / remark', 'remark', 36], ['Notes', 'notes', 30],
];
// Typed text must never become a spreadsheet formula.
const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);

/** The sheet BD and the client use to finalise: every shop, every board tried and what the client said. */
export async function exportBoards(projectId: string, decision?: string) {
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).select('code').lean();
  if (!project) throw AppError.notFound('Project not found');
  const only: Record<string, unknown> = decision && (BOARD_DECISIONS as readonly string[]).includes(decision) ? { decision } : {};
  const [boards, sites] = await Promise.all([
    BoardOption.find({ project: projectId, ...only }).sort({ createdAt: 1 }).lean(),
    Site.find({ project: projectId, deletedAt: null }).select('siteCode shopName dealerName location district mobile').lean(),
  ]);
  const byId = new Map(sites.map((s) => [String(s._id), s]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Board options');
  ws.columns = COLUMNS.map(([header, key, width]) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const b of boards) {
    const s = byId.get(String(b.site));
    ws.addRow({
      siteCode: s?.siteCode, shopName: safe(s?.shopName), dealerName: safe(s?.dealerName), location: safe(s?.location), district: safe(s?.district), mobile: s?.mobile,
      boardType: safe(b.boardType), width: b.width, height: b.height, unit: b.unit, quantity: b.quantity, sqft: b.sqft,
      decision: LABEL[b.decision] ?? b.decision, remark: safe(b.decisionRemark), notes: safe(b.notes),
    });
  }
  return { buffer: Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), fileName: `${project.code}-board-options.xlsx`, count: boards.length };
}
