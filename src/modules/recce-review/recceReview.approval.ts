import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { Client } from '../clients/client.model';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import { Vendor } from '../vendors/vendor.model';
import { assertCanSeeProject, assertProjectOpen, clientNameFor, EVENT_LABEL, logEvent, nameMap, oid, presentPhoto, REVIEWABLE, reviewProjectFilter, stageOf } from './recceReview.common';
import { ITEM_KINDS, RecceSubmission, REVIEW_STAGES, STAGE_LABEL, type ReviewStage } from './recceReview.model';
import { workspace } from './recceReview.review';
import { hasUnits } from './recceReview.units';

/**
 * Project Approval (Client Servicing and Recce Operations): project-wise and shop-wise views over the SAME recce submissions and
 * the SAME two-stage review (recceReview.review). Nothing here decides a stage; the only write is a photo / measurement decision
 * of the reviewer's own stage on the current version (itemReviews), which the stage decision then turns into rework items.
 */

/* ------------------------------------------------ validators ------------------------------------------------ */

export const projectParam = z.object({ projectId: objectId });
export const siteParam = z.object({ siteId: objectId });
export const projectsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'pending', 'rejected', 'completed', 'in_progress']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export const SHOP_TABS = ['all', 'vendor', 'inhouse', 'submitted', 'approved', 'rejected', 'pending'] as const;
export const shopsQuery = z.object({
  tab: z.enum(SHOP_TABS).default('all'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export const itemBody = z.object({
  versionNo: z.coerce.number().int().min(1),
  kind: z.enum(ITEM_KINDS),
  ref: z.string().trim().min(1).max(40),
  decision: z.enum(['APPROVE', 'REJECT', 'CLEAR']),
  reason: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------ helpers ------------------------------------------------ */

const DAY = 86400_000;
const PENDING = ['SUBMITTED', 'UNDER_REVIEW'];
const REJECTED = ['REJECTED', 'REWORK_REQUIRED'];
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;

export async function visibleProject(actor: Actor, projectId: string) {
  const pf = await reviewProjectFilter(actor);
  if (!pf) throw AppError.forbidden();
  const p = await Project.findOne({ $and: [{ _id: oid(projectId) }, pf] }).select('code name client clientDetails status requirementType startDate district createdAt').lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}

/** The decision of one stage on the shop's current version (null when nothing is submitted). */
export function stageDecision(sub: Row | undefined, stage: ReviewStage) {
  if (!sub || !sub.currentVersion) return null;
  const r = (sub.reviews ?? []).find((x: Row) => x.versionNo === sub.currentVersion && x.stage === stage);
  return r ? { decision: String(r.decision), reviewer: r.reviewer ? String(r.reviewer) : null, decidedAt: r.decidedAt ?? null } : null;
}

const counts = (sites: Row[], subs: Row[]) => {
  const st = (list: string[]) => subs.filter((s) => list.includes(s.status)).length;
  const vendor = sites.filter((s) => s.channel === 'VENDOR').length;
  const inhouse = sites.filter((s) => s.channel === 'IN_HOUSE').length;
  const approved = st(['APPROVED']);
  return {
    total: sites.length, vendor, inhouse, allocated: vendor + inhouse,
    submitted: subs.filter((s) => s.currentVersion > 0).length, pending: st(PENDING), approved, rejected: st(REJECTED),
    inProgress: subs.filter((s) => s.status === 'IN_PROGRESS').length,
    progress: sites.length ? Math.round((approved / sites.length) * 100) : 0,
  };
};

/** India date (YYYY-MM-DD) of a moment. */
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/* ------------------------------------------------ project list ------------------------------------------------ */

/** Projects the person may review (same rules as Recce Review), with shop allocation and approval counts. */
export async function approvalProjects(actor: Actor, q: z.infer<typeof projectsQuery>) {
  const pf = await reviewProjectFilter(actor);
  if (!pf) throw AppError.forbidden();
  const and: Record<string, unknown>[] = [pf];
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const clients = await Client.find({ name: re }).select('_id').limit(200).lean();
    and.push({ $or: [{ code: re }, { name: re }, { 'clientDetails.name': re }, { client: { $in: clients.map((c) => c._id) } }] });
  }
  const projects = await Project.find({ $and: and }).select('code name client clientDetails status updatedAt').sort({ updatedAt: -1 }).limit(500).lean();
  const ids = projects.map((p) => p._id);
  const [sites, subs] = await Promise.all([
    Site.find({ project: { $in: ids }, deletedAt: null }).select('project channel').lean(),
    RecceSubmission.find({ project: { $in: ids } }).select('project status currentVersion').lean(),
  ]);
  const group = <T extends { project: Types.ObjectId }>(list: T[]) => list.reduce((m, x) => m.set(String(x.project), [...(m.get(String(x.project)) ?? []), x]), new Map<string, T[]>());
  const sitesBy = group(sites as Row[]);
  const subsBy = group(subs as Row[]);
  let rows = projects
    .map((p) => ({ p, c: counts(sitesBy.get(String(p._id)) ?? [], subsBy.get(String(p._id)) ?? []) }))
    .filter((r) => r.c.total > 0);
  if (q.status === 'pending') rows = rows.filter((r) => r.c.pending > 0);
  if (q.status === 'rejected') rows = rows.filter((r) => r.c.rejected > 0);
  if (q.status === 'completed') rows = rows.filter((r) => r.c.approved === r.c.total);
  if (q.status === 'in_progress') rows = rows.filter((r) => r.c.approved < r.c.total);
  const page = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
  const items = await Promise.all(page.map(async ({ p, c }) => ({ id: String(p._id), code: p.code, name: p.name, client: await clientNameFor(p), status: p.status, ...c })));
  return { items, meta: pageMeta(q.page, q.limit, rows.length) };
}

/* ------------------------------------------------ project overview ------------------------------------------------ */

const SITE_FIELDS = 'shopName siteCode district location dealerName channel vendor assignedTo assignedToAt boardType quantity';
const SUB_FIELDS = 'site status currentVersion attempts submittedAt startedAt finalApprovedAt dueAt channel vendor assignee mediaItems.name mediaItems.quantity versions.version versions.submittedAt reviews reworks.versionNo reworks.stage';

/** Summary cards and analytics of one project, every number counted from the shops and their submissions. */
export async function approvalOverview(actor: Actor, projectId: string) {
  const project = await visibleProject(actor, projectId);
  const [sites, subs] = await Promise.all([
    Site.find({ project: project._id, deletedAt: null }).select(SITE_FIELDS).lean<Row[]>().exec(),
    RecceSubmission.find({ project: project._id }).select(SUB_FIELDS).lean<Row[]>().exec(),
  ]);
  const now = Date.now();
  const subBy = new Map(subs.map((s) => [String(s.site), s]));
  const siteBy = new Map(sites.map((s) => [String(s._id), s]));
  const c = counts(sites, subs);

  // Team allocation and per-team performance (vendor companies, in-house executives).
  const team = (['VENDOR', 'IN_HOUSE'] as const).map((ch) => {
    const list = sites.filter((s) => s.channel === ch);
    const ss = list.map((s) => subBy.get(String(s._id))).filter(Boolean) as Row[];
    return { channel: ch, allocated: list.length, submitted: ss.filter((s) => s.currentVersion > 0).length, approved: ss.filter((s) => s.status === 'APPROVED').length };
  }).filter((t) => t.allocated > 0);
  const perfMap = new Map<string, { key: string; group: 'VENDOR' | 'IN_HOUSE'; allocated: number; submitted: number; approved: number }>();
  for (const s of sites.filter((x) => x.channel)) {
    const key = s.channel === 'VENDOR' ? String(s.vendor ?? 'unknown') : String(s.assignedTo ?? 'unassigned');
    const row = perfMap.get(`${s.channel}:${key}`) ?? { key, group: s.channel, allocated: 0, submitted: 0, approved: 0 };
    const sub = subBy.get(String(s._id));
    row.allocated++;
    if (sub?.currentVersion > 0) row.submitted++;
    if (sub?.status === 'APPROVED') row.approved++;
    perfMap.set(`${s.channel}:${key}`, row);
  }
  const perfRows = [...perfMap.values()];
  const vendorIds = perfRows.filter((r) => r.group === 'VENDOR' && Types.ObjectId.isValid(r.key)).map((r) => r.key);
  const [vNames, uNames] = await Promise.all([
    Vendor.find({ _id: { $in: vendorIds } }).select('name').lean().then((v) => new Map(v.map((x) => [String(x._id), String(x.name)]))),
    nameMap(perfRows.filter((r) => r.group === 'IN_HOUSE' && Types.ObjectId.isValid(r.key)).map((r) => r.key)),
  ]);
  const performance = perfRows
    .map((r) => ({ name: r.group === 'VENDOR' ? (vNames.get(r.key) ?? 'Vendor') : (uNames.get(r.key) ?? 'In-house (unassigned)'), group: r.group, allocated: r.allocated, submitted: r.submitted, approved: r.approved, percent: r.allocated ? Math.round((r.approved / r.allocated) * 100) : 0 }))
    .sort((a, b) => b.allocated - a.allocated || b.percent - a.percent)
    .slice(0, 6);

  // Funnel and cumulative trend (India dates of first submit and final approval).
  const funnel = { assigned: c.allocated, visited: subs.filter((s) => s.startedAt || s.currentVersion > 0).length, submitted: c.submitted, approved: c.approved };
  const events = new Map<string, { submitted: number; approved: number }>();
  for (const s of subs) {
    const first = (s.versions ?? []).reduce((m: Row, v: Row) => (!m || v.version < m.version ? v : m), null);
    if (first?.submittedAt) { const k = istDay(new Date(first.submittedAt)); const e = events.get(k) ?? { submitted: 0, approved: 0 }; e.submitted++; events.set(k, e); }
    if (s.status === 'APPROVED' && s.finalApprovedAt) { const k = istDay(new Date(s.finalApprovedAt)); const e = events.get(k) ?? { submitted: 0, approved: 0 }; e.approved++; events.set(k, e); }
  }
  let sumS = 0;
  let sumA = 0;
  const trend = [...events.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, e]) => ({ date, submitted: (sumS += e.submitted), approved: (sumA += e.approved) })).slice(-30);

  // Approval queue: oldest waiting first, with the stages still to decide.
  const waiting = subs.filter((s) => PENDING.includes(s.status)).sort((a, b) => new Date(a.submittedAt ?? 0).getTime() - new Date(b.submittedAt ?? 0).getTime());
  // Then shops sent back for correction, waiting for the vendor / executive to resubmit.
  const sentBack = subs.filter((s) => s.status === 'REWORK_REQUIRED');
  const backAt = (s: Row) => {
    const r = (s.reviews ?? []).filter((x: Row) => x.versionNo === s.currentVersion && x.decidedAt && x.decision !== 'PENDING' && x.decision !== 'APPROVED');
    return r.length ? Math.max(...r.map((x: Row) => new Date(x.decidedAt).getTime())) : new Date(s.submittedAt ?? now).getTime();
  };
  const row = (s: Row, kind: 'REVIEW' | 'RESUBMIT', since: number) => {
    const site = siteBy.get(String(s.site));
    return {
      submissionId: String(s._id), siteId: String(s.site), shopName: site?.shopName || site?.siteCode || 'Shop', version: s.currentVersion, kind,
      waitingFor: kind === 'REVIEW' ? REVIEW_STAGES.filter((st) => stageDecision(s, st)?.decision === 'PENDING').map((st) => STAGE_LABEL[st]) : [s.channel === 'VENDOR' ? 'Vendor resubmission' : 'Inhouse resubmission'],
      ageDays: Math.max(0, Math.floor((now - since) / DAY)), overdue: kind === 'REVIEW' && !!s.dueAt && new Date(s.dueAt).getTime() < now,
    };
  };
  const queue = [
    ...waiting.map((s) => row(s, 'REVIEW', new Date(s.submittedAt ?? now).getTime())),
    ...sentBack.map((s) => ({ s, t: backAt(s) })).sort((x, y) => x.t - y.t).map(({ s, t }) => row(s, 'RESUBMIT', t)),
  ].slice(0, 8);
  const queueTotal = waiting.length + sentBack.length;
  const alerts = {
    overdue: waiting.filter((s) => s.dueAt && new Date(s.dueAt).getTime() < now).length,
    repeatedRejection: subs.filter((s) => (s.reworks ?? []).length >= 2 || (s.status === 'REJECTED' && (s.reworks ?? []).length >= 1)).length,
    pendingVisit: sites.filter((s) => s.channel && s.assignedToAt && now - new Date(s.assignedToAt).getTime() > 3 * DAY && !(subBy.get(String(s._id))?.currentVersion > 0)).length,
  };
  const stages = Object.fromEntries(REVIEW_STAGES.map((st) => {
    const ds = subs.map((s) => stageDecision(s, st)?.decision).filter(Boolean) as string[];
    return [st, { approved: ds.filter((d) => d === 'APPROVED').length, rejected: ds.filter((d) => d === 'REJECTED' || d === 'REWORK').length, pending: ds.filter((d) => d === 'PENDING').length }];
  }));

  const logs = subs.length
    ? await AuditLog.find({ entity: 'RecceSubmission', entityId: { $in: subs.map((s) => s._id) }, 'meta.visibility': { $in: ['ALL', 'REVIEW'] } }).sort({ at: -1 }).limit(8).populate('user', 'name').lean()
    : [];
  const subSite = new Map(subs.map((s) => [String(s._id), siteBy.get(String(s.site))]));
  const activity = logs.map((l) => {
    const site = subSite.get(String(l.entityId));
    return { id: String(l._id), type: l.action, label: EVENT_LABEL[l.action] ?? l.action, actor: (l.user as unknown as { name?: string } | null)?.name ?? 'Unknown', role: l.role ?? '', at: l.at, reason: l.reason ?? '', shopName: site?.shopName || site?.siteCode || null, submissionId: String(l.entityId), siteId: site ? String(site._id) : null };
  });

  return {
    project: { id: String(project._id), code: project.code, name: project.name, client: await clientNameFor(project), status: project.status },
    counts: { ...c, notStarted: sites.filter((s) => s.channel && !subBy.has(String(s._id))).length, unallocated: c.total - c.allocated },
    stages, team, performance, funnel, trend, queue, queueTotal, alerts, activity,
  };
}

/* ------------------------------------------------ shop list ------------------------------------------------ */

const VISIT: Record<string, string> = { IN_PROGRESS: 'IN_PROGRESS', SUBMITTED: 'SUBMITTED', UNDER_REVIEW: 'SUBMITTED', APPROVED: 'COMPLETED', REWORK_REQUIRED: 'REWORK', REJECTED: 'REJECTED' };

/** Every shop of the project with its allocation, current version and the two stages' decisions. */
export async function approvalShops(actor: Actor, projectId: string, q: z.infer<typeof shopsQuery>) {
  const project = await visibleProject(actor, projectId);
  const sf: Record<string, unknown> = { project: project._id, deletedAt: null };
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); sf.$or = [{ shopName: re }, { siteCode: re }, { location: re }, { district: re }, { dealerName: re }]; }
  const [sites, subs] = await Promise.all([
    Site.find(sf).select(SITE_FIELDS).sort({ seq: 1, _id: 1 }).lean<Row[]>().exec(),
    RecceSubmission.find({ project: project._id }).select(SUB_FIELDS).lean<Row[]>().exec(),
  ]);
  const subBy = new Map(subs.map((s) => [String(s.site), s]));
  const is = (s: Row, tab: (typeof SHOP_TABS)[number]) => {
    const sub = subBy.get(String(s._id));
    switch (tab) {
      case 'vendor': return s.channel === 'VENDOR';
      case 'inhouse': return s.channel === 'IN_HOUSE';
      case 'submitted': return sub?.currentVersion > 0;
      case 'approved': return sub?.status === 'APPROVED';
      case 'rejected': return REJECTED.includes(sub?.status);
      case 'pending': return PENDING.includes(sub?.status);
      default: return true;
    }
  };
  const tabs = Object.fromEntries(SHOP_TABS.map((t) => [t, sites.filter((s) => is(s, t)).length]));
  const list = sites.filter((s) => is(s, q.tab));
  const page = list.slice((q.page - 1) * q.limit, q.page * q.limit);

  // Names, and the current version's photos of this page only (GPS / time and a thumbnail).
  const pageSubs = page.map((s) => subBy.get(String(s._id))).filter(Boolean) as Row[];
  const [vNames, names, withPhotos] = await Promise.all([
    Vendor.find({ _id: { $in: page.map((s) => s.vendor).filter(Boolean) } }).select('name').lean().then((v) => new Map(v.map((x) => [String(x._id), String(x.name)]))),
    nameMap([...page.map((s) => s.assignedTo), ...pageSubs.flatMap((s) => (s.reviews ?? []).map((r: Row) => r.reviewer))]),
    pageSubs.length ? RecceSubmission.find({ _id: { $in: pageSubs.map((s) => s._id) } }).select('currentVersion versions.version versions.photos photos').lean<Row[]>().exec() : Promise.resolve([] as Row[]),
  ]);
  const photoBy = new Map<string, Row>();
  for (const s of withPhotos) {
    const ids = new Set(((s.versions ?? []).find((v: Row) => v.version === s.currentVersion)?.photos ?? []).map(String));
    const cur = (s.photos ?? []).filter((p: Row) => ids.has(String(p._id)));
    const pick = cur.find((p: Row) => p.category === 'SHOP_FRONT') ?? cur[0];
    if (pick) photoBy.set(String(s._id), { pick, gps: cur.find((p: Row) => p.lat != null && p.lng != null) ?? null });
  }
  const items = await Promise.all(page.map(async (s) => {
    const sub = subBy.get(String(s._id));
    const ph = sub ? photoBy.get(String(sub._id)) : undefined;
    const thumb = ph?.pick ? await presentPhoto(ph.pick, new Map(), { withHistory: false }).then((p) => p.editedUrl ?? p.url).catch(() => null) : null;
    const boards = (sub?.mediaItems ?? []) as { name: string; quantity?: number }[];
    const stage = (st: ReviewStage) => { const d = stageDecision(sub, st); return d ? { decision: d.decision, reviewer: d.reviewer ? (names.get(d.reviewer) ?? null) : null, decidedAt: d.decidedAt } : null; };
    return {
      siteId: String(s._id), submissionId: sub ? String(sub._id) : null, shopName: s.shopName ?? null, siteCode: s.siteCode, location: [s.location, s.district].filter(Boolean).join(', ') || null,
      channel: s.channel ?? null, team: s.channel === 'VENDOR' ? (vNames.get(String(s.vendor)) ?? null) : s.channel === 'IN_HOUSE' ? (names.get(String(s.assignedTo)) ?? null) : null,
      boardTypes: boards.length ? [...new Set(boards.map((i) => i.name))] : s.boardType ? [s.boardType] : [],
      quantity: boards.length ? boards.reduce((a, i) => a + (i.quantity ?? 1), 0) : (s.quantity ?? null),
      visitStatus: sub ? (sub.currentVersion > 0 || sub.status !== 'IN_PROGRESS' ? VISIT[sub.status] : 'VISITED') : s.channel ? 'NOT_STARTED' : 'NOT_ALLOCATED',
      status: sub?.status ?? null, version: sub?.currentVersion ?? 0, cs: stage('CS'), ops: stage('OPS'),
      gps: ph?.gps ? { lat: ph.gps.lat, lng: ph.gps.lng, at: ph.gps.capturedAt ?? null } : null, submittedAt: sub?.submittedAt ?? null, thumb,
    };
  }));
  return { items, tabs, meta: pageMeta(q.page, q.limit, list.length) };
}

/** The shop's submission (for the shop detail page, which is addressed by project and shop). */
export async function approvalShopRef(actor: Actor, siteId: string) {
  const site = await Site.findOne({ _id: oid(siteId), deletedAt: null }).select('project shopName siteCode').lean();
  if (!site) throw AppError.notFound('Shop not found');
  await visibleProject(actor, String(site.project));
  const sub = await RecceSubmission.findOne({ site: site._id }).select('_id currentVersion status').lean();
  return { siteId: String(site._id), projectId: String(site.project), shopName: site.shopName ?? null, siteCode: site.siteCode, submissionId: sub ? String(sub._id) : null, currentVersion: sub?.currentVersion ?? 0, status: sub?.status ?? null };
}

/* ------------------------------------------------ photo / measurement decisions ------------------------------------------------ */

/**
 * Approve, reject (with a reason) or clear ONE photo or ONE board measurement of the current version, for the reviewer's own stage
 * only, while that stage has not decided the version. One row per (version, stage, item): updated in place, never duplicated.
 */
export async function decideItem(actor: Actor, id: string, input: z.infer<typeof itemBody>) {
  const stage = stageOf(actor.role);
  if (!stage) throw AppError.forbidden('Only Client Servicing or Recce Operations can review items');
  const sub = await RecceSubmission.findById(id);
  if (!sub) throw AppError.notFound('Submission not found');
  await assertCanSeeProject(actor, sub.project);
  if (hasUnits(sub)) throw AppError.conflict('This shop is reviewed unit by unit. Approve or reject each unit.');
  await assertProjectOpen(sub.project);
  if (!(REVIEWABLE as string[]).includes(sub.status)) throw AppError.conflict('This submission is not waiting for review');
  if (input.versionNo !== sub.currentVersion) throw AppError.conflict(`Version ${sub.currentVersion} is current now. Reload before deciding.`);
  const version = sub.versions.find((v) => v.version === sub.currentVersion);
  if (!version) throw AppError.notFound('Version not found');
  if (!(version.stages as string[]).includes(stage)) throw AppError.badRequest('Your stage is not part of this review');
  const own = sub.reviews.find((r) => r.versionNo === version.version && r.stage === stage);
  if (own && own.decision !== 'PENDING') throw AppError.conflict(`${STAGE_LABEL[stage]} has already decided version ${version.version}`);
  const ref = input.kind === 'PHOTO' ? input.ref.toLowerCase() : input.ref;
  const known = input.kind === 'PHOTO' ? version.photos.some((p) => String(p) === ref) : version.mediaItems.some((m) => m.key === ref || (m.units ?? []).some((u) => u.key === ref));
  if (!known) throw AppError.badRequest(input.kind === 'PHOTO' ? 'This photo is not part of the current version' : 'This board is not part of the current version');
  const reason = input.reason?.trim() ?? '';
  if (input.decision === 'REJECT' && reason.length < 3) throw AppError.badRequest('A rejection reason is required');

  const match = { versionNo: version.version, stage, kind: input.kind, ref };
  const before = (sub.itemReviews ?? []).find((i) => i.versionNo === match.versionNo && i.stage === stage && i.kind === input.kind && i.ref === ref);
  // The stage must still be undecided when the write lands.
  const guard = { _id: sub._id, currentVersion: version.version, status: { $in: REVIEWABLE }, reviews: { $elemMatch: { versionNo: version.version, stage, decision: 'PENDING' } } };
  let done = false;
  if (input.decision === 'CLEAR') {
    done = !!(await RecceSubmission.updateOne(guard, { $pull: { itemReviews: match } })).matchedCount;
  } else {
    const row = { decision: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason: input.decision === 'REJECT' ? reason : '', reviewer: oid(actor.id), reviewerRole: actor.role, decidedAt: new Date() };
    const set = Object.fromEntries(Object.entries(row).map(([k, v]) => [`itemReviews.$[i].${k}`, v]));
    const filters = [{ 'i.versionNo': match.versionNo, 'i.stage': stage, 'i.kind': input.kind, 'i.ref': ref }];
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const upd = await RecceSubmission.updateOne({ ...guard, itemReviews: { $elemMatch: match } }, { $set: set }, { arrayFilters: filters });
      if (upd.matchedCount) { done = true; break; }
      const push = await RecceSubmission.updateOne({ ...guard, itemReviews: { $not: { $elemMatch: match } } }, { $push: { itemReviews: { _id: new Types.ObjectId(), ...match, ...row } } });
      done = !!push.matchedCount;
    }
  }
  if (!done) throw AppError.conflict('The submission changed while you were reviewing. Reload and try again.');
  const type = input.decision === 'APPROVE' ? 'ITEM_APPROVED' : input.decision === 'REJECT' ? 'ITEM_REJECTED' : 'ITEM_CLEARED';
  await logEvent(actor, {
    submission: sub._id, project: sub.project, site: sub.site, type, version: version.version, reason: reason || undefined, visibility: 'REVIEW',
    ...(input.kind === 'PHOTO' ? { photo: oid(ref) } : { mediaKey: ref }),
    changes: [{ field: `${stage}.${input.kind.toLowerCase()}`, oldValue: before?.decision ?? 'PENDING', newValue: input.decision === 'CLEAR' ? 'PENDING' : input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' }],
  });
  return workspace(actor, id);
}
