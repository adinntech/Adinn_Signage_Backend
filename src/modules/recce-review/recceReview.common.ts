import { Types } from 'mongoose';
import { AppError } from '../../common/errors';
import { isScoped, projectScope } from '../../common/project-access';
import type { Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { Client } from '../clients/client.model';
import { storedFileUrl } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { Project } from '../projects/project.model';
import { SalesOrder } from '../sales/sales.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';
import { INSTALLATION_REQUIRED, RecceConfig, type PhotoCategory, type RecceStatus, type ReviewStage } from './recceReview.model';

export const FIELD_ROLES = ['VENDOR', 'RECCE_EXECUTIVE'];
export const OPS_ROLES = ['OPERATIONS', 'RECCE_COORDINATOR'];
export const MONITOR_ROLES = ['SUPER_ADMIN', 'MANAGEMENT'];
/** A project in one of these states takes no more recce work or review. */
export const CLOSED_PROJECT = ['COMPLETED', 'CANCELLED', 'LOSS'];
/** Submission states in which the field person may still change evidence. */
export const EDITABLE: RecceStatus[] = ['IN_PROGRESS', 'REWORK_REQUIRED'];
export const REVIEWABLE: RecceStatus[] = ['SUBMITTED', 'UNDER_REVIEW'];

export const oid = (v: string | Types.ObjectId) => new Types.ObjectId(String(v));

/** A photo that counts for the shop right now: still a draft, or part of a submitted version (not replaced or removed). */
export const isLivePhoto = (p: { state: string }) => p.state === 'DRAFT' || p.state === 'SUBMITTED';
/** Newest first / oldest first by a date field (missing dates sort as the oldest). */
export const timeOf = (d?: Date | null) => d?.getTime() ?? 0;

export async function getConfig() {
  return (await RecceConfig.findOneAndUpdate({ key: 'default' }, { $setOnInsert: { key: 'default' } }, { upsert: true, returnDocument: 'after' })).toObject();
}
export type Config = Awaited<ReturnType<typeof getConfig>>;

/* ------------------------------------------------ activity (the timeline) ------------------------------------------------ */

export const EVENT_LABEL: Record<string, string> = {
  ASSIGNMENT_REASSIGNED: 'Assignment reassigned', SHOP_VISIT_STARTED: 'Shop visit started', PHOTO_CAPTURED: 'Photo uploaded', PHOTO_REPLACED: 'Photo replaced',
  PHOTO_DELETED: 'Draft photo deleted', PHOTO_REMOVED: 'Submitted photo removed', PHOTO_RESTORED: 'Photo restored', PHOTO_ANNOTATED: 'Photo annotated',
  MEASUREMENT_UPDATED: 'Measurement updated', DRAFT_SAVED: 'Draft saved', SUBMISSION_CREATED: 'Submission created', REWORK_SUBMITTED: 'Rework submitted',
  REVIEW_APPROVED: 'Review approved', REVIEW_REJECTED: 'Review rejected', REWORK_REQUESTED: 'Rework requested', ADDITIONAL_PHOTOS_REQUESTED: 'Additional photos requested',
  FINAL_APPROVAL: 'Final approval', ADMIN_OVERRIDE: 'Admin override', REOPENED: 'Reopened', COMMENT_ADDED: 'Comment added', REVIEWER_ASSIGNED: 'Reviewer assigned',
  REVIEW_STARTED: 'Review started', DOCUMENT_UPLOADED: 'Document uploaded', VOICE_NOTE_ADDED: 'Voice note added', INSTALLATION_UPDATED: 'Installation feasibility updated',
  ITEM_APPROVED: 'Item approved', ITEM_REJECTED: 'Item rejected', ITEM_CLEARED: 'Item decision cleared', UNIT_APPROVED: 'Unit approved', UNIT_REVERTED: 'Unit approval reverted', UNIT_REJECTED: 'Unit rejected',
};

export type Visibility = 'ALL' | 'REVIEW' | 'ADMIN';

/**
 * One timeline event. Written straight to the existing AuditLog (entity RecceSubmission) and NOT through recordAudit,
 * because that would also send a generic notification for every photo. Never throws.
 */
export async function logEvent(
  actor: Actor,
  e: { submission: Types.ObjectId; project: Types.ObjectId; site: Types.ObjectId; type: string; reason?: string | undefined; changes?: { field: string; oldValue: unknown; newValue: unknown }[]; mediaKey?: string | undefined; photo?: Types.ObjectId | undefined; version?: number | undefined; visibility?: Visibility },
) {
  try {
    await AuditLog.create({
      user: actor.id, role: actor.role, action: e.type, entity: 'RecceSubmission', entityId: e.submission, project: e.project, reason: e.reason, changes: e.changes ?? [],
      meta: { site: e.site, mediaKey: e.mediaKey ?? null, photo: e.photo ?? null, version: e.version ?? null, visibility: e.visibility ?? 'ALL' },
    });
  } catch (err) {
    console.error('recce event failed', err);
  }
}

/* ------------------------------------------------ who may do what ------------------------------------------------ */

/** Projects a Client Servicing person looks after: orders assigned to them, or projects they created. */
export async function csProjectFilter(actor: Actor) {
  const me = oid(actor.id);
  const orders = await SalesOrder.find({ csAssignee: me, deletedAt: null }).select('_id').lean();
  return { $or: [{ createdBy: me }, { salesOrder: { $in: orders.map((o) => o._id) } }] };
}

/** Mongo filter on projects the person may review. Everyone else gets nothing. */
export async function reviewProjectFilter(actor: Actor): Promise<Record<string, unknown> | null> {
  if (actor.role === 'SUPER_ADMIN' || actor.role === 'MANAGEMENT') return { deletedAt: null };
  if (OPS_ROLES.includes(actor.role)) return { deletedAt: null, ...(await projectScope(actor)) };
  if (actor.role === 'CLIENT_SERVICING') return { deletedAt: null, ...(await csProjectFilter(actor)) };
  return null;
}
export async function reviewProjectIds(actor: Actor): Promise<Types.ObjectId[] | null> {
  const f = await reviewProjectFilter(actor);
  if (!f) throw AppError.forbidden();
  if (actor.role === 'SUPER_ADMIN' || actor.role === 'MANAGEMENT') return null; // null = all
  return (await Project.find(f).select('_id').lean()).map((p) => p._id);
}

/** The review stage this person decides. Admin may decide either, but only through an override (with a reason). */
export const stageOf = (role: string): ReviewStage | null => (OPS_ROLES.includes(role) ? 'OPS' : role === 'CLIENT_SERVICING' ? 'CS' : null);

export async function assertCanSeeProject(actor: Actor, projectId: Types.ObjectId | string) {
  const f = await reviewProjectFilter(actor);
  if (!f || !(await Project.exists({ _id: projectId, ...f }))) throw AppError.notFound('Submission not found');
}

export async function assertProjectOpen(projectId: Types.ObjectId | string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('status').lean();
  if (!p) throw AppError.notFound('Project not found');
  if (CLOSED_PROJECT.includes(String(p.status))) throw AppError.conflict(`This project is ${String(p.status).toLowerCase()}, so recce evidence can no longer be changed or reviewed`);
}

/* ------------------------------------------------ requirements & progress ------------------------------------------------ */

export type MediaItem = { key: string; name: string; quantity?: number | null | undefined; width?: number | null | undefined; height?: number | null | undefined; unit?: string | null | undefined; notes?: string | null | undefined; sided?: string | null | undefined; condition?: string | null | undefined; position?: string | null | undefined; installationNotes?: string | null | undefined; units?: { key: string; unitNo: number; width?: number | null; height?: number | null }[] | null | undefined };

/** Photo categories this media item needs. Configurable: the first config key contained in the media name wins, else the project rule, else default. */
export function requiredCategories(cfg: Config, item: MediaItem, requirementType?: string | null): PhotoCategory[] {
  const rules = (cfg.requiredPhotos ?? {}) as Record<string, PhotoCategory[]>;
  const name = item.name.toLowerCase();
  const byName = Object.keys(rules).find((k) => k !== 'default' && k !== 'measurement' && name.includes(k.toLowerCase()));
  if (byName) return rules[byName]!;
  if (requirementType === 'SHOP_MEASUREMENT' || name.includes('measure')) return rules.measurement ?? rules.default ?? [];
  return rules.default ?? [];
}

type PhotoLite = { _id: Types.ObjectId; category: string; mediaKey?: string | null | undefined; state: string; supersededBy?: unknown };
/** What is still missing for submit: required categories without a live photo, and missing dimensions where a measurement is required. */
export function missingFor(cfg: Config, items: MediaItem[], photos: PhotoLite[], requirementType?: string | null) {
  const live = photos.filter((p) => p.state === 'DRAFT' || p.state === 'SUBMITTED');
  const missing: { mediaKey: string; mediaName: string; category: string; label: string }[] = [];
  let required = 0;
  let done = 0;
  for (const item of items) {
    const need = requiredCategories(cfg, item, requirementType);
    for (const c of need) {
      required++;
      if (live.some((p) => p.category === c && (p.mediaKey === item.key || !p.mediaKey))) done++;
      else missing.push({ mediaKey: item.key, mediaName: item.name, category: c, label: c });
    }
    if (need.includes('MEASUREMENT')) {
      required++;
      if (item.width && item.height && item.quantity) done++;
      else missing.push({ mediaKey: item.key, mediaName: item.name, category: 'DIMENSIONS', label: 'DIMENSIONS' });
    }
  }
  return { missing, required, done, percent: required ? Math.round((done / required) * 100) : live.length ? 100 : 0 };
}

/* ------------------------------------------------ installation feasibility ------------------------------------------------ */

export type Installation = {
  ladderRequired?: string | null; scaffoldingRequired?: string | null; craneRequired?: string | null; hydraRequired?: string | null; manualInstallationPossible?: string | null; electricalAccess?: string | null;
  installationHeightFt?: number | null; accessRestrictions?: string[] | null; obstruction?: string | null; roadsideConstraints?: string | null; safetyNotes?: string | null; additionalEquipment?: string[] | null; notes?: string | null;
};

/** Always the full shape. A missing field is NOT_ASSESSED (never NO), so older records and unanswered questions read the same way. */
export function presentInstallation(i?: Installation | null) {
  const t = (v?: string | null) => v ?? 'NOT_ASSESSED';
  return {
    ladderRequired: t(i?.ladderRequired), scaffoldingRequired: t(i?.scaffoldingRequired), craneRequired: t(i?.craneRequired), hydraRequired: t(i?.hydraRequired), manualInstallationPossible: t(i?.manualInstallationPossible),
    electricalAccess: t(i?.electricalAccess), installationHeightFt: i?.installationHeightFt ?? null, accessRestrictions: [...(i?.accessRestrictions ?? [])], obstruction: i?.obstruction ?? '', roadsideConstraints: i?.roadsideConstraints ?? '',
    safetyNotes: i?.safetyNotes ?? '', additionalEquipment: [...(i?.additionalEquipment ?? [])], notes: i?.notes ?? '',
  };
}
export type InstallationView = ReturnType<typeof presentInstallation>;

/** The required installation answers that are still NOT_ASSESSED. */
export const installationPending = (i?: Installation | null): string[] => INSTALLATION_REQUIRED.filter((k) => (i?.[k] ?? 'NOT_ASSESSED') === 'NOT_ASSESSED');

/** Coordinates usable as evidence: present, not 0,0, accuracy no worse than 200 m. */
export const hasUsableGps = (p: { lat?: number | null; lng?: number | null; gpsAccuracy?: number | null }) =>
  p.lat != null && p.lng != null && !(p.lat === 0 && p.lng === 0) && (p.gpsAccuracy == null || p.gpsAccuracy <= 200);

/** The status the person sees: DRAFT and READY_TO_SUBMIT are derived from what is stored. */
export function displayStatus(s: { status: string } | null, draftCount: number, ready: boolean) {
  if (!s) return 'NOT_STARTED';
  if (s.status === 'IN_PROGRESS') return ready && draftCount > 0 ? 'READY_TO_SUBMIT' : draftCount > 0 ? 'DRAFT' : 'IN_PROGRESS';
  return s.status;
}

/** Media items seeded from the shop's own measurement (the board type, size and quantity BD / Operations recorded). */
export function seedItems(site: { boardType?: string | null; width?: number | null; height?: number | null; unit?: string | null; quantity?: number | null }): MediaItem[] {
  return [{ key: 'm1', name: site.boardType?.trim() || 'Board', quantity: site.quantity ?? 1, ...(site.width ? { width: site.width } : {}), ...(site.height ? { height: site.height } : {}), unit: (site.unit as string) || 'FT' }];
}

/* ------------------------------------------------ media items: stored units ⇄ field app's flat lines ------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRow = any;

/** Unit states in which the field person may still change the unit (never submitted, or sent back). */
export const EDITABLE_UNIT = ['DRAFT', 'REWORK'];
/** SS-01 / DS-02: side prefix + two-digit unit number. */
export const unitIdOf = (sideType: string | null | undefined, unitNo: number) => `${sideType === 'DOUBLE' ? 'DS' : 'SS'}-${String(unitNo).padStart(2, '0')}`;
/** GSP, VINYL, … from the board name the field app sends ("GSP Board" → GSP). */
export function mediaTypeOf(name?: string | null) {
  const n = (name ?? '').toUpperCase();
  if (n.includes('VINYL') || n.includes('VINAYL')) return 'VINYL';
  if (n.includes('GSP')) return 'GSP';
  return n.replace(/\bBOARD\b/g, '').trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'BOARD';
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The field app's flat view of the stored media items (the mobile API is unchanged): key / name / size per line, and its
 * own unit keys and answers when it sent units. Reads older records (key / name / sided) the same way.
 */
export function flatItems(items: AnyRow[] | null | undefined): MediaItem[] {
  return (items ?? []).map((m: AnyRow) => {
    const key = m.mediaKey ?? m.key;
    const units: AnyRow[] = m.units ?? [];
    const first = units[0];
    const size = first?.measurement ?? (first ? { width: first.width, height: first.height, unit: first.unit } : { width: m.width, height: m.height, unit: m.unit });
    const fieldUnits = units.some((u) => u.fieldKey || (u.key && !u.unitId));
    return {
      key, name: m.name ?? m.mediaType ?? key, quantity: m.quantity ?? 1, width: num(size?.width), height: num(size?.height), unit: size?.unit ?? 'FT',
      notes: m.notes, sided: m.sideType ?? m.sided, condition: m.condition, position: m.position, installationNotes: m.installationNotes,
      ...(fieldUnits
        ? { units: units.map((u) => ({
            key: u.fieldKey ?? u.key ?? `${key}-u${u.unitNo}`, unitNo: u.unitNo, width: num(u.measurement?.width ?? u.width), height: num(u.measurement?.height ?? u.height), unit: u.measurement?.unit ?? u.unit ?? 'FT',
            answers: (u.answers ?? []).map((a: AnyRow) => ({ key: a.questionId ?? a.key, question: a.question, answer: a.answer })), notes: u.notes,
          })) }
        : {}),
    } as MediaItem;
  });
}

/**
 * Merges the field app's flat lines into the stored media items: line fields are updated, and each unit's measurement and answers
 * only while the unit is editable (DRAFT / REWORK). Units already submitted keep their record; a line or unit that was never
 * submitted and is no longer sent is dropped. A line without units is one unit made of the line's own size.
 */
export function mergeFieldItems(existing: AnyRow[] | null | undefined, incoming: MediaItem[]): AnyRow[] {
  const out: AnyRow[] = [];
  const old = (existing ?? []).filter((m: AnyRow) => m.mediaKey);
  for (const i of incoming) {
    const ex = old.find((m: AnyRow) => m.mediaKey === i.key);
    const sideType = i.sided === 'DOUBLE' ? 'DOUBLE' : i.sided === 'SINGLE' ? 'SINGLE' : (ex?.sideType ?? 'SINGLE');
    const src: AnyRow[] = i.units?.length
      ? i.units.map((u: AnyRow, n: number) => ({ ...u, unitNo: u.unitNo ?? n + 1 }))
      : [{ unitNo: 1, key: null, width: i.width, height: i.height, unit: i.unit }];
    const units: AnyRow[] = [];
    for (const s of src) {
      const u = ex?.units?.find((x: AnyRow) => x.unitNo === s.unitNo) ?? { unitId: unitIdOf(sideType, s.unitNo), unitNo: s.unitNo, status: 'DRAFT', currentVersion: 0, photos: [], versions: [], reviews: [], reworks: [] };
      if (EDITABLE_UNIT.includes(u.status)) {
        Object.assign(u, {
          fieldKey: s.key ?? undefined, measurement: { width: num(s.width), height: num(s.height), unit: s.unit || i.unit || 'FT' },
          answers: (s.answers ?? []).map((a: AnyRow) => ({ questionId: a.key, question: a.question, answer: a.answer })), notes: s.notes,
        });
      }
      units.push(u);
    }
    // Submitted units the app no longer sends are kept (their history stays).
    for (const u of ex?.units ?? []) if (!units.includes(u) && u.currentVersion > 0) units.push(u);
    units.sort((a, b) => a.unitNo - b.unitNo);
    out.push({
      ...(ex ?? {}), mediaKey: i.key, mediaType: mediaTypeOf(i.name), sideType, quantity: i.quantity ?? 1, name: i.name,
      condition: i.condition ?? undefined, position: i.position ?? undefined, notes: i.notes ?? undefined, installationNotes: i.installationNotes ?? undefined, units,
    });
  }
  for (const m of old) if (!out.some((x) => x.mediaKey === m.mediaKey) && (m.units ?? []).some((u: AnyRow) => u.currentVersion > 0)) out.push(m);
  return out;
}

/* ------------------------------------------------ presenting ------------------------------------------------ */

export const link = async (f: StoredFile | null | undefined) => {
  if (!f) return null;
  const l = await storedFileUrl(f).catch(() => null);
  return l ? { url: l.url, expiresAt: l.expiresAt } : null;
};

type PhotoRow = { _id: Types.ObjectId; category: string; mediaKey?: string | null; unitKey?: string | null; caption?: string | null; order?: number | null; state: string; original: StoredFile; edited?: StoredFile | null; annotations?: unknown; capturedAt?: Date | null; lat?: number | null; lng?: number | null; gpsAccuracy?: number | null; width?: number | null; height?: number | null; flags?: { code?: string | null; message?: string | null }[]; uploadedBy?: Types.ObjectId; createdAt?: Date; version?: number | null; replaces?: Types.ObjectId | null; supersededBy?: Types.ObjectId | null; removedAt?: Date | null; removedBy?: Types.ObjectId | null; removeReason?: string | null; source?: string | null; device?: string | null };

/** `withHistory` is for reviewers and admin: removal reason and flags. Field users get only the live photo data. */
export async function presentPhoto(p: PhotoRow, names: Map<string, string>, opts: { withHistory: boolean; roles?: Map<string, string> }) {
  const [o, e] = await Promise.all([link(p.original), link(p.edited)]);
  return {
    id: String(p._id), category: p.category, mediaKey: p.mediaKey ?? '', unitKey: p.unitKey ?? null, caption: p.caption ?? '', order: p.order ?? 0, state: p.state, version: p.version ?? null,
    url: o?.url ?? null, editedUrl: e?.url ?? null, hasEdited: !!p.edited, annotations: p.annotations ?? null,
    capturedAt: p.capturedAt ?? null, uploadedAt: p.createdAt ?? null, uploadedBy: p.uploadedBy ? (names.get(String(p.uploadedBy)) ?? null) : null,
    capturedByRole: p.uploadedBy ? (opts.roles?.get(String(p.uploadedBy)) ?? null) : null, source: p.source ?? null, device: p.device ?? null,
    gpsVerified: hasUsableGps(p) && !(p.flags ?? []).some((f) => String(f.code ?? '').startsWith('GPS_')),
    lat: p.lat ?? null, lng: p.lng ?? null, gpsAccuracy: p.gpsAccuracy ?? null, width: p.width ?? null, height: p.height ?? null, size: p.original.size ?? null,
    replaces: p.replaces ? String(p.replaces) : null, supersededBy: p.supersededBy ? String(p.supersededBy) : null,
    ...(opts.withHistory ? { flags: (p.flags ?? []).map((f) => ({ code: f.code ?? '', message: f.message ?? '' })), removedAt: p.removedAt ?? null, removedBy: p.removedBy ? (names.get(String(p.removedBy)) ?? null) : null, removeReason: p.removeReason ?? null } : {}),
  };
}

export async function nameMap(ids: (Types.ObjectId | string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  const users = list.length ? await User.find({ _id: { $in: list } }).select('name role').lean() : [];
  return new Map(users.map((u) => [String(u._id), u.name as string]));
}

/** User id to role, for presenting who captured a photo. */
export async function roleMap(ids: (Types.ObjectId | string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  const users = list.length ? await User.find({ _id: { $in: list } }).select('role').lean() : [];
  return new Map(users.map((u) => [String(u._id), String(u.role)]));
}

export async function clientNameFor(p: { client?: Types.ObjectId | null; clientDetails?: { name?: string | null }[] | null }) {
  if (p.client) return (await Client.findById(p.client).select('name').lean())?.name ?? null;
  return p.clientDetails?.at(-1)?.name ?? null;
}

/** The people to tell for a review stage: the named reviewer, else the project's Operations / Client Servicing people. */
export async function stageRecipients(stage: ReviewStage, projectId: Types.ObjectId, named?: Types.ObjectId | null): Promise<Types.ObjectId[]> {
  if (named) return [named];
  const p = await Project.findById(projectId).select('assignedTo coordinator salesOrder createdBy').lean();
  if (!p) return [];
  if (stage === 'OPS') return [p.assignedTo, p.coordinator].filter(Boolean) as Types.ObjectId[];
  const order = p.salesOrder ? await SalesOrder.findById(p.salesOrder).select('csAssignee').lean() : null;
  const out = [order?.csAssignee, p.createdBy].filter(Boolean) as Types.ObjectId[];
  const cs = out.length ? await User.find({ _id: { $in: out }, role: 'CLIENT_SERVICING', isActive: true }).select('_id').lean() : [];
  return cs.map((u) => u._id);
}

export const siteLabel = (s: { shopName?: string | null; siteCode?: string | null }) => s.shopName || s.siteCode || 'Shop';

export async function siteOrFail(siteId: string) {
  const s = await Site.findOne({ _id: siteId, deletedAt: null }).lean();
  if (!s) throw AppError.notFound('Shop not found');
  return s;
}
export { isScoped };

/** The web page of one shop's review (a notification or card opens it). */
export const reviewPath = (submissionId: Types.ObjectId | string) => `/recce-review/${String(submissionId)}`;
