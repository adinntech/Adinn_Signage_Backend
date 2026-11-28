import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { postShopMessage } from '../connect/connect.service';
import type { UploadedFile } from '../files/file.service';
import { notify } from '../notifications/notification.service';
import { Client } from '../clients/client.model';
import { Project } from '../projects/project.model';
import { Vendor } from '../vendors/vendor.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';
import {
  assertCanSeeProject, assertProjectOpen, clientNameFor, CLOSED_PROJECT, EVENT_LABEL, getConfig, link, logEvent, MONITOR_ROLES, flatItems, nameMap, oid, OPS_ROLES, presentInstallation, presentPhoto, REVIEWABLE, roleMap, reviewPath, reviewProjectIds, siteLabel, stageOf, stageRecipients, timeOf, type Config, type MediaItem,
} from './recceReview.common';
import { hasUnits, overrideUnits, presentShopUnits, reopenUnits } from './recceReview.units';
import { OPEN_STAGE, announceSubmitted } from './recceReview.field';
import { listThread, markThreadRead, parsePost, postThread, unreadCount, type ThreadCtx, type threadQuery } from './recceReview.thread';
import { byPhotoOrder, compareVersions, versionHistory, compareQuery } from './recceReview.versions';
import { CATEGORY_LABEL, PHOTO_CATEGORIES, REVIEW_STAGES, RECCE_STATUSES, RecceConfig, RecceSubmission, STAGE_LABEL, type ReviewStage } from './recceReview.model';

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
  rejectMode: z.enum(['PHOTO', 'MEASUREMENT', 'BOTH']).optional(), // Project Tracking: what was rejected
  items: z.array(z.object({ type: z.enum(['REPLACE_PHOTO', 'ADDITIONAL_PHOTO', 'FIX_MEASUREMENT', 'OTHER']), category: z.enum(PHOTO_CATEGORIES).optional(), mediaKey: z.string().max(40).optional(), photo: objectId.optional(), note: z.string().trim().max(500).optional() })).max(30).default([]),
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
/** The reviews of the shop's document that belong to one version. */
const reviewsOfVersion = <T extends { versionNo: number }>(reviews: T[], versionNo: number) => reviews.filter((r) => r.versionNo === versionNo);
/** The same, read again from the database (after a decision was written, to see what the other stage did meanwhile). */
const freshReviews = async (submissionId: Types.ObjectId, versionNo: number) => reviewsOfVersion((await RecceSubmission.findById(submissionId).select('reviews').lean())?.reviews ?? [], versionNo);
const decisionMap = (rs: { stage: string; decision?: string | null | undefined }[]) => Object.fromEntries(rs.map((r) => [r.stage, r.decision ?? 'PENDING']));
const DECIDED = ['APPROVED', 'REJECTED', 'REWORK'];
const byTime = (a: { createdAt?: Date | null }, b: { createdAt?: Date | null }) => timeOf(a.createdAt) - timeOf(b.createdAt);

/** Overall status of a version from the decision of every stage. Rejection beats rework, rework beats approval. */
function overallOutcome(stages: ReviewStage[], sequential: boolean, map: Record<string, string>): { status: string; pendingStage: ReviewStage | null } {
  const of = (d: string) => stages.some((s) => map[s] === d);
  if (of('REJECTED')) return { status: 'REJECTED', pendingStage: null };
  if (of('REWORK')) return { status: 'REWORK_REQUIRED', pendingStage: null };
  if (stages.every((s) => map[s] === 'APPROVED')) return { status: 'APPROVED', pendingStage: null };
  return { status: 'UNDER_REVIEW', pendingStage: OPEN_STAGE(stages, sequential, map) };
}

/** Checks the person may decide this stage. Admin decides only through `override`. Operations is limited to their projects, Client Servicing to theirs. */
function assertStageRights(actor: Actor, stage: ReviewStage) {
  const mine = stageOf(actor.role);
  if (mine !== stage) throw AppError.forbidden(`Only ${STAGE_LABEL[stage]} can decide this review stage`);
}

export async function afterDecision(actor: Actor, sub: InstanceType<typeof RecceSubmission>, info: { versionNo: number; stage: ReviewStage; decision: string; comment: string; title: string; tone: string; extra?: { label: string; value: string }[]; refs?: { type: string; id: string }[] }) {
  const site = await Site.findById(sub.site).select('shopName siteCode').lean();
  const p = await Project.findById(sub.project).select('code client clientDetails').lean();
  const who = (await User.findById(actor.id).select('name').lean())?.name ?? STAGE_LABEL[info.stage];
  const name = site ? siteLabel(site) : 'Shop';
  const clientName = p ? await clientNameFor(p) : null;
  const other = REVIEW_STAGES.filter((s) => s !== info.stage);
  const reviewerIds = (await Promise.all(other.map((s) => stageRecipients(s, sub.project, sub.reviewers?.[s] ?? null)))).flat();
  await notify({
    recipients: [sub.assignee, ...reviewerIds.filter(() => info.decision !== 'APPROVE')], kind: 'RECCE_REVIEWED', path: reviewPath(sub._id), site: sub.site, actorId: actor.id, project: p ? { _id: sub.project, code: p.code, clientName: clientName ?? undefined } : undefined as never,
    title: info.title, body: `${name}: ${who} (${STAGE_LABEL[info.stage]}) — ${info.decision.toLowerCase().replace('_', ' ')}${info.comment ? `. ${info.comment.slice(0, 160)}` : ''}`,
    dedupe: (r) => `recce-review:${String(sub._id)}:${info.versionNo}:${info.stage}:${info.decision}:${r}`,
  });
  await postShopMessage(sub.project, sub.site, actor, { eventKey: `review:${String(sub._id)}:${info.versionNo}:${info.stage}:${info.decision}:${info.title}`.slice(0, 160), refs: [{ type: 'VERSION', id: String(info.versionNo) }, ...(info.refs ?? [])], card: { title: 'Recce Review Update', tone: info.tone, path: reviewPath(sub._id), lines: [{ label: 'Shop', value: name }, { label: 'Decision', value: info.title }, { label: 'Reviewer', value: `${who} (${STAGE_LABEL[info.stage]})` }, ...(info.extra ?? []), { label: 'Comments', value: info.comment || '-' }] } });
}

/** Tells the next stage that it is its turn (sequential flow). */
async function notifyNextStage(actor: Actor, sub: InstanceType<typeof RecceSubmission>, stage: ReviewStage, versionNo: number) {
  const site = await Site.findById(sub.site).select('shopName siteCode').lean();
  const p = await Project.findById(sub.project).select('code client clientDetails').lean();
  if (!site || !p) return;
  const items = (sub.mediaItems as unknown as MediaItem[]).map((i) => i.name);
  const photos = sub.versions.find((v) => v.version === versionNo);
  await announceSubmitted({ id: String(sub.assignee), role: 'VENDOR' }, { submissionId: sub._id, projectId: sub.project, siteId: sub.site, siteName: siteLabel(site), project: p, versionNo, photoCount: photos?.photos.length ?? 0, mediaNames: items, stage, resubmitted: versionNo > 1, card: photos?.stages?.[0] === stage ? 'none' : 'turn' }).catch(() => undefined);
  void actor;
}

/**
 * Every required stage has approved: besides the recce person (told by afterDecision), the people of every stage hear that the shop is
 * complete. The person who made the last decision is never notified (notify skips the actor).
 */
export async function notifyFinalApproval(actor: Actor, sub: InstanceType<typeof RecceSubmission>, versionNo: number, stages: ReviewStage[]) {
  const [site, p] = await Promise.all([Site.findById(sub.site).select('shopName siteCode').lean(), Project.findById(sub.project).select('code client clientDetails').lean()]);
  const people = (await Promise.all(REVIEW_STAGES.map((s) => stageRecipients(s, sub.project, sub.reviewers?.[s] ?? null)))).flat().filter((id) => String(id) !== String(sub.assignee));
  const clientName = p ? await clientNameFor(p) : null;
  await notify({
    recipients: people, kind: 'RECCE_REVIEWED', path: reviewPath(sub._id), site: sub.site, actorId: actor.id, project: p ? { _id: sub.project, code: p.code, clientName: clientName ?? undefined } : undefined as never,
    title: 'Shop approved by all stages', body: `${site ? siteLabel(site) : 'Shop'}: version ${versionNo} is approved by ${stages.map((s) => STAGE_LABEL[s]).join(' and ')}.`,
    dedupe: (r) => `recce-final:${String(sub._id)}:${versionNo}:${r}`,
  });
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
  else if (q.view === 'mine') {
    const st = stageOf(actor.role);
    // Sequential review: the stage whose turn it is (pendingStage). Parallel review: every shop where this stage has not decided yet.
    type OpenRow = { _id: Types.ObjectId; currentVersion?: number | null; versions: { version: number; sequential?: boolean | null }[]; reviews: { versionNo: number; stage: string; decision?: string | null }[] };
    const waitingFilter: Record<string, unknown> = { status: { $in: PENDING_STATUSES }, reviews: { $elemMatch: { stage: st, decision: 'PENDING' } } };
    const open = st ? ((await RecceSubmission.find(waitingFilter).select('currentVersion versions.version versions.sequential reviews.versionNo reviews.stage reviews.decision').lean()) as unknown as OpenRow[]) : [];
    const parallelSubs = open.filter((s) => s.versions.some((v) => v.version === s.currentVersion && v.sequential === false) && s.reviews.some((r) => r.versionNo === s.currentVersion && r.stage === st && r.decision === 'PENDING')).map((s) => s._id);
    and.push({ status: { $in: PENDING_STATUSES } }, st ? { $or: [{ pendingStage: st }, { _id: { $in: parallelSubs } }] } : { pendingStage: { $ne: null } });
  }
  else and.push({ currentVersion: { $gt: 0 } });
  if (and.length) filter.$and = and;

  const [rows, total] = await Promise.all([
    RecceSubmission.find(filter).select('-photos').sort({ dueAt: 1, submittedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), // the list needs no photos
    RecceSubmission.countDocuments(filter),
  ]);
  return { items: await presentRows(rows), meta: pageMeta(q.page, q.limit, total) };
}

type SubLean = any;
async function presentRows(rows: SubLean[]) {
  // Each row is the shop's own document, so its versions and reviews are already here.
  const [sites, projects] = await Promise.all([
    Site.find({ _id: { $in: rows.map((r) => r.site) } }).select('shopName siteCode district').lean(),
    Project.find({ _id: { $in: rows.map((r) => r.project) } }).select('code name client clientDetails').lean(),
  ]);
  const names = await nameMap([...rows.map((r) => r.assignee), ...rows.flatMap((r) => [r.reviewers?.OPS, r.reviewers?.CS]), ...rows.flatMap((r) => (r.reviews ?? []).map((x: { reviewer?: Types.ObjectId }) => x.reviewer))]);
  const siteBy = new Map(sites.map((s) => [String(s._id), s]));
  const projBy = new Map(projects.map((p) => [String(p._id), p]));
  const clients = new Map<string, string | null>();
  for (const p of projects) clients.set(String(p._id), await clientNameFor(p));
  const now = Date.now();
  return rows.map((r) => {
    const s = siteBy.get(String(r.site));
    const p = projBy.get(String(r.project));
    const v = (r.versions ?? []).find((x: { version: number }) => x.version === r.currentVersion);
    const rv = (r.reviews ?? []).filter((x: { versionNo: number }) => x.versionNo === r.currentVersion);
    const pending = ['SUBMITTED', 'UNDER_REVIEW'].includes(r.status);
    const due = r.dueAt ? new Date(r.dueAt).getTime() : null;
    return {
      id: String(r._id), siteId: String(r.site), shopName: s?.shopName ?? null, siteCode: s?.siteCode ?? '', district: s?.district ?? null, projectId: String(r.project), projectCode: p?.code ?? '', projectName: p?.name ?? '', client: clients.get(String(r.project)) ?? null,
      assignee: names.get(String(r.assignee)) ?? null, channel: r.channel ?? null, submittedAt: r.submittedAt ?? null, photoCount: v?.photos.length ?? 0, mediaTypes: (r.mediaItems ?? []).map((i: MediaItem) => i.name),
      version: r.currentVersion, attempts: r.attempts, status: r.status, priority: r.priority,
      stages: rv.map((x: { stage: string; decision: string; reviewer?: Types.ObjectId }) => ({ stage: x.stage, label: STAGE_LABEL[x.stage as ReviewStage], decision: x.decision, reviewer: x.reviewer ? (names.get(String(x.reviewer)) ?? null) : null })),
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
  const [site, project, cfg] = await Promise.all([Site.findById(sub.site).lean(), Project.findById(sub.project).lean(), getConfig()]);
  if (!site || !project) throw AppError.notFound('Submission not found');
  // Versions, reviews, reworks and photos are all inside the shop's one document.
  const doc = sub.toObject();
  const versions = [...doc.versions].sort((a, b) => a.version - b.version);
  const reviews = doc.reviews;
  const reworks = [...doc.reworks].sort(byTime);
  // Reviewers never see another person's drafts, only what was submitted (including photos later superseded or removed, with history).
  const photos = doc.photos.filter((p) => p.state !== 'DRAFT').sort(byPhotoOrder);
  const itemReviews = doc.itemReviews ?? [];
  const names = await nameMap([...photos.flatMap((p) => [p.uploadedBy, p.removedBy]), ...reviews.map((r) => r.reviewer), ...versions.map((v) => v.submittedBy), ...reworks.map((r) => r.requestedBy), ...itemReviews.map((i) => i.reviewer), sub.assignee, sub.reviewers?.OPS, sub.reviewers?.CS]);
  const roles = await roleMap(photos.map((p) => p.uploadedBy));
  const mine = stageOf(actor.role);
  const cur = versions.at(-1);
  const curReviews = cur ? reviewsOfVersion(reviews, cur.version) : [];
  const open = cur && (REVIEWABLE as string[]).includes(sub.status) ? OPEN_STAGE(cur.stages as ReviewStage[], cur.sequential, decisionMap(curReviews)) : null;
  // Rejection voice notes (Project Tracking): a short-lived link per review that has one.
  const voice = new Map(await Promise.all(reviews.filter((r) => r.voiceNote?.key).map(async (r) => [String(r._id), (await link(r.voiceNote as never))?.url ?? null] as const)));
  const dec = (r: (typeof reviews)[number]) => ({ rejectMode: r.rejectMode ?? null, voiceNoteUrl: voice.get(String(r._id)) ?? null, stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], decision: r.decision, reviewer: r.reviewer ? (names.get(String(r.reviewer)) ?? null) : null, decidedAt: r.decidedAt ?? null, comment: r.comment, checklist: r.checklist, override: r.override?.reason ? { reason: r.override.reason, by: names.get(String(r.override.by)) ?? null } : null });
  return {
    id: String(sub._id), status: sub.status, currentVersion: sub.currentVersion, attempts: sub.attempts, priority: sub.priority, submittedAt: sub.submittedAt ?? null, dueAt: sub.dueAt ?? null,
    overdue: (REVIEWABLE as string[]).includes(sub.status) && !!sub.dueAt && sub.dueAt.getTime() < Date.now(), pendingStage: (REVIEWABLE as string[]).includes(sub.status) ? (sub.pendingStage ?? null) : null,
    assignee: names.get(String(sub.assignee)) ?? null, channel: sub.channel ?? null, notes: sub.notes, mediaItems: flatItems(sub.mediaItems), installation: presentInstallation(sub.installation as never),
    reviewers: { OPS: sub.reviewers?.OPS ? { id: String(sub.reviewers.OPS), name: names.get(String(sub.reviewers.OPS)) ?? '' } : null, CS: sub.reviewers?.CS ? { id: String(sub.reviewers.CS), name: names.get(String(sub.reviewers.CS)) ?? '' } : null },
    shop: { id: String(site._id), code: site.siteCode, name: site.shopName ?? null, dealer: site.dealerName ?? null, district: site.district ?? null, contactPerson: site.contactPerson ?? null, mobile: site.mobile ?? null, address: [site.address1, site.address2, site.address3, site.pincode].filter(Boolean).join(', '), lat: site.lat ?? null, lng: site.lng ?? null, boardType: site.boardType ?? null },
    project: { id: String(project._id), code: project.code, name: project.name, client: await clientNameFor(project), requirementType: project.requirementType ?? null, closed: CLOSED_PROJECT.includes(String(project.status)) },
    versions: versions.map((v) => ({
      id: String(v._id), version: v.version, submittedAt: v.submittedAt, submittedBy: names.get(String(v.submittedBy)) ?? null, photoIds: v.photos.map(String), addedIds: v.added.map(String), removedIds: v.removed.map(String), notes: v.notes, mediaItems: v.mediaItems, installation: presentInstallation(v.installation as never), installationRecorded: !!v.installation, stages: v.stages, sequential: v.sequential, dueAt: v.dueAt ?? null,
      reviews: reviewsOfVersion(reviews, v.version).map(dec),
    })),
    photos: await Promise.all(photos.map((p) => presentPhoto(p as never, names, { withHistory: true, roles }))),
    reworks: reworks.map((r) => ({ id: String(r._id), versionNo: r.versionNo, stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], kind: r.kind, status: r.status, instructions: r.instructions, requestedBy: names.get(String(r.requestedBy)) ?? null, requestedAt: r.createdAt, items: r.items.map((i) => ({ id: String(i._id), type: i.type, category: i.category ?? null, categoryLabel: i.category ? CATEGORY_LABEL[i.category as keyof typeof CATEGORY_LABEL] : null, mediaKey: i.mediaKey ?? '', photo: i.photo ? String(i.photo) : null, note: i.note ?? '', resolved: i.resolved, resolvedInVersion: i.resolvedInVersion ?? null })) })),
    // Project Approval: photo / measurement decisions of every stage and version (both stages see each other's).
    itemReviews: itemReviews.map((i) => ({ id: String(i._id), versionNo: i.versionNo, stage: i.stage, stageLabel: STAGE_LABEL[i.stage as ReviewStage], kind: i.kind, ref: i.ref, decision: i.decision, reason: i.reason ?? '', reviewer: names.get(String(i.reviewer)) ?? null, decidedAt: i.decidedAt ?? null })),
    checklist: cfg.checklist.filter((c) => c.stage === 'ALL' || c.stage === mine || actor.role === 'SUPER_ADMIN').map((c) => ({ key: c.key, label: c.label, stage: c.stage, gps: !!c.gps, required: !(c.gps && !cfg.requireGps) })),
    categories: PHOTO_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
    unitPhotoCategories: cfg.unitPhotoCategories ?? [],
    // Unit-wise review record: every board unit with its photos, measurement, answers, versions and OPS / CS decisions.
    boards: await presentShopUnits(doc),
    summary: doc.summary ?? null,
    unitQuestions: cfg.unitQuestions ?? [],
    me: { stage: mine, canDecide: !!mine && open === mine && !CLOSED_PROJECT.includes(String(project.status)), openStage: open, isAdmin: actor.role === 'SUPER_ADMIN', canReopen: (sub.status === 'REJECTED' && (cfg.allowRetryAfterReject ? !!mine || actor.role === 'SUPER_ADMIN' : actor.role === 'SUPER_ADMIN')) || (sub.status === 'APPROVED' && actor.role === 'SUPER_ADMIN') },
    viewedAt: new Date(),
  };
}

/** Immutable version snapshots and a compare of any two, for the reviewer (same data the field person sees). */
export async function reviewVersions(actor: Actor, id: string) {
  const sub = await loadSubmission(actor, id);
  return versionHistory(sub._id);
}
export async function reviewCompare(actor: Actor, id: string, q: z.infer<typeof compareQuery>) {
  const sub = await loadSubmission(actor, id);
  return compareVersions(sub._id, q.from, q.to);
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
  if (hasUnits(sub)) throw AppError.conflict('This shop is reviewed unit by unit. Approve or reject each unit.');
  await assertProjectOpen(sub.project);
  if (!(REVIEWABLE as string[]).includes(sub.status)) throw AppError.conflict('This submission is not waiting for review');
  if (input.versionNo !== sub.currentVersion) throw AppError.conflict(`Version ${sub.currentVersion} is current now. Reload before deciding.`);
  const version = sub.versions.find((v) => v.version === sub.currentVersion);
  if (!version) throw AppError.notFound('Version not found');
  const stages = version.stages as ReviewStage[];
  if (!stages.includes(input.stage)) throw AppError.badRequest('This stage is not part of the review');
  const rs = reviewsOfVersion(sub.reviews, version.version);  if (OPEN_STAGE(stages, version.sequential, decisionMap(rs)) !== input.stage && !(!version.sequential && decisionMap(rs)[input.stage] === 'PENDING')) {
    throw AppError.conflict(decisionMap(rs)[input.stage] !== 'PENDING' ? `${STAGE_LABEL[input.stage]} has already decided this version` : 'An earlier review stage must approve first');
  }
  const cfg = await getConfig();
  if (input.decision === 'REJECT' && !(input.reason ?? input.comment)) throw AppError.badRequest('A rejection reason is required');
  if (input.decision === 'REWORK' && input.comment.length < 5) throw AppError.badRequest('Give clear rework instructions');
  if (input.decision === 'ADDITIONAL' && !input.items.some((i) => i.type === 'ADDITIONAL_PHOTO' && i.category)) throw AppError.badRequest('Choose the photo categories you need');
  const photoIds = [...new Set(input.items.map((i) => i.photo).filter(Boolean) as string[])];
  if (photoIds.some((pid) => !sub.photos.some((p) => String(p._id) === String(pid).toLowerCase()))) throw AppError.badRequest('A selected photo does not belong to this shop');
  const labels = new Map(cfg.checklist.map((c) => [c.key, c.label]));
  const checklist = input.checklist.filter((c) => labels.has(c.key)).map((c) => ({ key: c.key, label: labels.get(c.key)!, passed: c.passed }));
  if (input.decision === 'APPROVE') {
    const mandatory = cfg.checklist.filter((c) => (c.stage === 'ALL' || c.stage === input.stage) && !(c.gps && !cfg.requireGps));
    const failed = mandatory.filter((c) => !checklist.find((x) => x.key === c.key)?.passed);
    if (failed.length) throw AppError.badRequest(`Tick every checklist item before approving: ${failed.map((f) => f.label).join(', ')}`);
    // Project Approval: this stage cannot approve a version while it still rejects a photo or a measurement of it.
    const rejectedItems = (sub.itemReviews ?? []).filter((i) => i.versionNo === version.version && i.stage === input.stage && i.decision === 'REJECTED').length;
    if (rejectedItems) throw AppError.conflict(`${rejectedItems} photo / measurement item${rejectedItems > 1 ? 's are' : ' is'} rejected by ${STAGE_LABEL[input.stage]}. Send the submission back for correction or clear the rejection before approving.`);
  }

  const decision = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'REWORK';
  const comment = input.decision === 'REJECT' ? (input.reason ?? input.comment) : input.comment;
  // Claim this stage's review entry with a compare-and-set on the shop's document: it must still be PENDING.
  const claimed = await RecceSubmission.updateOne(
    { _id: sub._id, reviews: { $elemMatch: { versionNo: version.version, stage: input.stage, decision: 'PENDING' } } },
    { $set: { 'reviews.$.decision': decision, 'reviews.$.reviewer': actor.id, 'reviews.$.reviewerRole': actor.role, 'reviews.$.decidedAt': new Date(), 'reviews.$.comment': comment, 'reviews.$.checklist': checklist, ...(decision !== 'APPROVED' && input.rejectMode ? { 'reviews.$.rejectMode': input.rejectMode } : {}) } },
  );
  if (!claimed.modifiedCount) throw AppError.conflict('Another reviewer has already decided this stage');

  // The overall status comes from every stage's decision, so two stages deciding at the same moment reach the same answer:
  // any rejection wins, then any rework, then "all approved", otherwise still under review.
  const { status, pendingStage } = overallOutcome(stages, version.sequential, decisionMap(await freshReviews(sub._id, version.version)));
  const moved = await RecceSubmission.updateOne({ _id: sub._id, currentVersion: version.version, status: { $in: REVIEWABLE } }, { $set: { status, pendingStage, ...(status === 'APPROVED' ? { finalApprovedAt: new Date() } : {}) }, $inc: { rev: 1 } });
  if (!moved.modifiedCount) {
    // The other stage decided at the same moment and already wrote the answer. If it is the answer this decision leads to as well, this decision stands.
    const [now, again] = await Promise.all([RecceSubmission.findById(sub._id).select('status currentVersion').lean(), freshReviews(sub._id, version.version)]);
    const agreed = now?.currentVersion === version.version && now.status === overallOutcome(stages, version.sequential, decisionMap(again)).status;
    if (!agreed) {
      // Give the claimed stage back (nothing else of this decision was written).
      await RecceSubmission.updateOne({ _id: sub._id }, { $set: { 'reviews.$[r].decision': 'PENDING' }, $unset: { 'reviews.$[r].reviewer': 1, 'reviews.$[r].decidedAt': 1 } }, { arrayFilters: [{ 'r.versionNo': version.version, 'r.stage': input.stage }] });
      throw AppError.conflict('The submission changed while you were deciding. Reload and try again.');
    }
  }
  const weMoved = !!moved.modifiedCount;
  if (status === 'REJECTED' || status === 'REWORK_REQUIRED') await RecceSubmission.updateOne({ _id: sub._id }, { $set: { 'reviews.$[r].decision': 'VOID' } }, { arrayFilters: [{ 'r.versionNo': version.version, 'r.decision': 'PENDING' }] });
  if (decision === 'REWORK') {
    await RecceSubmission.updateOne({ _id: sub._id }, {
      $push: { reworks: { _id: new Types.ObjectId(), versionNo: version.version, stage: input.stage, kind: input.decision === 'ADDITIONAL' ? 'ADDITIONAL' : 'REWORK', instructions: comment, requestedBy: actor.id, status: 'OPEN', createdAt: new Date(), items: input.items.map((i) => ({ _id: new Types.ObjectId(), ...i, resolved: false })) } },
    });
  }
  const type = input.decision === 'APPROVE' ? 'REVIEW_APPROVED' : input.decision === 'REJECT' ? 'REVIEW_REJECTED' : input.decision === 'ADDITIONAL' ? 'ADDITIONAL_PHOTOS_REQUESTED' : 'REWORK_REQUESTED';
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type, version: version.version, reason: comment || undefined, changes: [{ field: 'status', oldValue: sub.status, newValue: status }, { field: `review.${input.stage}`, oldValue: 'PENDING', newValue: decision }] });
  if (status === 'APPROVED' && weMoved) await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'FINAL_APPROVAL', version: version.version });
  const fresh = (await RecceSubmission.findById(sub._id))!;
  // What the reviewer pointed at, for the thread card: the photo's category (or the item's own) and a ref the app can open.
  const catOf = new Map(sub.photos.filter((p) => photoIds.some((pid) => String(pid).toLowerCase() === String(p._id))).map((p) => [String(p._id), p.category as keyof typeof CATEGORY_LABEL]));
  const pointed = input.items.map((i) => { const c = i.category ?? (i.photo ? catOf.get(i.photo) : undefined); return c ? `${CATEGORY_LABEL[c]}${i.note ? ` (${i.note})` : ''}` : null; }).filter((x): x is string => !!x);
  const cardRefs = [
    ...photoIds.map((id) => ({ type: 'PHOTO', id })),
    ...[...new Set(input.items.filter((i) => !i.photo && i.mediaKey && flatItems(sub.mediaItems).some((m) => m.key === i.mediaKey)).map((i) => i.mediaKey!))].map((id) => ({ type: 'BOARD', id })),
  ];
  const titles: Record<string, string> = { APPROVE: status === 'APPROVED' ? 'Final approval' : `${STAGE_LABEL[input.stage]} approved`, REJECT: 'Rejected', REWORK: 'Rework required', ADDITIONAL: 'Additional photos requested' };
  await afterDecision(actor, fresh, { versionNo: version.version, stage: input.stage, decision: input.decision, comment, title: titles[input.decision]!, tone: decision === 'APPROVED' ? 'good' : decision === 'REJECTED' ? 'bad' : 'warn', refs: cardRefs, extra: input.decision === 'ADDITIONAL' ? [{ label: 'Needed', value: input.items.filter((i) => i.category).map((i) => CATEGORY_LABEL[i.category!]).join(', ') }] : input.decision === 'REWORK' && pointed.length ? [{ label: 'Rework items', value: pointed.join(', ') }] : [] });
  if (status === 'APPROVED' && weMoved) await notifyFinalApproval(actor, fresh, version.version, stages);
  // Only sequential review hands over to the next stage; in parallel review that stage was told when the version was submitted.
  if (status === 'UNDER_REVIEW' && pendingStage && version.sequential) await notifyNextStage(actor, fresh, pendingStage, version.version);
  return workspace(actor, id);
}

/** Admin only, with a reason, kept in the timeline (hidden from the field person). Decides every still-pending stage of the current version. */
export async function override(actor: Actor, id: string, input: z.infer<typeof overrideBody>) {
  if (actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only an Admin can override a review');
  const sub = await loadSubmission(actor, id);
  await assertProjectOpen(sub.project);
  if (!(REVIEWABLE as string[]).includes(sub.status)) throw AppError.conflict('This submission is not waiting for review');
  const version = sub.versions.find((v) => v.version === sub.currentVersion);
  if (!version) throw AppError.notFound('Version not found');
  const decision = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const status = input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  // ONE atomic update: every still-pending stage of this version is decided and the status changes together, or nothing is written.
  const moved = await RecceSubmission.updateOne(
    { _id: sub._id, currentVersion: version.version, status: { $in: REVIEWABLE } },
    {
      $set: {
        status, pendingStage: null, ...(status === 'APPROVED' ? { finalApprovedAt: new Date() } : {}),
        'reviews.$[r].decision': decision, 'reviews.$[r].reviewer': actor.id, 'reviews.$[r].reviewerRole': actor.role, 'reviews.$[r].decidedAt': new Date(), 'reviews.$[r].comment': input.reason, 'reviews.$[r].override': { by: actor.id, reason: input.reason },
      },
      $inc: { rev: 1 },
    },
    { arrayFilters: [{ 'r.versionNo': version.version, 'r.decision': 'PENDING' }] },
  );
  if (!moved.modifiedCount) throw AppError.conflict('The submission changed. Reload and try again.');
  await overrideUnits(sub._id, actor, input.action, input.reason);
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'ADMIN_OVERRIDE', version: version.version, reason: input.reason, visibility: 'REVIEW', changes: [{ field: 'status', oldValue: sub.status, newValue: status }] });
  const after = (await RecceSubmission.findById(sub._id))!;
  await afterDecision(actor, after, { versionNo: version.version, stage: 'OPS', decision: input.action, comment: input.reason, title: `Admin override: ${status.toLowerCase()}`, tone: input.action === 'APPROVE' ? 'good' : 'bad' });
  if (status === 'APPROVED') await notifyFinalApproval(actor, after, version.version, version.stages as ReviewStage[]);
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
  // ONE atomic update: the status goes back to the recce person, waiting reviews are voided and open rework is closed together.
  const moved = await RecceSubmission.updateOne(
    { _id: sub._id, rev: sub.rev },
    { $set: { status: 'IN_PROGRESS', pendingStage: null, 'reviews.$[p].decision': 'VOID', 'reworks.$[o].status': 'CLOSED' }, $unset: { finalApprovedAt: 1 }, $inc: { rev: 1 } },
    { arrayFilters: [{ 'p.decision': 'PENDING' }, { 'o.status': 'OPEN' }] },
  );
  if (!moved.modifiedCount) throw AppError.conflict('The submission changed. Reload and try again.');
  await reopenUnits(sub._id, sub.status);
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'REOPENED', reason: input.reason, version: sub.currentVersion, changes: [{ field: 'status', oldValue: sub.status, newValue: 'IN_PROGRESS' }] });
  const site = await Site.findById(sub.site).select('shopName siteCode').lean();
  const p = await Project.findById(sub.project).select('code client clientDetails').lean();
  await notify({ recipients: [sub.assignee], kind: 'RECCE_REVIEWED', path: undefined, site: sub.site, actorId: actor.id, project: p ? { _id: sub.project, code: p.code } : undefined as never, title: 'Shop reopened', body: `${site ? siteLabel(site) : 'Shop'} was reopened for a new attempt: ${input.reason}`, dedupe: (r) => `recce-reopen:${String(sub._id)}:${sub.rev}:${r}` });
  await postShopMessage(sub.project, sub.site, actor, { eventKey: `reopen:${String(sub._id)}:${sub.rev}`, refs: sub.currentVersion ? [{ type: 'VERSION', id: String(sub.currentVersion) }] : [], card: { title: 'Shop Reopened', tone: 'warn', path: reviewPath(sub._id), lines: [{ label: 'Shop', value: site ? siteLabel(site) : 'Shop' }, { label: 'Reason', value: input.reason }, { label: 'Previous status', value: sub.status }] } });
  return workspace(actor, id);
}

/** Admin: bring back a removed photo (not while the version is locked as approved). */
export async function restorePhoto(actor: Actor, id: string, photoId: string) {
  if (actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only an Admin can restore a removed photo');
  const sub = await loadSubmission(actor, id);
  if (!['IN_PROGRESS', 'REWORK_REQUIRED'].includes(sub.status)) throw AppError.conflict('A photo can be restored only while the shop is open for the recce person');
  const r = await RecceSubmission.updateOne({ _id: sub._id, photos: { $elemMatch: { _id: oid(photoId), state: 'REMOVED' } } }, { $set: { 'photos.$.state': 'SUBMITTED' }, $unset: { 'photos.$.removedAt': 1, 'photos.$.removedBy': 1, 'photos.$.removeReason': 1 } });
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
/** The shop thread as a reviewer sees it (same messages the field person sees). Access follows the review rules of the project. */
async function threadCtx(actor: Actor, id: string): Promise<ThreadCtx> {
  const sub = await loadSubmission(actor, id);
  const site = await Site.findById(sub.site).lean();
  if (!site) throw AppError.notFound('Submission not found');
  return { site, sub, side: 'REVIEW' } as unknown as ThreadCtx;
}
export const reviewThread = async (actor: Actor, id: string, q: z.infer<typeof threadQuery>) => listThread(actor, await threadCtx(actor, id), q);
export const reviewSendMessage = async (actor: Actor, id: string, raw: Record<string, unknown> | undefined, file?: UploadedFile) => postThread(actor, await threadCtx(actor, id), parsePost(raw), file);
export const reviewUnread = async (actor: Actor, id: string) => unreadCount(actor, await threadCtx(actor, id));
export const reviewMarkRead = async (actor: Actor, id: string) => markThreadRead(actor, await threadCtx(actor, id));

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
  const subs = await RecceSubmission.find({ site: { $in: siteIds } }).select('-photos').lean(); // counts need no photos
  const count = (st: string) => subs.filter((s) => s.status === st).length;
  const total = siteIds.length;
  const approved = count('APPROVED');
  const reviews = subs.flatMap((s) => (s.reviews ?? []).filter((r) => DECIDED.includes(String(r.decision))).map((r) => ({ ...r, submittedAt: (s.versions ?? []).find((v) => v.version === r.versionNo)?.submittedAt })));
  const durations = reviews.map((r) => (r.submittedAt && r.decidedAt ? (r.decidedAt.getTime() - r.submittedAt.getTime()) / 3600_000 : null)).filter((x): x is number => x != null);
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
  const subs = await RecceSubmission.find({}).select('-photos').lean(); // one document per shop; the monitor needs no photos
  const now = Date.now();
  const waiting = subs.filter((s) => PENDING_STATUSES.includes(s.status));
  const overdue = waiting.filter((s) => s.dueAt && s.dueAt.getTime() < now);
  const reworkOpen = subs.flatMap((s) => (s.reworks ?? []).filter((r) => r.status === 'OPEN'));
  const decided = subs.flatMap((s) => (s.reviews ?? []).filter((r) => DECIDED.includes(String(r.decision))).map((r) => ({ ...r, submission: s._id })));
  const vBy = new Map(subs.flatMap((s) => (s.versions ?? []).map((v) => [`${s._id}:${v.version}`, v] as const)));
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
