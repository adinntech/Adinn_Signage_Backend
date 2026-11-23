import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { postShopMessage } from '../connect/connect.service';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, validateFiles, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';
import {
  assertProjectOpen, clientNameFor, CLOSED_PROJECT, displayStatus, EDITABLE, FIELD_ROLES, getConfig, hasUsableGps, installationPending, isLivePhoto, logEvent, missingFor, nameMap, oid, presentInstallation, presentPhoto, requiredCategories, reviewPath, roleMap, seedItems, siteLabel, stageRecipients, timeOf, type Config, type MediaItem,
} from './recceReview.common';
import { listThread, markThreadRead, parsePost, postThread, unreadCount, type ThreadCtx, type threadQuery } from './recceReview.thread';
import { byPhotoOrder, photoHistory, photoReviews, presentItem, versionHistory, compareVersions, compareQuery } from './recceReview.versions';
import { CATEGORY_LABEL, ELECTRICAL_ACCESS, PHOTO_CATEGORIES, PHOTO_SOURCES, REVIEW_STAGES, TRI_STATES, RecceSubmission, STAGE_LABEL, type ReviewStage } from './recceReview.model';

/* ------------------------------------------------ validators ------------------------------------------------ */

export const siteParam = z.object({ siteId: objectId });
export const photoParam = siteParam.extend({ photoId: objectId });
const text = (n: number) => z.string().trim().max(n);
export const mediaItemBody = z.object({
  key: z.string().trim().min(1).max(20).regex(/^[a-z0-9_-]+$/i),
  name: z.string().trim().min(1).max(80),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  width: z.coerce.number().min(0).max(100000).optional(),
  height: z.coerce.number().min(0).max(100000).optional(),
  unit: z.enum(['FT', 'IN', 'M', 'CM', 'MM']).default('FT'),
  notes: text(500).optional(),
  // One physical board per item. Boards of different sizes are separate items, each with its own key (max 20 characters).
  sided: z.enum(['SINGLE', 'DOUBLE']).optional(),
  condition: z.enum(['EXISTING', 'PROPOSED']).optional(),
  position: text(120).optional(),
  installationNotes: text(500).optional(),
});
const tri = z.enum(TRI_STATES);
const list = (n: number, each: number) => z.array(z.string().trim().min(1).max(each)).max(n);
/** Every field optional: a save only changes the fields it sends. Arrays are replaced as a whole. */
export const installationBody = z.object({
  ladderRequired: tri.optional(), scaffoldingRequired: tri.optional(), craneRequired: tri.optional(), hydraRequired: tri.optional(), manualInstallationPossible: tri.optional(),
  electricalAccess: z.enum(ELECTRICAL_ACCESS).optional(),
  installationHeightFt: z.number().min(0).max(500).nullable().optional(),
  accessRestrictions: list(10, 100).optional(), obstruction: text(300).optional(), roadsideConstraints: text(300).optional(), safetyNotes: text(500).optional(),
  additionalEquipment: list(20, 100).optional(), notes: text(500).optional(),
});
export const draftBody = z.object({ mediaItems: z.array(mediaItemBody).min(1).max(12).optional(), notes: text(2000).optional(), installation: installationBody.optional() }).refine((b) => b.mediaItems || b.notes !== undefined || b.installation, 'Nothing to save');
export const photoMeta = z.object({
  clientId: z.string().trim().min(8).max(80).optional(),
  category: z.enum(PHOTO_CATEGORIES),
  mediaKey: z.string().trim().max(20).default(''),
  caption: text(300).default(''),
  capturedAt: z.coerce.date().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  gpsAccuracy: z.coerce.number().min(0).max(100000).optional(),
  source: z.enum(PHOTO_SOURCES).optional(),
  device: text(120).optional(),
  width: z.coerce.number().int().min(1).max(100000).optional(),
  height: z.coerce.number().int().min(1).max(100000).optional(),
  replaces: objectId.optional(),
});
export const photoPatch = z.object({ category: z.enum(PHOTO_CATEGORIES).optional(), mediaKey: z.string().trim().max(20).optional(), caption: text(300).optional(), order: z.coerce.number().int().min(0).max(1000).optional() });
export const reorderBody = z.object({ ids: z.array(objectId).min(1).max(100) });
export const annotationBody = z.object({
  annotations: z.array(z.object({ type: z.enum(['rect', 'line', 'arrow', 'text', 'measure']), x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(), text: z.string().max(200).optional(), color: z.string().max(20).optional() })).max(200),
});
export const removeBody = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) });
export const submitBody = z.object({ idempotencyKey: z.string().trim().min(8).max(80), notes: text(2000).optional() });
export const messageBody = z.object({ body: z.string().trim().min(1).max(2000) });
export const myShopsQuery = z.object({
  projectId: objectId.optional(),
  q: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/* ------------------------------------------------ assignment ------------------------------------------------ */

/** The site filter for the shops this login may work on. A vendor never sees another vendor's shops. */
export async function mineFilter(actor: Actor): Promise<Record<string, unknown>> {
  if (!FIELD_ROLES.includes(actor.role)) throw AppError.forbidden();
  const me = oid(actor.id);
  if (actor.role === 'VENDOR') {
    const u = await User.findOne({ _id: actor.id, role: 'VENDOR', isActive: true, deletedAt: null }).select('vendorId').lean();
    if (!u?.vendorId) throw AppError.forbidden('This login is not linked to a vendor. Ask the office to set it.');
    return { channel: 'VENDOR', vendor: u.vendorId, deletedAt: null, $or: [{ assignedTo: me }, { assignedTo: null }] };
  }
  return { channel: 'IN_HOUSE', assignedTo: me, deletedAt: null };
}

export async function mySite(actor: Actor, siteId: string) {
  const site = await Site.findOne({ ...(await mineFilter(actor)), _id: siteId }).lean();
  if (!site) throw AppError.notFound('Shop not found'); // also what another vendor's shop looks like
  return site;
}

async function projectOf(id: Types.ObjectId) {
  const p = await Project.findOne({ _id: id, deletedAt: null }).select('code name client clientDetails status requirementType targetDate').lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}

/** The shop's recce record. Created on first use; if the shop was given to another person since, the change is recorded. */
async function ensureSubmission(actor: Actor, site: Awaited<ReturnType<typeof mySite>>) {
  const found = await RecceSubmission.findOne({ site: site._id });
  if (found) {
    if (String(found.assignee) !== actor.id) {
      if (!(EDITABLE as string[]).includes(found.status)) throw AppError.conflict('This shop was already submitted by someone else');
      const before = String(found.assignee);
      found.assignee = oid(actor.id);
      await found.save();
      await logEvent(actor, { submission: found._id, project: found.project, site: site._id, type: 'ASSIGNMENT_REASSIGNED', changes: [{ field: 'assignee', oldValue: before, newValue: actor.id }], visibility: 'REVIEW' });
    }
    return found;
  }
  try {
    const created = await RecceSubmission.create({
      project: site.project, site: site._id, assignee: actor.id, channel: site.channel, vendor: site.vendor, mediaItems: seedItems(site), startedAt: new Date(),
    });
    await logEvent(actor, { submission: created._id, project: site.project, site: site._id, type: 'SHOP_VISIT_STARTED' });
    return created;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return (await RecceSubmission.findOne({ site: site._id }))!;
    throw e;
  }
}

function assertEditable(status: string) {
  if ((EDITABLE as string[]).includes(status)) return;
  const why: Record<string, string> = {
    SUBMITTED: 'This shop is submitted and waiting for review. It cannot be changed now.',
    UNDER_REVIEW: 'This shop is under review. It cannot be changed now.',
    APPROVED: 'This shop is approved and locked. Ask the office to reopen it if it must change.',
    REJECTED: 'This shop was rejected. Ask the office to allow another attempt.',
  };
  throw AppError.conflict(why[status] ?? 'This shop cannot be changed now');
}

/* ------------------------------------------------ lists ------------------------------------------------ */

/** Every shop given to this login, with its recce status and progress. Screens A (projects) and B (shops) are built from this. */
export async function myShops(actor: Actor, q: z.infer<typeof myShopsQuery>) {
  const filter: Record<string, unknown> = { ...(await mineFilter(actor)) };
  if (q.projectId) filter.project = oid(q.projectId);
  const open = await Project.find({ status: { $nin: ['CANCELLED', 'LOSS'] }, deletedAt: null }).select('_id').lean();
  filter.project = q.projectId ? { $in: open.map((p) => p._id).filter((id) => String(id) === q.projectId) } : { $in: open.map((p) => p._id) };
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); filter.$and = [{ $or: [{ shopName: re }, { siteCode: re }, { district: re }, { location: re }] }]; }
  const sites = await Site.find(filter).select('project siteCode seq shopName dealerName location district address1 address2 address3 pincode mobile contactPerson boardType width height unit quantity remarks assignedTo assignedToAt').sort({ project: 1, seq: 1 }).lean();
  const cfg = await getConfig();
  // The photos and rework requests of a shop are inside its own document: one read, only the few fields the list needs.
  const subs = await RecceSubmission.find({ site: { $in: sites.map((s) => s._id) } }).select('site status currentVersion mediaItems photos.category photos.mediaKey photos.state reworks.status').lean();
  const subBy = new Map(subs.map((s) => [String(s.site), s]));
  const reworkBy = new Set(subs.filter((s) => (s.reworks ?? []).some((r) => r.status === 'OPEN')).map((s) => String(s._id)));
  const projects = new Map((await Project.find({ _id: { $in: [...new Set(sites.map((s) => String(s.project)))] } }).select('code name client clientDetails requirementType targetDate status').lean()).map((p) => [String(p._id), p]));
  const clientNames = new Map<string, string | null>();
  for (const p of projects.values()) clientNames.set(String(p._id), await clientNameFor(p));

  let rows = sites.map((s) => {
    const sub = subBy.get(String(s._id)) ?? null;
    const project = projects.get(String(s.project))!;
    const ph = (sub?.photos ?? []).filter(isLivePhoto);
    const items = sub?.mediaItems?.length ? (sub.mediaItems as unknown as MediaItem[]) : seedItems(s);
    const m = missingFor(cfg, items, ph.map((p) => ({ _id: p._id, category: p.category, mediaKey: p.mediaKey, state: p.state })), project?.requirementType);
    const draftCount = ph.filter((p) => p.state === 'DRAFT').length;
    const status = displayStatus(sub, draftCount, m.missing.length === 0);
    return {
      siteId: String(s._id), projectId: String(s.project), projectCode: project?.code ?? '', projectName: project?.name ?? '', client: clientNames.get(String(s.project)) ?? null,
      siteCode: s.siteCode, shopName: s.shopName ?? null, dealerName: s.dealerName ?? null, district: s.district ?? null, location: s.location ?? null,
      address: [s.address1, s.address2, s.address3, s.pincode].filter(Boolean).join(', '), contactPerson: s.contactPerson ?? null, mobile: s.mobile ?? null,
      mediaTypes: items.map((i) => ({ name: i.name, quantity: i.quantity ?? 1 })), assignedAt: s.assignedToAt ?? null, expectedBy: project?.targetDate ?? null,
      status, progress: status === 'APPROVED' ? 100 : m.percent, photoCount: ph.length, missing: m.missing.length, reworkOpen: reworkBy.has(String(sub?._id)), version: sub?.currentVersion ?? 0, submissionId: sub ? String(sub._id) : null,
    };
  });
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  const total = rows.length;
  const summary = rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  return { items: rows.slice((q.page - 1) * q.limit, q.page * q.limit), meta: { ...pageMeta(q.page, q.limit, total), summary } };
}

/* ------------------------------------------------ one shop ------------------------------------------------ */

export async function shopDetail(actor: Actor, siteId: string) {
  const site = await mySite(actor, siteId);
  const [project, cfg, sub] = await Promise.all([projectOf(site.project), getConfig(), RecceSubmission.findOne({ site: site._id }).lean()]);
  const items = (sub?.mediaItems?.length ? sub.mediaItems : seedItems(site)) as unknown as MediaItem[];
  const photos = (sub?.photos ?? []).filter(isLivePhoto).sort(byPhotoOrder);
  const [names, roles] = await Promise.all([nameMap(photos.map((p) => p.uploadedBy)), roleMap(photos.map((p) => p.uploadedBy))]);
  const m = missingFor(cfg, items, photos.map((p) => ({ _id: p._id, category: p.category, mediaKey: p.mediaKey, state: p.state })), project.requirementType);
  const draftCount = photos.filter((p) => p.state === 'DRAFT').length;
  const versions = [...(sub?.versions ?? [])].sort((a, b) => b.version - a.version);
  const reviews = [...(sub?.reviews ?? [])].sort((a, b) => b.versionNo - a.versionNo || a.stage.localeCompare(b.stage));
  const reviewers = await nameMap(reviews.map((r) => r.reviewer));
  const reworks = [...(sub?.reworks ?? [])].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  const requestedBy = await nameMap(reworks.map((r) => r.requestedBy));
  const reviewOf = photoReviews(photos, reworks as never, sub?.status, requestedBy);
  const status = displayStatus(sub, draftCount, m.missing.length === 0);
  return {
    siteId: String(site._id), siteCode: site.siteCode, shopName: site.shopName ?? null, dealerName: site.dealerName ?? null, district: site.district ?? null, contactPerson: site.contactPerson ?? null, mobile: site.mobile ?? null,
    address: [site.address1, site.address2, site.address3, site.pincode].filter(Boolean).join(', '), lat: site.lat ?? null, lng: site.lng ?? null, remarks: site.remarks ?? null,
    project: { id: String(project._id), code: project.code, name: project.name, client: await clientNameFor(project), expectedBy: project.targetDate ?? null, closed: CLOSED_PROJECT.includes(String(project.status)) },
    submissionId: sub ? String(sub._id) : null, status, rawStatus: sub?.status ?? 'NOT_STARTED', editable: !sub || (EDITABLE as string[]).includes(sub.status), version: sub?.currentVersion ?? 0, attempts: sub?.attempts ?? 0,
    mediaItems: items.map((i) => ({ ...presentItem(i), required: requiredCatsOf(cfg, i, project.requirementType) })), notes: sub?.notes ?? '',
    installation: presentInstallation(sub?.installation as never), installationPending: installationPending(sub?.installation as never),
    categories: PHOTO_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
    photos: await Promise.all(photos.map(async (p) => ({ ...(await presentPhoto(p as never, names, { withHistory: false, roles })), review: reviewOf.get(String(p._id))! }))),
    progress: { percent: status === 'APPROVED' ? 100 : m.percent, required: m.required, done: m.done, missing: m.missing.map((x) => ({ ...x, label: x.category === 'DIMENSIONS' ? 'Width, height and quantity' : CATEGORY_LABEL[x.category as keyof typeof CATEGORY_LABEL] })) },
    versions: versions.map((v) => ({ version: v.version, submittedAt: v.submittedAt, photoCount: v.photos.length })),
    reviews: reviews.map((r) => ({ versionNo: r.versionNo, stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], decision: r.decision, comment: r.comment, reviewer: r.reviewer ? (reviewers.get(String(r.reviewer)) ?? null) : null, decidedAt: r.decidedAt ?? null })),
    reworks: reworks.map((r) => ({ id: String(r._id), versionNo: r.versionNo, stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], kind: r.kind, status: r.status, instructions: r.instructions, requestedBy: requestedBy.get(String(r.requestedBy)) ?? null, requestedAt: r.createdAt, items: r.items.map((i) => ({ id: String(i._id), type: i.type, category: i.category ?? null, categoryLabel: i.category ? CATEGORY_LABEL[i.category as keyof typeof CATEGORY_LABEL] : null, mediaKey: i.mediaKey ?? '', photo: i.photo ? String(i.photo) : null, note: i.note ?? '', resolved: i.resolved })) })),
    maxPhotos: cfg.maxPhotos,
  };
}
const requiredCatsOf = (cfg: Config, item: MediaItem, rt?: string | null) => missingFor(cfg, [item], [], rt).missing.filter((x) => x.category !== 'DIMENSIONS').map((x) => x.category);

/** The shop thread of one of this login's shops (system cards and replies). Only this shop's thread, nothing else of the channel. */
async function threadCtx(actor: Actor, siteId: string) {
  const site = await mySite(actor, siteId);
  const sub = await RecceSubmission.findOne({ site: site._id }).select('_id assignee mediaItems.key reviewers pendingStage').lean();
  return { site, sub, side: 'FIELD' } as ThreadCtx;
}
export const shopThread = async (actor: Actor, siteId: string, q: z.infer<typeof threadQuery>) => listThread(actor, await threadCtx(actor, siteId), q);
export const sendShopMessage = async (actor: Actor, siteId: string, raw: Record<string, unknown> | undefined, file?: UploadedFile) => postThread(actor, await threadCtx(actor, siteId), parsePost(raw), file);
export const shopUnread = async (actor: Actor, siteId: string) => unreadCount(actor, await threadCtx(actor, siteId));
export const shopMarkRead = async (actor: Actor, siteId: string) => markThreadRead(actor, await threadCtx(actor, siteId));

/* ------------------------------------------------ draft: measurements, notes ------------------------------------------------ */

export async function saveDraft(actor: Actor, siteId: string, input: z.infer<typeof draftBody>) {
  const site = await mySite(actor, siteId);
  await assertProjectOpen(site.project);
  const sub = await ensureSubmission(actor, site);
  assertEditable(sub.status);
  const before = { mediaItems: sub.mediaItems.map((i) => i.toObject()), notes: sub.notes };
  const installBefore = presentInstallation(sub.installation as never);
  if (input.mediaItems) {
    const keys = input.mediaItems.map((i) => i.key);
    if (new Set(keys).size !== keys.length) throw AppError.badRequest('Each media type needs its own key');
    // A media type that already has photos cannot be dropped, or those photos would be orphaned.
    const used = new Set(sub.photos.filter((p) => isLivePhoto(p) && p.mediaKey).map((p) => p.mediaKey as string));
    const lost = [...used].filter((k) => !keys.includes(k));
    if (lost.length) throw AppError.conflict('A media type that has photos cannot be removed. Delete or move its photos first.');
    sub.set('mediaItems', input.mediaItems);
  }
  if (input.notes !== undefined) sub.notes = input.notes;
  if (input.installation) {
    const patch = Object.fromEntries(Object.entries(input.installation).filter(([, v]) => v !== undefined));
    const merged: Record<string, unknown> = { ...presentInstallation(sub.installation as never), ...patch };
    if (merged.installationHeightFt === null) delete merged.installationHeightFt;
    sub.set('installation', merged);
  }
  await sub.save();
  if (input.mediaItems || input.notes !== undefined) await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: input.mediaItems ? 'MEASUREMENT_UPDATED' : 'DRAFT_SAVED', changes: [{ field: 'draft', oldValue: before, newValue: { mediaItems: sub.mediaItems.map((i) => i.toObject()), notes: sub.notes } }] });
  if (input.installation) {
    const after = presentInstallation(sub.installation as never) as Record<string, unknown>;
    const was = installBefore as Record<string, unknown>;
    const changes = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(was[k])).map((k) => ({ field: `installation.${k}`, oldValue: was[k], newValue: after[k] }));
    if (changes.length) await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: 'INSTALLATION_UPDATED', changes });
  }
  return shopDetail(actor, siteId);
}

export async function startVisit(actor: Actor, siteId: string) {
  const site = await mySite(actor, siteId);
  await assertProjectOpen(site.project);
  await ensureSubmission(actor, site);
  return shopDetail(actor, siteId);
}

/* ------------------------------------------------ photos ------------------------------------------------ */

const R = 6371000;
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Device data is never trusted: it is checked here and suspicious values are flagged for the reviewer (the photo is still kept). */
function flagsFor(m: z.infer<typeof photoMeta>, site: { lat?: number | null; lng?: number | null }, cfg: Config, now: Date) {
  const flags: { code: string; message: string }[] = [];
  if (m.capturedAt) {
    if (m.capturedAt.getTime() > now.getTime() + 5 * 60_000) flags.push({ code: 'TIME_FUTURE', message: 'Capture time is in the future' });
    else if (now.getTime() - m.capturedAt.getTime() > 3 * 24 * 3600_000) flags.push({ code: 'TIME_OLD', message: 'Photo was captured more than 3 days before upload' });
  } else flags.push({ code: 'TIME_MISSING', message: 'No capture time reported by the device' });
  if (m.lat == null || m.lng == null) flags.push({ code: 'GPS_MISSING', message: cfg.requireGps ? 'GPS is required but missing' : 'No GPS location (permission denied or unavailable)' });
  else {
    if (m.lat === 0 && m.lng === 0) flags.push({ code: 'GPS_ZERO', message: 'GPS location is 0,0' });
    if (site.lat != null && site.lng != null && metres({ lat: m.lat, lng: m.lng }, { lat: site.lat, lng: site.lng }) > 1000) flags.push({ code: 'GPS_FAR', message: 'GPS is more than 1 km from the shop location' });
    if (m.gpsAccuracy != null && m.gpsAccuracy > 200) flags.push({ code: 'GPS_WEAK', message: 'GPS accuracy is worse than 200 m' });
  }
  if (m.width && m.height && Math.min(m.width, m.height) < 480) flags.push({ code: 'LOW_RESOLUTION', message: 'Image is very small' });
  return flags;
}

/**
 * Adds draft photos, one metadata object per file (same order). The same photo twice is stored once: by `clientId`
 * (a retry or a resumed upload returns the stored photo) and by content (sha256) within the shop. All files are checked
 * before any is stored, and stored files are removed again if saving fails.
 */
export async function uploadPhotos(actor: Actor, siteId: string, files: UploadedFile[], metas: z.infer<typeof photoMeta>[]) {
  if (!files.length) throw AppError.badRequest('Attach at least one photo');
  if (files.length !== metas.length) throw AppError.badRequest('Send one metadata object for each photo');
  const site = await mySite(actor, siteId);
  await assertProjectOpen(site.project);
  const sub = await ensureSubmission(actor, site);
  assertEditable(sub.status);
  const cfg = await getConfig();
  validateFiles('RECCE_SHOP_PHOTO', files);
  // The photos are part of the shop's one document, so everything below is read from `sub` and written with one atomic update.
  const live = sub.photos.filter(isLivePhoto);
  const keys = new Set(sub.mediaItems.map((i) => i.key));
  const hashes = files.map((f) => createHash('sha256').update(f.buffer).digest('hex'));
  const known = new Set(sub.photos.map((p) => p.clientId).filter((c): c is string => !!c));
  const fresh = files.map((f, i) => ({ f, m: metas[i]!, h: hashes[i]! })).filter((x) => !(x.m.clientId && known.has(x.m.clientId)));
  if (live.length + fresh.length > cfg.maxPhotos) throw AppError.badRequest(`A shop can hold ${cfg.maxPhotos} photos`);
  const seen = new Set<string>();
  for (const x of fresh) {
    if (x.m.mediaKey && !keys.has(x.m.mediaKey)) throw AppError.badRequest('Unknown media type for a photo');
    if (live.some((p) => p.original?.sha256 === x.h) || seen.has(x.h)) throw AppError.conflict(`${x.f.originalname} is already uploaded for this shop`);
    seen.add(x.h);
    if (x.m.replaces && !sub.photos.some((p) => String(p._id) === String(x.m.replaces) && p.state === 'SUBMITTED')) throw AppError.badRequest('The photo to replace was not found');
  }
  if (!fresh.length) return shopDetail(actor, siteId); // every photo was already stored (a retry): nothing to add
  const project = await projectOf(site.project);
  const clientName = (await clientNameFor(project)) ?? 'Client';
  const now = new Date();
  const base = sub.photos.length;
  const stored: StoredFile[] = [];
  const entries: Record<string, unknown>[] = [];
  try {
    for (const [i, x] of fresh.entries()) {
      const file = await storeEmbeddedFile({ category: 'RECCE_SHOP_PHOTO', clientName, folderKey: `${project.code}_${site.siteCode}`, file: x.f, actor, owner: { entity: 'RecceSubmission', id: sub._id } });
      stored.push(file);
      entries.push({
        _id: new Types.ObjectId(), mediaKey: x.m.mediaKey, category: x.m.category, caption: x.m.caption, order: base + i, state: 'DRAFT', original: file,
        capturedAt: x.m.capturedAt, lat: x.m.lat, lng: x.m.lng, gpsAccuracy: x.m.gpsAccuracy, source: x.m.source, device: x.m.device, width: x.m.width, height: x.m.height, flags: flagsFor(x.m, site, cfg, now),
        uploadedBy: actor.id, clientId: x.m.clientId, replaces: x.m.replaces, createdAt: now,
      });
    }
    // One atomic push. It only lands while the shop is still open for edits and none of these clientIds was stored in the meantime
    // (the same photo sent twice at once): the second request finds nothing to match and is refused, so a photo is never stored twice.
    const sent = fresh.map((x) => x.m.clientId).filter((c): c is string => !!c);
    const pushed = await RecceSubmission.updateOne({ _id: sub._id, status: { $in: EDITABLE }, 'photos.clientId': { $nin: sent } }, { $push: { photos: { $each: entries } } }, { runValidators: true });
    if (!pushed.modifiedCount) throw AppError.conflict('These photos could not be saved: the shop was just submitted, or the same photo arrived twice at once. Reload and try again.');
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  for (const d of entries) await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: d.replaces ? 'PHOTO_REPLACED' : 'PHOTO_CAPTURED', mediaKey: (d.mediaKey as string) || undefined, photo: d._id as Types.ObjectId, changes: [{ field: 'category', oldValue: null, newValue: d.category }] });
  return shopDetail(actor, siteId);
}

/** The shop's document and one photo of it (a photo id that is not in this shop is "not found", never another shop's photo). */
async function myPhoto(actor: Actor, siteId: string, photoId: string) {
  const site = await mySite(actor, siteId);
  const sub = await RecceSubmission.findOne({ site: site._id });
  const photo = sub?.photos.id(photoId);
  if (!sub || !photo) throw AppError.notFound('Photo not found');
  return { site, sub, photo };
}

/** Matches the shop while it is still open for edits and the photo is still a draft. */
const draftPhotoOf = (subId: Types.ObjectId, photoId: Types.ObjectId) => ({ _id: subId, status: { $in: EDITABLE }, photos: { $elemMatch: { _id: photoId, state: 'DRAFT' } } });

export async function patchPhoto(actor: Actor, siteId: string, photoId: string, input: z.infer<typeof photoPatch>) {
  const { site, sub, photo } = await myPhoto(actor, siteId, photoId);
  assertEditable(sub.status);
  if (photo.state !== 'DRAFT') throw AppError.conflict('A submitted photo cannot be edited. Replace it with a new photo.');
  if (input.mediaKey && !sub.mediaItems.some((i) => i.key === input.mediaKey)) throw AppError.badRequest('Unknown media type');
  const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [`photos.$.${k}`, v]));
  if (Object.keys(set).length) {
    const r = await RecceSubmission.updateOne(draftPhotoOf(sub._id, photo._id), { $set: set }, { runValidators: true });
    if (!r.matchedCount) throw AppError.conflict('This photo can no longer be edited. Reload and try again.');
  }
  await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: 'DRAFT_SAVED', photo: photo._id, mediaKey: (input.mediaKey ?? photo.mediaKey) || undefined });
  return shopDetail(actor, siteId);
}

export async function reorderPhotos(actor: Actor, siteId: string, ids: string[]) {
  const site = await mySite(actor, siteId);
  const sub = await RecceSubmission.findOne({ site: site._id });
  if (!sub) throw AppError.notFound('Photo not found');
  assertEditable(sub.status);
  const drafts = new Set(sub.photos.filter((p) => p.state === 'DRAFT').map((p) => String(p._id)));
  if (new Set(ids).size !== ids.length || ids.some((id) => !drafts.has(String(id).toLowerCase()))) throw AppError.badRequest('Only draft photos of this shop can be reordered');
  await RecceSubmission.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: sub._id, status: { $in: EDITABLE } }, update: { $set: { 'photos.$[p].order': i } }, arrayFilters: [{ 'p._id': oid(id), 'p.state': 'DRAFT' }] } })));
  return shopDetail(actor, siteId);
}

/** The marked copy (annotations burnt in by the phone) and the shapes. The original file is never touched. */
export async function annotatePhoto(actor: Actor, siteId: string, photoId: string, input: z.infer<typeof annotationBody>, edited?: UploadedFile) {
  const { site, sub, photo } = await myPhoto(actor, siteId, photoId);
  assertEditable(sub.status);
  if (photo.state !== 'DRAFT') throw AppError.conflict('A submitted photo cannot be edited. Replace it with a new photo.');
  let file: StoredFile | undefined;
  if (edited) {
    const project = await projectOf(site.project);
    file = await storeEmbeddedFile({ category: 'RECCE_SHOP_PHOTO', clientName: (await clientNameFor(project)) ?? 'Client', folderKey: `${project.code}_${site.siteCode}`, file: edited, actor, owner: { entity: 'RecceSubmission', id: sub._id } });
  }
  const old = photo.edited as unknown as StoredFile | undefined;
  try {
    const r = await RecceSubmission.updateOne(draftPhotoOf(sub._id, photo._id), { $set: { 'photos.$.annotations': input.annotations, ...(file ? { 'photos.$.edited': file } : {}) } });
    if (!r.matchedCount) throw AppError.conflict('This photo can no longer be edited. Reload and try again.');
  } catch (e) {
    if (file) await discardStoredFiles([file]);
    throw e;
  }
  if (file && old?.key) await eraseStoredFile(old, actor, { entity: 'RecceSubmission', id: sub._id });
  await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: 'PHOTO_ANNOTATED', photo: photo._id, mediaKey: photo.mediaKey ?? undefined });
  return shopDetail(actor, siteId);
}

/**
 * DRAFT photo: erased (record and stored files). SUBMITTED photo: never erased; while rework is open it is marked REMOVED with a
 * reason and dropped from the next version only. Not allowed while submitted, under review or approved.
 */
export async function deletePhoto(actor: Actor, siteId: string, photoId: string, reason?: string) {
  const { site, sub, photo } = await myPhoto(actor, siteId, photoId);
  assertEditable(sub.status);
  if (photo.state === 'DRAFT') {
    if (String(photo.uploadedBy) !== actor.id) throw AppError.forbidden('Only the person who uploaded a draft photo can delete it');
    const gone = await RecceSubmission.updateOne(draftPhotoOf(sub._id, photo._id), { $pull: { photos: { _id: photo._id, state: 'DRAFT' } } });
    if (!gone.modifiedCount) throw AppError.conflict('This photo was already changed. Reload and try again.');
    for (const f of [photo.original, photo.edited] as unknown as (StoredFile | undefined)[]) if (f?.key) await eraseStoredFile(f, actor, { entity: 'RecceSubmission', id: sub._id });
    await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: 'PHOTO_DELETED', photo: photo._id, mediaKey: photo.mediaKey ?? undefined, reason, changes: [{ field: 'category', oldValue: photo.category, newValue: null }] });
    return shopDetail(actor, siteId);
  }
  if (photo.state !== 'SUBMITTED') throw AppError.conflict('This photo is already removed');
  if (sub.status !== 'REWORK_REQUIRED') throw AppError.conflict('A submitted photo can only be removed while rework is requested');
  if (!reason || reason.trim().length < 3) throw AppError.badRequest('Give a reason for removing a submitted photo');
  const r = await RecceSubmission.updateOne({ _id: sub._id, photos: { $elemMatch: { _id: photo._id, state: 'SUBMITTED' } } }, { $set: { 'photos.$.state': 'REMOVED', 'photos.$.removedAt': new Date(), 'photos.$.removedBy': actor.id, 'photos.$.removeReason': reason.trim() } });
  if (!r.modifiedCount) throw AppError.conflict('This photo was already removed');
  await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: 'PHOTO_REMOVED', photo: photo._id, mediaKey: photo.mediaKey ?? undefined, reason: reason.trim(), visibility: 'REVIEW', changes: [{ field: 'state', oldValue: 'SUBMITTED', newValue: 'REMOVED' }] });
  return shopDetail(actor, siteId);
}

/* ------------------------------------------------ submit ------------------------------------------------ */

export const OPEN_STAGE = (stages: ReviewStage[], sequential: boolean, decisions: Record<string, string>): ReviewStage | null => {
  const pending = stages.filter((s) => decisions[s] === 'PENDING');
  if (!pending.length) return null;
  if (!sequential) return pending[0]!;
  const first = stages.find((s) => decisions[s] !== 'APPROVED');
  return first && decisions[first] === 'PENDING' ? first : null;
};

/**
 * Submits the shop for review as the next immutable version. Safe against double taps: the same idempotencyKey returns the
 * version already made, and a second concurrent submit loses the compare-and-set and gets a conflict. The version, its photos
 * and its pending reviews are all stored before the status changes to SUBMITTED, so a half-saved submission is never visible.
 */
export async function submit(actor: Actor, siteId: string, input: z.infer<typeof submitBody>) {
  const site = await mySite(actor, siteId);
  await assertProjectOpen(site.project);
  const sub = await ensureSubmission(actor, site);
  const again = sub.versions.find((v) => v.idempotencyKey === input.idempotencyKey);
  if (again) return { duplicate: true, version: again.version, detail: await shopDetail(actor, siteId) };
  assertEditable(sub.status);
  const project = await projectOf(site.project);
  const cfg = await getConfig();
  const notes = input.notes ?? sub.notes;
  const photos = sub.photos.filter(isLivePhoto).sort(byPhotoOrder);
  const items = sub.mediaItems as unknown as MediaItem[];
  const m = missingFor(cfg, items, photos.map((p) => ({ _id: p._id, category: p.category, mediaKey: p.mediaKey, state: p.state })), project.requirementType);
  if (!photos.length) throw AppError.badRequest('Add at least one photo before submitting');
  if (m.missing.length) throw new AppError(422, 'MISSING_EVIDENCE', 'Required photos or measurements are missing', m.missing.map((x) => ({ path: `${x.mediaName}.${x.category}`, message: x.category === 'DIMENSIONS' ? `${x.mediaName}: add width, height and quantity` : `${x.mediaName}: ${CATEGORY_LABEL[x.category as keyof typeof CATEGORY_LABEL]} is required` })));

  // With GPS required by the configuration, every live photo of a required category needs usable coordinates.
  if (cfg.requireGps) {
    const need = new Set(items.flatMap((i) => requiredCategories(cfg, i, project.requirementType)));
    const noGps = photos.filter((p) => need.has(p.category as never) && !hasUsableGps(p));
    if (noGps.length) throw new AppError(422, 'GPS_REQUIRED', 'Required photos need a usable GPS location', noGps.map((p) => ({ path: `${p.mediaKey || 'photo'}.${p.category}`, message: `${CATEGORY_LABEL[p.category as keyof typeof CATEGORY_LABEL] ?? p.category}: GPS location is missing or unusable` })));
  }

  // Open rework must be answered: every replacement / extra photo it asked for needs a new draft photo.
  const reworks = sub.reworks.filter((r) => r.status === 'OPEN');
  const drafts = photos.filter((p) => p.state === 'DRAFT');
  const unresolved: string[] = [];
  for (const rw of reworks) {
    for (const it of rw.items) {
      if (it.type === 'ADDITIONAL_PHOTO' && !drafts.some((d) => d.category === it.category && (!it.mediaKey || d.mediaKey === it.mediaKey))) unresolved.push(`Add: ${CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? 'photo'}`);
      if (it.type === 'REPLACE_PHOTO' && !drafts.some((d) => d.replaces && String(d.replaces) === String(it.photo))) unresolved.push('Replace the photo the reviewer marked');
    }
  }
  if (unresolved.length) throw new AppError(422, 'REWORK_UNRESOLVED', 'The rework request is not answered yet', unresolved.map((message) => ({ path: 'rework', message })));

  // Installation feasibility: the five yes / no answers must be given. An unanswered field is never treated as NO.
  const pending = installationPending(sub.installation as never);
  if (pending.length) throw AppError.badRequest(`Installation feasibility is incomplete. Answer: ${pending.join(', ')}`, pending.map((f) => ({ path: `installation.${f}`, message: `${f} is not assessed` })));

  const prev = [...sub.versions].sort((a, b) => b.version - a.version)[0];
  const versionNo = (prev?.version ?? 0) + 1;
  const stages = (cfg.stages as ReviewStage[]).filter((s) => REVIEW_STAGES.includes(s));
  const now = new Date();
  const dueAt = new Date(now.getTime() + cfg.slaHours * 3600_000);
  const replacing = drafts.filter((d) => d.replaces);
  const replaced = replacing.map((d) => d.replaces!);
  const keep = photos.filter((p) => !replaced.some((r) => String(r) === String(p._id)));
  const gone = sub.photos.filter((p) => p.state === 'REMOVED' && (!prev || (p.removedAt && p.removedAt > prev.submittedAt)));
  const first = stages[0]!;

  // ONE atomic update: the version snapshot, its pending reviews, the photo states, the answered rework and the status change land
  // together or not at all, so a half-saved submission is never visible. It only applies if the shop is still open and unchanged
  // (compare-and-set on `rev` + status): a second tap, or a second device, finds nothing to match and gets a conflict.
  const versionEntry = {
    _id: new Types.ObjectId(), version: versionNo, submittedBy: actor.id, submittedAt: now, photos: keep.map((p) => p._id), added: drafts.map((p) => p._id),
    removed: [...gone.map((g) => g._id), ...replaced], mediaItems: sub.mediaItems.map((i) => i.toObject()), notes, installation: presentInstallation(sub.installation as never), stages, sequential: cfg.sequential, dueAt, idempotencyKey: input.idempotencyKey,
  };
  const set: Record<string, unknown> = { status: 'SUBMITTED', currentVersion: versionNo, submittedAt: now, dueAt, pendingStage: first, notes };
  const arrayFilters: Record<string, unknown>[] = [];
  if (drafts.length) {
    arrayFilters.push({ 'd._id': { $in: drafts.map((d) => d._id) } });
    set['photos.$[d].state'] = 'SUBMITTED';
    set['photos.$[d].version'] = versionNo;
  }
  replacing.forEach((d, i) => {
    arrayFilters.push({ [`r${i}._id`]: d.replaces });
    set[`photos.$[r${i}].state`] = 'SUPERSEDED';
    set[`photos.$[r${i}].supersededBy`] = d._id;
  });
  if (reworks.length) {
    arrayFilters.push({ 'w.status': 'OPEN' });
    set['reworks.$[w].status'] = 'RESOLVED';
    set['reworks.$[w].resolvedAt'] = now;
    set['reworks.$[w].items.$[].resolved'] = true;
    set['reworks.$[w].items.$[].resolvedInVersion'] = versionNo;
  }
  const cas = await RecceSubmission.updateOne(
    { _id: sub._id, rev: sub.rev, status: { $in: EDITABLE } },
    { $set: set, $push: { versions: versionEntry, reviews: { $each: stages.map((stage) => ({ versionNo, stage })) } }, $inc: { rev: 1, attempts: 1 } },
    arrayFilters.length ? { arrayFilters } : {},
  );
  if (!cas.modifiedCount) throw AppError.conflict('This shop was changed or submitted at the same time. Reload and check its status.');
  await logEvent(actor, { submission: sub._id, project: sub.project, site: site._id, type: versionNo > 1 ? 'REWORK_SUBMITTED' : 'SUBMISSION_CREATED', version: versionNo, changes: [{ field: 'photos', oldValue: prev?.photos.length ?? 0, newValue: keep.length }] });
  // Sequential review tells only the first stage now (the next one is told at its turn). Otherwise every stage is told at once; one card is posted.
  for (const stage of cfg.sequential ? [first] : stages) {
    await announceSubmitted(actor, { submissionId: sub._id, projectId: sub.project, siteId: site._id, siteName: siteLabel(site), project, versionNo, photoCount: keep.length, mediaNames: items.map((i) => i.name), stage, resubmitted: versionNo > 1, card: stage === first ? 'submitted' : 'none' });
  }
  return { duplicate: false, version: versionNo, detail: await shopDetail(actor, siteId) };
}

/* ------------------------------------------------ version history (field user's own shops) ------------------------------------------------ */

export async function myVersions(actor: Actor, siteId: string) {
  const site = await mySite(actor, siteId);
  const sub = await RecceSubmission.findOne({ site: site._id }).select('_id').lean();
  return sub ? versionHistory(sub._id) : [];
}
export async function myCompare(actor: Actor, siteId: string, q: z.infer<typeof compareQuery>) {
  const site = await mySite(actor, siteId);
  const sub = await RecceSubmission.findOne({ site: site._id }).select('_id').lean();
  if (!sub) throw AppError.notFound('Version not found');
  return compareVersions(sub._id, q.from, q.to);
}
/** Revisions, timeline events and rework requests of one photo. The field person sees only events visible to them. */
export async function myPhotoHistory(actor: Actor, siteId: string, photoId: string) {
  const { sub } = await myPhoto(actor, siteId, photoId);
  return photoHistory(sub._id, photoId, ['ALL']);
}

export { reviewPath };

/** Tells the reviewers whose turn it is, and posts the structured card into the project channel (shop thread). */
export async function announceSubmitted(
  actor: Actor,
  i: { submissionId: Types.ObjectId; projectId: Types.ObjectId; siteId: Types.ObjectId; siteName: string; project: { code: string; client?: unknown }; versionNo: number; photoCount: number; mediaNames: string[]; stage: ReviewStage; resubmitted?: boolean; /** submitted = the version was just submitted; turn = a stage hands over to the next one; none = notify only */ card?: 'submitted' | 'turn' | 'none' },
) {
  const who = (await User.findById(actor.id).select('name').lean())?.name ?? 'Recce team';
  const sub = await RecceSubmission.findById(i.submissionId).select('reviewers').lean();
  const recipients = await stageRecipients(i.stage, i.projectId, sub?.reviewers?.[i.stage] ?? null);
  const clientName = await clientNameFor(i.project as never);
  await notify({
    recipients, kind: 'RECCE_SUBMITTED', path: reviewPath(i.submissionId), site: i.siteId, actorId: actor.id, project: { _id: i.projectId, code: i.project.code, clientName: clientName ?? undefined },
    title: i.resubmitted ? `Shop recce resubmitted (v${i.versionNo})` : 'Shop recce submitted',
    body: `${who} submitted ${i.siteName} (${i.photoCount} photos, version ${i.versionNo}) for ${STAGE_LABEL[i.stage]} review.`,
    dedupe: (r) => `recce-submit:${String(i.submissionId)}:${i.versionNo}:${i.stage}:${r}`,
  });
  if (i.card === 'none') return;
  const turn = i.card === 'turn';
  await postShopMessage(i.projectId, i.siteId, actor, {
    // One card per (version, stage): a retry or a second call for the same event never posts it again.
    eventKey: `${turn ? 'turn' : 'submit'}:${String(i.submissionId)}:${i.versionNo}:${i.stage}`, refs: [{ type: 'VERSION', id: String(i.versionNo) }],
    card: { title: turn ? `${STAGE_LABEL[i.stage]} Review Due` : i.resubmitted ? 'Shop Recce Resubmitted' : 'Shop Recce Submitted', tone: 'info', path: reviewPath(i.submissionId), lines: [
      { label: 'Project', value: i.project.code }, { label: 'Shop', value: i.siteName }, { label: 'Submitted By', value: who },
      { label: 'Media Types', value: i.mediaNames.join(', ') }, { label: 'Photos', value: String(i.photoCount) }, { label: 'Submission Version', value: `v${i.versionNo}` },
    ] },
  });
}
