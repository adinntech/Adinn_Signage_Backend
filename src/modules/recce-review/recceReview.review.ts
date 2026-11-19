import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { postShopMessage, shopMessages } from '../connect/connect.service';
import { notify } from '../notifications/notification.service';
import { Client } from '../clients/client.model';
import { Project } from '../projects/project.model';
import { Vendor } from '../vendors/vendor.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';
import {
  assertCanSeeProject, assertProjectOpen, clientNameFor, CLOSED_PROJECT, EVENT_LABEL, getConfig, logEvent, MONITOR_ROLES, nameMap, oid, OPS_ROLES, presentPhoto, REVIEWABLE, reviewProjectIds, siteLabel, stageOf, stageRecipients, type Config, type MediaItem,
} from './recceReview.common';
import { OPEN_STAGE, announceSubmitted, reviewPath } from './recceReview.field';
import { CATEGORY_LABEL, PHOTO_CATEGORIES, REVIEW_STAGES, RECCE_STATUSES, ReccePhoto, RecceConfig, RecceReview, RecceRework, RecceSubmission, RecceVersion, STAGE_LABEL, type ReviewStage } from './recceReview.model';

/* ------------------------------------------------ validators ------------------------------------------------ */

export const idParam = z.object({ id: objectId });
export const inboxQuery = z.object({
  projectId: objectId.optional(), client: z.string().trim().max(100).optional(), district: z.string().trim().max(100).optional(), vendor: objectId.optional(), assignee: objectId.optional(),
  q: z.string().trim().max(100).optional(), mediaType: z.string().trim().max(80).optional(), status: z.enum(RECCE_STATUSES).optional(), view: z.enum(['pending', 'mine', 'all']).default('pending'),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), reviewer: objectId.optional(), dueBefore: z.coerce.date().optional(), overdue: z.enum(['true', 'false']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
});
const checklistBody = z.array(z.object({ key: z.string().max(40), passed: z.boolean() })).max(30).default([]);
export const decideBody = z.object({
  stage: z.enum(REVIEW_STAGES), decision: z.enum(['APPROVE', 'REJECT', 'REWORK', 'ADDITIONAL']), versionNo: z.coerce.number().int().min(1),
  comment: z.string().trim().max(2000).default(''), checklist: checklistBody,
  reason: z.string().trim().max(2000).optional(), // rejection reason or admin override reason
  items: z.array(z.object({ type: z.enum(['REPLACE_PHOTO', 'ADDITIONAL_PHOTO', 'FIX_MEASUREMENT', 'OTHER']), category: z.enum(PHOTO_CATEGORIES).optional(), mediaKey: z.string().max(20).optional(), photo: objectId.optional(), note: z.string().trim().max(500).optional() })).max(30).default([]),
});
export const reopenBody = z.object({ reason: z.string().trim().min(5, 'Give a reason').max(500) });
export const overrideBody = z.object({ action: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().min(5, 'Give a reason').max(500) });
export const reviewerBody = z.object({ stage: z.enum(REVIEW_STAGES), userId: objectId.nullable() });
export const activityQuery = z.object({ type: z.string().trim().max(40).optional(), person: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(300).default(100) });
export const configBody = z.object({
  stages: z.array(z.enum(REVIEW_STAGES)).min(1).max(2).refine((a) => new Set(a).size === a.length, 'Each stage once'), sequential: z.boolean(), allowRetryAfterReject: z.boolean(), slaHours: z.number().int().min(1).max(720),
  maxPhotos: z.number().int().min(1).max(100), requireGps: z.boolean(),
  checklist: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/i).max(40), label: z.string().trim().min(2).max(80), stage: z.enum(['ALL', ...REVIEW_STAGES]).default('ALL'), gps: z.boolean().optional() })).min(1).max(20),
  requiredPhotos: z.record(z.string().max(40), z.array(z.enum(PHOTO_CATEGORIES))).refine((r) => !!r.default, 'A default rule is needed'),
}).partial();

/* ------------------------------------------------ helpers ------------------------------------------------ */

const DAY = 86400_000;
async function loadSubmission(actor: Actor, id: string) {
  const sub = await RecceSubmission.findById(id);
  if (!sub) throw AppError.notFound('Submission not found');
  await assertCanSeeProject(actor, sub.project);
  return sub;
}
const reviewsOf = (versionId: Types.ObjectId) => RecceReview.find({ version: versionId }).lean();
const decisionMap = (rs: { stage: string; decision: string }[]) => Object.fromEntries(rs.map((r) => [r.stage, r.decision]));

/** Checks the person may decide this stage. Admin decides only through `override`. Operations is limited to their projects, Client Servicing to theirs. */
function assertStageRights(actor: Actor, stage: ReviewStage) {
  const mine = stageOf(actor.role);
  if (mine !== stage) throw AppError.forbidden(`Only ${STAGE_LABEL[stage]} can decide this review stage`);
}

async function afterDecision(actor: Actor, sub: InstanceType<typeof RecceSubmission>, info: { versionNo: number; stage: ReviewStage; decision: string; comment: string; title: string; tone: string; extra?: { label: string; value: string }[] }) {
  const site = await Site.findById(sub.site).select('shopName siteCode').lean();
  const p = await Project.findById(sub.project).select('code client clientDetails').lean();
  const who = (await User.findById(actor.id).select('name').lean())?.name ?? STAGE_LABEL[info.stage];
  const name = site ? siteLabel(site) : 'Shop';
  const clientName = p ? await clientNameFor(p) : null;
  const other = REVIEW_STAGES.filter((s) => s !== info.stage);
  const reviewerIds = (await Promise.all(other.map((s) => stageRecipients(s, sub.project, sub.reviewers?.[s] ?? null)))).flat();
  await notify({
    recipients: [sub.assignee, ...reviewerIds.filter(() => info.decision !== 'APPROVE')], kind: 'RECCE_REVIEWED', path: reviewPath(sub._id), actorId: actor.id, project: p ? { _id: sub.project, code: p.code, clientName: clientName ?? undefined } : undefined as never,
    title: info.title, body: `${name}: ${who} (${STAGE_LABEL[info.stage]}) — ${info.decision.toLowerCase().replace('_', ' ')}${info.comment ? `. ${info.comment.slice(0, 160)}` : ''}`,
    dedupe: (r) => `recce-review:${String(sub._id)}:${info.versionNo}:${info.stage}:${info.decision}:${r}`,
  });
  await postShopMessage(sub.project, sub.site, actor, { card: { title: 'Recce Review Update', tone: info.tone, path: reviewPath(sub._id), lines: [{ label: 'Shop', value: name }, { label: 'Decision', value: info.title }, { label: 'Reviewer', value: `${who} (${STAGE_LABEL[info.stage]})` }, ...(info.extra ?? []), { label: 'Comments', value: info.comment || '-' }] } });
}

/** Tells the next stage that it is its turn (sequential flow). */
async function notifyNextStage(actor: Actor, sub: InstanceType<typeof RecceSubmission>, stage: ReviewStage, versionNo: number) {
  const site = await Site.findById(sub.site).select('shopName siteCode').lean();
  const p = await Project.findById(sub.project).select('code client clientDetails').lean();
  if (!site || !p) return;
  const items = (sub.mediaItems as unknown as MediaItem[]).map((i) => i.name);
  const photos = await RecceVersion.findOne({ submission: sub._id, version: versionNo }).select('photos').lean();
  await announceSubmitted({ id: String(sub.assignee), role: 'VENDOR' }, { submissionId: sub._id, projectId: sub.project, siteId: sub.site, siteName: siteLabel(site), project: p, versionNo, photoCount: photos?.photos.length ?? 0, mediaNames: items, stage, resubmitted: versionNo > 1 }).catch(() => undefined);
  void actor;
}

/* ------------------------------------------------ inbox ------------------------------------------------ */

const PENDING_STATUSES = ['SUBMITTED', 'UNDER_REVIEW'];

/** Review Inbox rows. Operations sees their projects, Client Servicing theirs, Admin and Management all. */
export async function inbox(actor: Actor, q: z.infer<typeof inboxQuery>) {
  const projectIds = await reviewProjectIds(actor);
  const filter: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (projectIds) and.push({ project: { $in: projectIds } });
  if (q.projectId) and.push({ project: oid(q.projectId) });
  if (q.client) {
    const re = new RegExp(escapeRegex(q.client), 'i');
    // clients matched below
    const cs = await Client.find({ name: re }).select('_id').lean();
    const ps = await Project.find({ $or: [{ client: { $in: cs.map((c) => c._id) } }, { 'clientDetails.name': re }] }).select('_id').lean();
    and.push({ project: { $in: ps.map((p) => p._id) } });
  }
  if (q.district || q.q) {
    const sf: Record<string, unknown> = { deletedAt: null };
    if (q.district) sf.district = new RegExp(escapeRegex(q.district), 'i');
    if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); sf.$or = [{ shopName: re }, { siteCode: re }, { dealerName: re }, { location: re }]; }
    const siteMatch = { site: { $in: (await Site.find(sf).select('_id').limit(2000).lean()).map((s) => s._id) } };
    if (q.q && !q.district) {
      const re = new RegExp(escapeRegex(q.q), 'i');
      const ps = await Project.find({ $or: [{ code: re }, { name: re }] }).select('_id').limit(500).lean();
      and.push({ $or: [siteMatch, { project: { $in: ps.map((p) => p._id) } }] });
    } else and.push(siteMatch);
  }
  if (q.vendor) and.push({ vendor: oid(q.vendor) });
  if (q.assignee) and.push({ assignee: oid(q.assignee) });
  if (q.mediaType) and.push({ 'mediaItems.name': new RegExp(escapeRegex(q.mediaType), 'i') });
  if (q.reviewer) and.push({ $or: [{ 'reviewers.OPS': oid(q.reviewer) }, { 'reviewers.CS': oid(q.reviewer) }] });
  if (q.from || q.to) and.push({ submittedAt: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } });
  if (q.dueBefore) and.push({ dueAt: { $lte: q.dueBefore } });
  if (q.overdue === 'true') and.push({ dueAt: { $lt: new Date() }, status: { $in: PENDING_STATUSES } });
  if (q.priority) and.push({ priority: q.priority });
  if (q.status) and.push({ status: q.status });
  else if (q.view === 'pending') and.push({ status: { $in: PENDING_STATUSES } });
  else if (q.view === 'mine') { const st = stageOf(actor.role); and.push({ status: { $in: PENDING_STATUSES } }, st ? { pendingStage: st } : { pendingStage: { $ne: null } }); }
  else and.push({ currentVersion: { $gt: 0 } });
  if (and.length) filter.$and = and;

  const [rows, total] = await Promise.all([
    RecceSubmission.find(filter).sort({ dueAt: 1, submittedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    RecceSubmission.countDocuments(filter),
  ]);
  return { items: await presentRows(rows), meta: pageMeta(q.page, q.limit, total) };
}

type SubLean = any;
async function presentRows(rows: SubLean[]) {
  const [sites, projects, versions, reviews] = await Promise.all([
    Site.find({ _id: { $in: rows.map((r) => r.site) } }).select('shopName siteCode district').lean(),
    Project.find({ _id: { $in: rows.map((r) => r.project) } }).select('code name client clientDetails').lean(),
    RecceVersion.find({ submission: { $in: rows.map((r) => r._id) } }).select('submission version photos').lean(),
    RecceReview.find({ submission: { $in: rows.map((r) => r._id) } }).select('submission versionNo stage decision reviewer').lean(),
  ]);
  const names = await nameMap([...rows.map((r) => r.assignee), ...rows.flatMap((r) => [r.reviewers?.OPS, r.reviewers?.CS]), ...reviews.map((r) => r.reviewer)]);
  const siteBy = new Map(sites.map((s) => [String(s._id), s]));
  const projBy = new Map(projects.map((p) => [String(p._id), p]));
  const clients = new Map<string, string | null>();
  for (const p of projects) clients.set(String(p._id), await clientNameFor(p));
  const now = Date.now();
  return rows.map((r) => {
    const s = siteBy.get(String(r.site));
    const p = projBy.get(String(r.project));
    const v = versions.find((x) => String(x.submission) === String(r._id) && x.version === r.currentVersion);
    const rv = reviews.filter((x) => String(x.submission) === String(r._id) && x.versionNo === r.currentVersion);
    const pending = ['SUBMITTED', 'UNDER_REVIEW'].includes(r.status);
    const due = r.dueAt ? new Date(r.dueAt).getTime() : null;
    return {
      id: String(r._id), siteId: String(r.site), shopName: s?.shopName ?? null, siteCode: s?.siteCode ?? '', district: s?.district ?? null, projectId: String(r.project), projectCode: p?.code ?? '', projectName: p?.name ?? '', client: clients.get(String(r.project)) ?? null,
      assignee: names.get(String(r.assignee)) ?? null, channel: r.channel ?? null, submittedAt: r.submittedAt ?? null, photoCount: v?.photos.length ?? 0, mediaTypes: (r.mediaItems ?? []).map((i: MediaItem) => i.name),
      version: r.currentVersion, attempts: r.attempts, status: r.status, priority: r.priority,
      stages: rv.map((x) => ({ stage: x.stage, label: STAGE_LABEL[x.stage as ReviewStage], decision: x.decision, reviewer: x.reviewer ? (names.get(String(x.reviewer)) ?? null) : null })),
      pendingStage: pending ? (r.pendingStage ?? null) : null, pendingStageLabel: pending && r.pendingStage ? STAGE_LABEL[r.pendingStage as ReviewStage] : null,
      pendingReviewer: pending && r.pendingStage ? (names.get(String(r.reviewers?.[r.pendingStage as ReviewStage])) ?? STAGE_LABEL[r.pendingStage as ReviewStage]) : null,
      dueAt: r.dueAt ?? null, overdue: pending && due != null && due < now, pendingDays: pending && r.submittedAt ? Math.floor((now - new Date(r.submittedAt).getTime()) / DAY) : 0,
    };
  });
}

/* ------------------------------------------------ workspace ------------------------------------------------ */

/** Everything the full-screen review workspace needs for one shop: shop and project, every version with its photos, reviews, rework, checklist. */
export async function workspace(actor: Actor, id: string) {
  const sub = await loadSubmission(actor, id);
  const [site, project, cfg, versions, reviews, reworks] = await Promise.all([
    Site.findById(sub.site).lean(), Project.findById(sub.project).lean(), getConfig(),
    RecceVersion.find({ submission: sub._id }).sort({ version: 1 }).lean(), RecceReview.find({ submission: sub._id }).lean(), RecceRework.find({ submission: sub._id }).sort({ createdAt: 1 }).lean(),
  ]);
  if (!site || !project) throw AppError.notFound('Submission not found');
  // Reviewers never see another person's drafts, only what was submitted (including photos later superseded or removed, with history).
  const photos = await ReccePhoto.find({ submission: sub._id, state: { $ne: 'DRAFT' } }).sort({ order: 1, createdAt: 1 }).lean();
  const names = await nameMap([...photos.flatMap((p) => [p.uploadedBy, p.removedBy]), ...reviews.map((r) => r.reviewer), ...versions.map((v) => v.submittedBy), ...reworks.map((r) => r.requestedBy), sub.assignee, sub.reviewers?.OPS, sub.reviewers?.CS]);
  const mine = stageOf(actor.role);
  const cur = versions.at(-1);
  const curReviews = cur ? reviews.filter((r) => String(r.version) === String(cur._id)) : [];
  const open = cur && (REVIEWABLE as string[]).includes(sub.status) ? OPEN_STAGE(cur.stages as ReviewStage[], cur.sequential, decisionMap(curReviews)) : null;
  const dec = (r: (typeof reviews)[number]) => ({ stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], decision: r.decision, reviewer: r.reviewer ? (names.get(String(r.reviewer)) ?? null) : null, decidedAt: r.decidedAt ?? null, comment: r.comment, checklist: r.checklist, override: r.override?.reason ? { reason: r.override.reason, by: names.get(String(r.override.by)) ?? null } : null });
  return {
    id: String(sub._id), status: sub.status, currentVersion: sub.currentVersion, attempts: sub.attempts, priority: sub.priority, submittedAt: sub.submittedAt ?? null, dueAt: sub.dueAt ?? null,
    overdue: (REVIEWABLE as string[]).includes(sub.status) && !!sub.dueAt && sub.dueAt.getTime() < Date.now(), pendingStage: (REVIEWABLE as string[]).includes(sub.status) ? (sub.pendingStage ?? null) : null,
    assignee: names.get(String(sub.assignee)) ?? null, channel: sub.channel ?? null, notes: sub.notes, mediaItems: sub.mediaItems,
    reviewers: { OPS: sub.reviewers?.OPS ? { id: String(sub.reviewers.OPS), name: names.get(String(sub.reviewers.OPS)) ?? '' } : null, CS: sub.reviewers?.CS ? { id: String(sub.reviewers.CS), name: names.get(String(sub.reviewers.CS)) ?? '' } : null },
    shop: { id: String(site._id), code: site.siteCode, name: site.shopName ?? null, dealer: site.dealerName ?? null, district: site.district ?? null, contactPerson: site.contactPerson ?? null, mobile: site.mobile ?? null, address: [site.address1, site.address2, site.address3, site.pincode].filter(Boolean).join(', '), lat: site.lat ?? null, lng: site.lng ?? null, boardType: site.boardType ?? null },
    project: { id: String(project._id), code: project.code, name: project.name, client: await clientNameFor(project), requirementType: project.requirementType ?? null, closed: CLOSED_PROJECT.includes(String(project.status)) },
    versions: versions.map((v) => ({
      id: String(v._id), version: v.version, submittedAt: v.submittedAt, submittedBy: names.get(String(v.submittedBy)) ?? null, photoIds: v.photos.map(String), addedIds: v.added.map(String), removedIds: v.removed.map(String), notes: v.notes, mediaItems: v.mediaItems, stages: v.stages, sequential: v.sequential, dueAt: v.dueAt ?? null,
      reviews: reviews.filter((r) => String(r.version) === String(v._id)).map(dec),
    })),
    photos: await Promise.all(photos.map((p) => presentPhoto(p as never, names, { withHistory: true }))),
    reworks: reworks.map((r) => ({ id: String(r._id), versionNo: r.versionNo, stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], kind: r.kind, status: r.status, instructions: r.instructions, requestedBy: names.get(String(r.requestedBy)) ?? null, requestedAt: r.createdAt, items: r.items.map((i) => ({ id: String(i._id), type: i.type, category: i.category ?? null, categoryLabel: i.category ? CATEGORY_LABEL[i.category as keyof typeof CATEGORY_LABEL] : null, mediaKey: i.mediaKey ?? '', photo: i.photo ? String(i.photo) : null, note: i.note ?? '', resolved: i.resolved, resolvedInVersion: i.resolvedInVersion ?? null })) })),
    checklist: cfg.checklist.filter((c) => c.stage === 'ALL' || c.stage === mine || actor.role === 'SUPER_ADMIN').map((c) => ({ key: c.key, label: c.label, stage: c.stage, gps: !!c.gps })),
    categories: PHOTO_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
    me: { stage: mine, canDecide: !!mine && open === mine && !CLOSED_PROJECT.includes(String(project.status)), openStage: open, isAdmin: actor.role === 'SUPER_ADMIN', canReopen: (sub.status === 'REJECTED' && (cfg.allowRetryAfterReject ? !!mine || actor.role === 'SUPER_ADMIN' : actor.role === 'SUPER_ADMIN')) || (sub.status === 'APPROVED' && actor.role === 'SUPER_ADMIN') },
    viewedAt: new Date(),
  };
}

export async function markReviewStarted(actor: Actor, id: string) {
  const sub = await loadSubmission(actor, id);
  const stage = stageOf(actor.role);
  if (!stage || !(REVIEWABLE as string[]).includes(sub.status) || sub.pendingStage !== stage) return { started: false };
  const moved = await RecceSubmission.updateOne({ _id: sub._id, status: 'SUBMITTED', pendingStage: stage }, { $set: { status: 'UNDER_REVIEW' }, $inc: { rev: 1 } });
  if (moved.modifiedCount) await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'REVIEW_STARTED', version: sub.currentVersion, visibility: 'REVIEW' });
  return { started: !!moved.modifiedCount };
}

/* ------------------------------------------------ decisions ------------------------------------------------ */

/**
 * One reviewer, one stage, one decision. The review row is claimed with a compare-and-set (decision must still be PENDING), so two
 * reviewers acting together cannot both win, and nobody can overwrite another stage's decision. Approval of the final stage is the
 * only way to APPROVED (apart from an Admin override with a reason).
 */
export async function decide(actor: Actor, id: string, input: z.infer<typeof decideBody>) {
  assertStageRights(actor, input.stage);
  const sub = await loadSubmission(actor, id);
  await assertProjectOpen(sub.project);
  if (!(REVIEWABLE as string[]).includes(sub.status)) throw AppError.conflict('This submission is not waiting for review');
  if (input.versionNo !== sub.currentVersion) throw AppError.conflict(`Version ${sub.currentVersion} is current now. Reload before deciding.`);
  const version = await RecceVersion.findOne({ submission: sub._id, version: sub.currentVersion });
  if (!version) throw AppError.notFound('Version not found');
  const stages = version.stages as ReviewStage[];
  if (!stages.includes(input.stage)) throw AppError.badRequest('This stage is not part of the review');
  const rs = await reviewsOf(version._id);
  if (OPEN_STAGE(stages, version.sequential, decisionMap(rs)) !== input.stage && !(!version.sequential && decisionMap(rs)[input.stage] === 'PENDING')) {
    throw AppError.conflict(decisionMap(rs)[input.stage] !== 'PENDING' ? `${STAGE_LABEL[input.stage]} has already decided this version` : 'An earlier review stage must approve first');
  }
  const cfg = await getConfig();
  if (input.decision === 'REJECT' && !(input.reason ?? input.comment)) throw AppError.badRequest('A rejection reason is required');
  if (input.decision === 'REWORK' && input.comment.length < 5) throw AppError.badRequest('Give clear rework instructions');
  if (input.decision === 'ADDITIONAL' && !input.items.some((i) => i.type === 'ADDITIONAL_PHOTO' && i.category)) throw AppError.badRequest('Choose the photo categories you need');
  const photoIds = [...new Set(input.items.map((i) => i.photo).filter(Boolean) as string[])];
  if (photoIds.length && (await ReccePhoto.countDocuments({ _id: { $in: photoIds }, submission: sub._id })) !== photoIds.length) throw AppError.badRequest('A selected photo does not belong to this shop');
  const labels = new Map(cfg.checklist.map((c) => [c.key, c.label]));
  const checklist = input.checklist.filter((c) => labels.has(c.key)).map((c) => ({ key: c.key, label: labels.get(c.key)!, passed: c.passed }));
  if (input.decision === 'APPROVE') {
    const mandatory = cfg.checklist.filter((c) => (c.stage === 'ALL' || c.stage === input.stage) && !(c.gps && !cfg.requireGps));
    const failed = mandatory.filter((c) => !checklist.find((x) => x.key === c.key)?.passed);
    if (failed.length) throw AppError.badRequest(`Tick every checklist item before approving: ${failed.map((f) => f.label).join(', ')}`);
  }

  const decision = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'REWORK';
  const comment = input.decision === 'REJECT' ? (input.reason ?? input.comment) : input.comment;
  const claimed = await RecceReview.findOneAndUpdate({ version: version._id, stage: input.stage, decision: 'PENDING' }, { $set: { decision, reviewer: actor.id, reviewerRole: actor.role, decidedAt: new Date(), comment, checklist } }, { new: true });
  if (!claimed) throw AppError.conflict('Another reviewer has already decided this stage');

  const all = await reviewsOf(version._id);
  const map = decisionMap(all);
  let status = 'UNDER_REVIEW';
  let pendingStage: ReviewStage | null = null;
  if (decision === 'REJECTED') status = 'REJECTED';
  else if (decision === 'REWORK') status = 'REWORK_REQUIRED';
  else if (stages.every((s) => map[s] === 'APPROVED')) status = 'APPROVED';
  else pendingStage = OPEN_STAGE(stages, version.sequential, map);
  const moved = await RecceSubmission.updateOne({ _id: sub._id, currentVersion: version.version, status: { $in: REVIEWABLE } }, { $set: { status, pendingStage, ...(status === 'APPROVED' ? { finalApprovedAt: new Date() } : {}) }, $inc: { rev: 1 } });
  if (!moved.modifiedCount) {
    await RecceReview.updateOne({ _id: claimed._id }, { $set: { decision: 'PENDING' }, $unset: { reviewer: 1, decidedAt: 1 } });
    throw AppError.conflict('The submission changed while you were deciding. Reload and try again.');
  }
  if (status === 'REJECTED' || status === 'REWORK_REQUIRED') await RecceReview.updateMany({ version: version._id, decision: 'PENDING' }, { $set: { decision: 'VOID' } });
  if (decision === 'REWORK') {
    await RecceRework.create({ project: sub.project, submission: sub._id, version: version._id, versionNo: version.version, stage: input.stage, kind: input.decision === 'ADDITIONAL' ? 'ADDITIONAL' : 'REWORK', instructions: comment, requestedBy: actor.id, items: input.items });
  }
  const type = input.decision === 'APPROVE' ? 'REVIEW_APPROVED' : input.decision === 'REJECT' ? 'REVIEW_REJECTED' : input.decision === 'ADDITIONAL' ? 'ADDITIONAL_PHOTOS_REQUESTED' : 'REWORK_REQUESTED';
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type, version: version.version, reason: comment || undefined, changes: [{ field: 'status', oldValue: sub.status, newValue: status }, { field: `review.${input.stage}`, oldValue: 'PENDING', newValue: decision }] });
  if (status === 'APPROVED') await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'FINAL_APPROVAL', version: version.version });
  const fresh = (await RecceSubmission.findById(sub._id))!;
  const titles: Record<string, string> = { APPROVE: status === 'APPROVED' ? 'Final approval' : `${STAGE_LABEL[input.stage]} approved`, REJECT: 'Rejected', REWORK: 'Rework required', ADDITIONAL: 'Additional photos requested' };
  await afterDecision(actor, fresh, { versionNo: version.version, stage: input.stage, decision: input.decision, comment, title: titles[input.decision]!, tone: decision === 'APPROVED' ? 'good' : decision === 'REJECTED' ? 'bad' : 'warn', extra: input.decision === 'ADDITIONAL' ? [{ label: 'Needed', value: input.items.filter((i) => i.category).map((i) => CATEGORY_LABEL[i.category!]).join(', ') }] : [] });
  if (status === 'UNDER_REVIEW' && pendingStage) await notifyNextStage(actor, fresh, pendingStage, version.version);
  return workspace(actor, id);
}

/** Admin only, with a reason, kept in the timeline (hidden from the field person). Decides every still-pending stage of the current version. */
export async function override(actor: Actor, id: string, input: z.infer<typeof overrideBody>) {
  if (actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only an Admin can override a review');
  const sub = await loadSubmission(actor, id);
  await assertProjectOpen(sub.project);
  if (!(REVIEWABLE as string[]).includes(sub.status)) throw AppError.conflict('This submission is not waiting for review');
  const version = await RecceVersion.findOne({ submission: sub._id, version: sub.currentVersion });
  if (!version) throw AppError.notFound('Version not found');
  const decision = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await RecceReview.updateMany({ version: version._id, decision: 'PENDING' }, { $set: { decision, reviewer: actor.id, reviewerRole: actor.role, decidedAt: new Date(), comment: input.reason, override: { by: actor.id, reason: input.reason } } });
  const status = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const moved = await RecceSubmission.updateOne({ _id: sub._id, currentVersion: version.version, status: { $in: REVIEWABLE } }, { $set: { status, pendingStage: null, ...(status === 'APPROVED' ? { finalApprovedAt: new Date() } : {}) }, $inc: { rev: 1 } });
  if (!moved.modifiedCount) throw AppError.conflict('The submission changed. Reload and try again.');
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'ADMIN_OVERRIDE', version: version.version, reason: input.reason, visibility: 'REVIEW', changes: [{ field: 'status', oldValue: sub.status, newValue: status }] });
  await afterDecision(actor, (await RecceSubmission.findById(sub._id))!, { versionNo: version.version, stage: 'OPS', decision: input.action, comment: input.reason, title: `Admin override: ${status.toLowerCase()}`, tone: input.action === 'APPROVE' ? 'good' : 'bad' });
  return workspace(actor, id);
}

/** A formal reopen: the shop goes back to the recce person for a new attempt. Nothing is erased; earlier versions and approvals stay as they were. */
export async function reopen(actor: Actor, id: string, input: z.infer<typeof reopenBody>) {
  const sub = await loadSubmission(actor, id);
  const cfg = await getConfig();
  const admin = actor.role === 'SUPER_ADMIN';
  const allowed = admin || (sub.status === 'REJECTED' && cfg.allowRetryAfterReject && !!stageOf(actor.role));
  if (!allowed) throw AppError.forbidden(sub.status === 'REJECTED' ? 'A new attempt after rejection needs an Admin' : 'Only an Admin can reopen this');
  await assertProjectOpen(sub.project);
  if (!['REJECTED', 'APPROVED', 'SUBMITTED', 'UNDER_REVIEW'].includes(sub.status)) throw AppError.conflict('This shop is already open for the recce person');
  const moved = await RecceSubmission.updateOne({ _id: sub._id, rev: sub.rev }, { $set: { status: 'IN_PROGRESS', pendingStage: null }, $unset: { finalApprovedAt: 1 }, $inc: { rev: 1 } });
  if (!moved.modifiedCount) throw AppError.conflict('The submission changed. Reload and try again.');
  await RecceReview.updateMany({ submission: sub._id, decision: 'PENDING' }, { $set: { decision: 'VOID' } });
  await RecceRework.updateMany({ submission: sub._id, status: 'OPEN' }, { $set: { status: 'CLOSED' } });
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'REOPENED', reason: input.reason, version: sub.currentVersion, changes: [{ field: 'status', oldValue: sub.status, newValue: 'IN_PROGRESS' }] });
  const site = await Site.findById(sub.site).select('shopName siteCode').lean();
  const p = await Project.findById(sub.project).select('code client clientDetails').lean();
  await notify({ recipients: [sub.assignee], kind: 'RECCE_REVIEWED', path: undefined, actorId: actor.id, project: p ? { _id: sub.project, code: p.code } : undefined as never, title: 'Shop reopened', body: `${site ? siteLabel(site) : 'Shop'} was reopened for a new attempt: ${input.reason}`, dedupe: (r) => `recce-reopen:${String(sub._id)}:${sub.rev}:${r}` });
  return workspace(actor, id);
}

/** Admin: bring back a removed photo (not while the version is locked as approved). */
export async function restorePhoto(actor: Actor, id: string, photoId: string) {
  if (actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only an Admin can restore a removed photo');
  const sub = await loadSubmission(actor, id);
  if (!['IN_PROGRESS', 'REWORK_REQUIRED'].includes(sub.status)) throw AppError.conflict('A photo can be restored only while the shop is open for the recce person');
  const r = await ReccePhoto.updateOne({ _id: photoId, submission: sub._id, state: 'REMOVED' }, { $set: { state: 'SUBMITTED' }, $unset: { removedAt: 1, removedBy: 1, removeReason: 1 } });
  if (!r.modifiedCount) throw AppError.notFound('Removed photo not found');
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'PHOTO_RESTORED', photo: oid(photoId), visibility: 'REVIEW' });
  return workspace(actor, id);
}

export async function assignReviewer(actor: Actor, id: string, input: z.infer<typeof reviewerBody>) {
  if (!OPS_ROLES.includes(actor.role) && actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only Recce Operations or Admin can assign reviewers');
  const sub = await loadSubmission(actor, id);
  if (input.userId) {
    const u = await User.findOne({ _id: input.userId, isActive: true, deletedAt: null }).select('role').lean();
    const ok = u && (input.stage === 'OPS' ? OPS_ROLES.includes(u.role) : u.role === 'CLIENT_SERVICING');
    if (!ok) throw AppError.badRequest(`Choose a ${STAGE_LABEL[input.stage]} user`);
  }
  const before = sub.reviewers?.[input.stage]?.toString() ?? null;
  await RecceSubmission.updateOne({ _id: sub._id }, input.userId ? { $set: { [`reviewers.${input.stage}`]: input.userId } } : { $unset: { [`reviewers.${input.stage}`]: 1 } });
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'REVIEWER_ASSIGNED', visibility: 'REVIEW', changes: [{ field: `reviewer.${input.stage}`, oldValue: before, newValue: input.userId }] });
  return workspace(actor, id);
}

export async function reviewerChoices(actor: Actor) {
  if (!stageOf(actor.role) && actor.role !== 'SUPER_ADMIN' && actor.role !== 'MANAGEMENT') throw AppError.forbidden();
  const users = await User.find({ role: { $in: [...OPS_ROLES, 'CLIENT_SERVICING'] as never }, isActive: true, deletedAt: null }).select('name role').sort({ name: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, stage: OPS_ROLES.includes(u.role) ? 'OPS' : 'CS' }));
}

/* ------------------------------------------------ timeline ------------------------------------------------ */

/** The activity of one shop. The field person sees ALL events only; reviewers also REVIEW; Admin everything. */
export async function timeline(actor: Actor, submissionId: string, q: z.infer<typeof activityQuery>, field = false) {
  const filter: Record<string, unknown> = { entity: 'RecceSubmission', entityId: oid(submissionId) };
  const allowed = field ? ['ALL'] : actor.role === 'SUPER_ADMIN' || actor.role === 'MANAGEMENT' ? ['ALL', 'REVIEW', 'ADMIN'] : ['ALL', 'REVIEW'];
  filter['meta.visibility'] = { $in: allowed };
  if (q.type) filter.action = q.type;
  if (q.person) filter.user = oid(q.person);
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(q.limit).populate('user', 'name').lean();
  return rows.map((l) => ({
    id: String(l._id), type: l.action, label: EVENT_LABEL[l.action] ?? l.action, actor: (l.user as unknown as { name?: string } | null)?.name ?? 'Unknown', role: l.role ?? '', at: l.at, reason: l.reason ?? '',
    mediaKey: (l.meta as { mediaKey?: string } | null)?.mediaKey ?? null, photo: (l.meta as { photo?: unknown } | null)?.photo ? String((l.meta as { photo: unknown }).photo) : null, version: (l.meta as { version?: number } | null)?.version ?? null, changes: l.changes,
  }));
}
export async function reviewTimeline(actor: Actor, id: string, q: z.infer<typeof activityQuery>) {
  await loadSubmission(actor, id);
  return timeline(actor, id, q);
}
export async function reviewThread(actor: Actor, id: string) {
  const sub = await loadSubmission(actor, id);
  return shopMessages(sub.project, sub.site, actor.id);
}
export async function reviewSendMessage(actor: Actor, id: string, body: string) {
  const sub = await loadSubmission(actor, id);
  await assertProjectOpen(sub.project);
  const out = await postShopMessage(sub.project, sub.site, actor, { body });
  if (!out) throw AppError.conflict('The message could not be sent. Try again.');
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'COMMENT_ADDED', reason: body.slice(0, 200), visibility: 'ALL' });
  return out;
}

/* ------------------------------------------------ progress & monitoring ------------------------------------------------ */

export const progressQuery = z.object({ projectId: objectId.optional() });

/** Counts derived from the real submission, review and rework records. A revised shop is counted once (by its current status). */
export async function progress(actor: Actor, q: z.infer<typeof progressQuery>) {
  const projectIds = await reviewProjectIds(actor);
  const siteFilter: Record<string, unknown> = { deletedAt: null, channel: { $in: ['VENDOR', 'IN_HOUSE'] } };

  if (q.projectId) siteFilter.project = oid(q.projectId);
  else if (projectIds) siteFilter.project = { $in: projectIds };
  else siteFilter.project = { $exists: true };
  if (q.projectId && projectIds && !projectIds.some((p) => String(p) === q.projectId)) throw AppError.notFound('Project not found');
  const sites = await Site.find(siteFilter).select('project').lean();
  const siteIds = sites.map((s) => s._id);
  const subs = await RecceSubmission.find({ site: { $in: siteIds } }).lean();
  const count = (st: string) => subs.filter((s) => s.status === st).length;
  const total = siteIds.length;
  const approved = count('APPROVED');
  const reviews = await RecceReview.find({ submission: { $in: subs.map((s) => s._id) }, decision: { $in: ['APPROVED', 'REJECTED', 'REWORK'] } }).select('submission versionNo decidedAt reviewer stage').lean();
  const versions = await RecceVersion.find({ submission: { $in: subs.map((s) => s._id) } }).select('submission version submittedAt').lean();
  const durations = reviews.map((r) => { const v = versions.find((x) => String(x.submission) === String(r.submission) && x.version === r.versionNo); return v && r.decidedAt ? (r.decidedAt.getTime() - v.submittedAt.getTime()) / 3600_000 : null; }).filter((x): x is number => x != null);
  const mediaDone = new Map<string, { total: number; approved: number }>();
  for (const s of subs) for (const i of s.mediaItems ?? []) { const k = i.name; const cur = mediaDone.get(k) ?? { total: 0, approved: 0 }; cur.total += i.quantity ?? 1; if (s.status === 'APPROVED') cur.approved += i.quantity ?? 1; mediaDone.set(k, cur); }
  const loadBy = new Map<string, { pending: number; decided: number }>();
  for (const s of subs.filter((x) => PENDING_STATUSES.includes(x.status) && x.pendingStage)) { const k = String(s.reviewers?.[s.pendingStage as ReviewStage] ?? s.pendingStage); const c = loadBy.get(k) ?? { pending: 0, decided: 0 }; c.pending++; loadBy.set(k, c); }
  for (const r of reviews) if (r.reviewer) { const k = String(r.reviewer); const c = loadBy.get(k) ?? { pending: 0, decided: 0 }; c.decided++; loadBy.set(k, c); }
  const names = await nameMap([...loadBy.keys()].filter((k) => Types.ObjectId.isValid(k)));
  const now = Date.now();
  return {
    totals: { assigned: total, notStarted: total - subs.length, inProgress: count('IN_PROGRESS'), submitted: count('SUBMITTED'), underReview: count('UNDER_REVIEW'), approved, reworkRequired: count('REWORK_REQUIRED'), rejected: count('REJECTED'), completed: approved },
    completionPercent: total ? Math.round((approved / total) * 100) : 0,
    pendingReview: count('SUBMITTED') + count('UNDER_REVIEW'), pendingRework: count('REWORK_REQUIRED'),
    overdueReviews: subs.filter((s) => PENDING_STATUSES.includes(s.status) && s.dueAt && s.dueAt.getTime() < now).length,
    avgReviewHours: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
    avgAttempts: subs.length ? Math.round((subs.reduce((a, s) => a + s.attempts, 0) / subs.length) * 10) / 10 : 0,
    mediaTypes: [...mediaDone.entries()].map(([name, v]) => ({ name, total: v.total, approved: v.approved, percent: v.total ? Math.round((v.approved / v.total) * 100) : 0 })),
    reviewerWorkload: [...loadBy.entries()].map(([k, v]) => ({ reviewer: names.get(k) ?? (REVIEW_STAGES.includes(k as ReviewStage) ? `${STAGE_LABEL[k as ReviewStage]} (unassigned)` : k), ...v })).sort((a, b) => b.pending - a.pending),
  };
}

/** Admin / Management dashboard: every active project's recce work, delays, rework backlog, deletions and team performance. */
export async function monitor(actor: Actor) {
  if (!MONITOR_ROLES.includes(actor.role)) throw AppError.forbidden();
  const subs = await RecceSubmission.find({}).lean();
  const now = Date.now();
  const waiting = subs.filter((s) => PENDING_STATUSES.includes(s.status));
  const overdue = waiting.filter((s) => s.dueAt && s.dueAt.getTime() < now);
  const reworkOpen = await RecceRework.find({ status: 'OPEN' }).lean();
  const decided = await RecceReview.find({ decision: { $in: ['APPROVED', 'REJECTED', 'REWORK'] } }).select('submission versionNo decidedAt reviewer stage decision').lean();
  const versions = await RecceVersion.find({}).select('submission version submittedAt dueAt').lean();
  const vBy = new Map(versions.map((v) => [`${v.submission}:${v.version}`, v]));
  let inSla = 0;
  for (const r of decided) { const v = vBy.get(`${r.submission}:${r.versionNo}`); if (v?.dueAt && r.decidedAt && r.decidedAt <= v.dueAt) inSla++; }
  const byGroup = (key: (s: (typeof subs)[number]) => string) => {
    const m = new Map<string, { total: number; approved: number; rework: number; pending: number; attempts: number }>();
    for (const s of subs) { const k = key(s); const c = m.get(k) ?? { total: 0, approved: 0, rework: 0, pending: 0, attempts: 0 }; c.total++; c.attempts += s.attempts; if (s.status === 'APPROVED') c.approved++; if (s.status === 'REWORK_REQUIRED') c.rework++; if (PENDING_STATUSES.includes(s.status)) c.pending++; m.set(k, c); }
    return m;
  };
  const vendors = byGroup((s) => (s.channel === 'VENDOR' ? String(s.vendor) : 'IN_HOUSE'));

  const vNames = new Map((await Vendor.find({ _id: { $in: [...vendors.keys()].filter((k) => Types.ObjectId.isValid(k)) } }).select('name').lean()).map((v) => [String(v._id), v.name as string]));
  const perf = (m: Map<string, { total: number; approved: number; rework: number; pending: number; attempts: number }>) => [...m.entries()].map(([k, v]) => ({ name: k === 'IN_HOUSE' ? 'In-house recce' : (vNames.get(k) ?? 'Vendor'), group: k === 'IN_HOUSE' ? 'IN_HOUSE' : 'VENDOR', ...v, completionPercent: v.total ? Math.round((v.approved / v.total) * 100) : 0, avgAttempts: v.total ? Math.round((v.attempts / v.total) * 10) / 10 : 0 }));
  const removals = await AuditLog.find({ entity: 'RecceSubmission', action: { $in: ['PHOTO_DELETED', 'PHOTO_REMOVED', 'PHOTO_RESTORED'] } }).sort({ at: -1 }).limit(30).populate('user', 'name').lean();
  const approvals = await AuditLog.find({ entity: 'RecceSubmission', action: { $in: ['FINAL_APPROVAL', 'REVIEW_APPROVED', 'REVIEW_REJECTED', 'ADMIN_OVERRIDE'] } }).sort({ at: -1 }).limit(30).populate('user', 'name').lean();
  const projects = await Project.find({ _id: { $in: [...new Set(subs.map((s) => String(s.project)))] }, status: { $nin: CLOSED_PROJECT as never }, deletedAt: null }).select('code name').lean();
  const rowsOverdue = await presentRows(overdue.sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0)).slice(0, 25) as SubLean[]);
  const rowsWaiting = await presentRows(waiting.sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0)).slice(0, 25) as SubLean[]);
  const names = new Map<string, string>();
  const ev = (l: (typeof removals)[number]) => ({ id: String(l._id), type: l.action, label: EVENT_LABEL[l.action] ?? l.action, actor: (l.user as unknown as { name?: string } | null)?.name ?? names.get(String(l.user)) ?? 'Unknown', at: l.at, reason: l.reason ?? '', submissionId: String(l.entityId) });
  return {
    activeProjects: projects.length, projects: projects.map((p) => ({ id: String(p._id), code: p.code, name: p.name })),
    totals: { shops: subs.length, awaitingReview: waiting.length, overdue: overdue.length, reworkBacklog: subs.filter((s) => s.status === 'REWORK_REQUIRED').length, pendingAdditionalPhotos: reworkOpen.filter((r) => r.kind === 'ADDITIONAL').length, approved: subs.filter((s) => s.status === 'APPROVED').length },
    slaPercent: decided.length ? Math.round((inSla / decided.length) * 100) : null, avgDecisionHours: decided.length ? Math.round((decided.reduce((a, r) => { const v = vBy.get(`${r.submission}:${r.versionNo}`); return a + (v && r.decidedAt ? (r.decidedAt.getTime() - v.submittedAt.getTime()) / 3600_000 : 0); }, 0) / decided.length) * 10) / 10 : null,
    overdue: rowsOverdue, awaiting: rowsWaiting, vendorCompletion: perf(new Map([...vendors].filter(([k]) => k !== 'IN_HOUSE'))), inHouseCompletion: perf(new Map([...vendors].filter(([k]) => k === 'IN_HOUSE'))),
    reviewPerformance: [...decided.reduce((m, r) => { const k = String(r.reviewer ?? ''); const c = m.get(k) ?? { approved: 0, rework: 0, rejected: 0 }; if (r.decision === 'APPROVED') c.approved++; else if (r.decision === 'REWORK') c.rework++; else c.rejected++; m.set(k, c); return m; }, new Map<string, { approved: number; rework: number; rejected: number }>())].map(([k, v]) => ({ reviewerId: k, ...v })),
    approvalHistory: approvals.map(ev), deletedPhotoActivity: removals.map(ev),
  };
}

export async function monitorWithNames(actor: Actor) {
  const m = await monitor(actor);
  const names = await nameMap(m.reviewPerformance.map((r) => r.reviewerId).filter((x) => Types.ObjectId.isValid(x)));
  return { ...m, reviewPerformance: m.reviewPerformance.map((r) => ({ ...r, reviewer: names.get(r.reviewerId) ?? 'Unknown' })) };
}

/* ------------------------------------------------ configuration ------------------------------------------------ */

export async function readConfig() {
  return getConfig();
}
export async function saveConfig(actor: Actor, input: z.infer<typeof configBody>) {
  if (actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only an Admin can change the review configuration');
  const before = await getConfig();
  const cfg = await RecceConfig.findOneAndUpdate({ key: 'default' }, { $set: input }, { upsert: true, returnDocument: 'after' });
  await AuditLog.create({ user: actor.id, role: actor.role, action: 'UPDATE', entity: 'RecceConfig', entityId: cfg._id, changes: Object.keys(input).map((k) => ({ field: k, oldValue: (before as Record<string, unknown>)[k], newValue: (input as Record<string, unknown>)[k] })) });
  return cfg.toObject() as Config;
}
