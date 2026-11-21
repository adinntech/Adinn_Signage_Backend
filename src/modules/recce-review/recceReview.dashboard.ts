import type { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { objectId, type Actor } from '../../common/query';
import { Project } from '../projects/project.model';
import { verifiedRecceCost } from '../recce-cost/recceCost.service';
import { ROLE_PERMISSIONS, type Role } from '../roles/roles';
import { Site } from '../sites/site.model';
import { Vendor } from '../vendors/vendor.model';
import { oid, reviewProjectIds } from './recceReview.common';
import { mineFilter } from './recceReview.field';
import { RecceReview, RecceRework, RecceSubmission, RecceVersion } from './recceReview.model';

/**
 * Dashboards, computed from the real submission, version, review and rework records with a handful of indexed queries ($in on the
 * shops in scope), never one query per shop. One set of definitions serves the field user and the staff view:
 *
 *   started        the shop has a recce record (the visit was started)
 *   submitted      the shop has been submitted at least once (any version)
 *   underReview    waiting for a reviewer right now (SUBMITTED / UNDER_REVIEW)
 *   approved       status APPROVED
 *   rework         status REWORK_REQUIRED right now
 *   completed      APPROVED by EVERY required stage on the CURRENT version: status APPROVED and, for each stage listed on the current
 *                  version, an APPROVED review row for that version (an Admin override is recorded as approved rows too)
 *   pending        in scope but not completed (field view: assigned shops; staff view: started shops)
 *   reworkCount    shops that ever had a rework / more-photos request (each shop once, however many requests)
 *   reworkPercent  reworkCount / submitted x 100 (1 decimal, 0 when nothing was submitted)
 *   avgCompletionHours  mean of (finalApprovedAt - startedAt) over completed shops that have both dates, 1 decimal, null when none
 */

type SubRow = { _id: Types.ObjectId; project: Types.ObjectId; site: Types.ObjectId; channel?: string | null | undefined; vendor?: Types.ObjectId | null | undefined; status: string; currentVersion?: number | null | undefined; startedAt?: Date | null | undefined; createdAt?: Date | null | undefined; finalApprovedAt?: Date | null | undefined };
const SUB_FIELDS = 'project site channel vendor status currentVersion startedAt createdAt finalApprovedAt';

type Tally = { started: number; submitted: number; underReview: number; approved: number; rework: number; completed: number; reworkShops: number; hoursSum: number; hoursN: number };
const tally = (): Tally => ({ started: 0, submitted: 0, underReview: 0, approved: 0, rework: 0, completed: 0, reworkShops: 0, hoursSum: 0, hoursN: 0 });
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Which of these shops are completed, and which ever had rework: three queries for any number of shops. */
async function evidence(subs: SubRow[]) {
  const ids = subs.map((s) => s._id);
  if (!ids.length) return { completed: new Set<string>(), reworked: new Set<string>() };
  const [versions, approvedRows, reworks] = await Promise.all([
    RecceVersion.find({ submission: { $in: ids } }).select('submission version stages').lean(),
    RecceReview.find({ submission: { $in: ids }, decision: 'APPROVED' }).select('submission versionNo stage').lean(),
    RecceRework.distinct('submission', { submission: { $in: ids } }),
  ]);
  const stagesOf = new Map(versions.map((v) => [`${String(v.submission)}:${v.version}`, (v.stages ?? []) as string[]]));
  const approvedBy = new Map<string, Set<string>>();
  for (const r of approvedRows) {
    const k = `${String(r.submission)}:${r.versionNo}`;
    approvedBy.set(k, (approvedBy.get(k) ?? new Set()).add(r.stage));
  }
  const completed = new Set<string>();
  for (const s of subs) {
    const k = `${String(s._id)}:${s.currentVersion ?? 0}`;
    const need = stagesOf.get(k) ?? [];
    if (s.status === 'APPROVED' && (s.currentVersion ?? 0) > 0 && need.length > 0 && need.every((st) => approvedBy.get(k)?.has(st))) completed.add(String(s._id));
  }
  return { completed, reworked: new Set(reworks.map(String)) };
}

function add(t: Tally, s: SubRow, ev: Awaited<ReturnType<typeof evidence>>) {
  t.started++;
  if ((s.currentVersion ?? 0) > 0) t.submitted++;
  if (s.status === 'SUBMITTED' || s.status === 'UNDER_REVIEW') t.underReview++;
  if (s.status === 'APPROVED') t.approved++;
  if (s.status === 'REWORK_REQUIRED') t.rework++;
  if (ev.reworked.has(String(s._id))) t.reworkShops++;
  if (ev.completed.has(String(s._id))) {
    t.completed++;
    const from = s.startedAt ?? s.createdAt;
    if (from && s.finalApprovedAt) { t.hoursSum += (s.finalApprovedAt.getTime() - from.getTime()) / 3600_000; t.hoursN++; }
  }
}

/** `of` is what pending counts against: assigned shops for a field user, started shops for staff. */
function summary(t: Tally, of: number) {
  return {
    started: t.started, submitted: t.submitted, underReview: t.underReview, approved: t.approved, rework: t.rework, completed: t.completed, pending: Math.max(0, of - t.completed),
    reworkCount: t.reworkShops, reworkPercent: t.submitted ? round1((t.reworkShops / t.submitted) * 100) : 0, avgCompletionHours: t.hoursN ? round1(t.hoursSum / t.hoursN) : null,
  };
}

/* ------------------------------------------------ field user ------------------------------------------------ */

/** The logged-in recce login's own shops only (the same shops `GET /recce/shops` lists). */
export async function fieldDashboard(actor: Actor) {
  const sites = await Site.find(await mineFilter(actor)).select('project').lean();
  const projects = new Map((await Project.find({ _id: { $in: [...new Set(sites.map((s) => String(s.project)))] }, deletedAt: null, status: { $nin: ['CANCELLED', 'LOSS'] } }).select('code name').lean()).map((p) => [String(p._id), p]));
  const mine = sites.filter((s) => projects.has(String(s.project)));
  const subs = (await RecceSubmission.find({ site: { $in: mine.map((s) => s._id) } }).select(SUB_FIELDS).lean()) as unknown as SubRow[];
  const ev = await evidence(subs);
  const total = tally();
  const per = new Map<string, { assigned: number; t: Tally }>();
  for (const s of mine) { const c = per.get(String(s.project)) ?? { assigned: 0, t: tally() }; c.assigned++; per.set(String(s.project), c); }
  for (const s of subs) { add(total, s, ev); add(per.get(String(s.project))!.t, s, ev); }
  const all = summary(total, mine.length);
  return {
    assignedProjects: per.size, assignedShops: mine.length, started: all.started, submitted: all.submitted, underReview: all.underReview, approved: all.approved, rework: all.rework, completed: all.completed, pending: all.pending,
    avgCompletionHours: all.avgCompletionHours, reworkCount: all.reworkCount, reworkPercent: all.reworkPercent,
    projects: [...per.entries()].map(([id, c]) => { const x = summary(c.t, c.assigned); return { projectId: id, projectCode: projects.get(id)!.code, projectName: projects.get(id)!.name, assigned: c.assigned, started: x.started, submitted: x.submitted, approved: x.approved, rework: x.rework, pending: x.pending }; }).sort((a, b) => a.projectCode.localeCompare(b.projectCode)),
  };
}

/* ------------------------------------------------ staff ------------------------------------------------ */

export const performanceQuery = z.object({ projectId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['to'] });

const canSeeCost = (role: string) => (ROLE_PERMISSIONS[role as Role] as readonly string[] | undefined)?.includes('recce-cost:review') ?? false;

/**
 * In-house against vendor performance, project-wise and vendor-wise. Visibility is the same as /progress: Operations and Client Servicing
 * see only their projects (another project = 404), Admin and Management all, everyone else 403. `from` / `to` select shops whose recce was
 * started in that range. Cost is added only for people who may review recce cost, and only from stored, verified values (see verifiedRecceCost).
 */
export async function performance(actor: Actor, q: z.infer<typeof performanceQuery>) {
  const allowed = await reviewProjectIds(actor); // 403 for vendors, in-house recce staff and every role without review rights
  if (q.projectId && allowed && !allowed.some((p) => String(p) === q.projectId)) throw AppError.notFound('Project not found');
  const filter: Record<string, unknown> = {};
  if (q.projectId) filter.project = oid(q.projectId);
  else if (allowed) filter.project = { $in: allowed };
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const rows = (await RecceSubmission.find(filter).select(SUB_FIELDS).lean()) as unknown as SubRow[];
  const projects = new Map((await Project.find({ _id: { $in: [...new Set(rows.map((s) => String(s.project)))] }, deletedAt: null }).select('code name').lean()).map((p) => [String(p._id), p]));
  const subs = rows.filter((s) => projects.has(String(s.project)));
  const ev = await evidence(subs);

  const all = tally(), inHouse = tally(), vendor = tally();
  const byProject = new Map<string, { inHouse: Tally; vendor: Tally; all: Tally }>();
  const byVendor = new Map<string, Tally>();
  for (const s of subs) {
    const isVendor = s.channel === 'VENDOR';
    const p = byProject.get(String(s.project)) ?? { inHouse: tally(), vendor: tally(), all: tally() };
    byProject.set(String(s.project), p);
    add(all, s, ev); add(p.all, s, ev);
    add(isVendor ? vendor : inHouse, s, ev); add(isVendor ? p.vendor : p.inHouse, s, ev);
    if (isVendor && s.vendor) { const v = byVendor.get(String(s.vendor)) ?? tally(); add(v, s, ev); byVendor.set(String(s.vendor), v); }
  }
  const vendorNames = new Map((await Vendor.find({ _id: { $in: [...byVendor.keys()] } }).select('name').lean()).map((v) => [String(v._id), v.name as string]));
  const sum = (t: Tally) => summary(t, t.started);

  let cost: Awaited<ReturnType<typeof verifiedRecceCost>> | undefined;
  if (canSeeCost(actor.role)) {
    cost = await verifiedRecceCost(q.projectId ? [oid(q.projectId)] : allowed, { from: q.from, to: q.to });
  }
  const costCodes = cost?.perProject.length ? new Map((await Project.find({ _id: { $in: cost.perProject.map((p) => p.projectId) } }).select('code name').lean()).map((p) => [String(p._id), p])) : new Map();
  return {
    filters: { projectId: q.projectId ?? null, from: q.from ?? null, to: q.to ?? null },
    totals: sum(all), inHouse: sum(inHouse), vendor: sum(vendor),
    projects: [...byProject.entries()].map(([id, p]) => ({ projectId: id, projectCode: projects.get(id)!.code, projectName: projects.get(id)!.name, total: sum(p.all), inHouse: sum(p.inHouse), vendor: sum(p.vendor) })).sort((a, b) => a.projectCode.localeCompare(b.projectCode)),
    vendors: [...byVendor.entries()].map(([id, t]) => ({ vendorId: id, name: vendorNames.get(id) ?? 'Vendor', ...sum(t) })).sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name)),
    ...(cost ? { cost: { ...cost, perProject: cost.perProject.map((p) => ({ ...p, projectCode: costCodes.get(p.projectId)?.code ?? null, projectName: costCodes.get(p.projectId)?.name ?? null })) } } : {}),
  };
}
