import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { AuditLog } from '../audit/auditLog.model';
import { EVENT_LABEL, nameMap, oid, presentInstallation, presentPhoto, roleMap, type MediaItem } from './recceReview.common';
import { CATEGORY_LABEL, RecceSubmission, STAGE_LABEL, type ReviewStage } from './recceReview.model';

/**
 * Version history and compare. Everything is read from the one submission document of the shop: the immutable `versions[]`
 * snapshots, the `reviews[]` decisions, the `reworks[]` requests and the `photos[]`. Used by the field router (own shops) and
 * the review router.
 */

export const compareQuery = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) });

const ITEM_FIELDS = ['name', 'quantity', 'width', 'height', 'unit', 'sided', 'condition', 'position', 'installationNotes', 'notes'] as const;

/** The readable number of a board: "GSB-01" from its media type and seq; a board made before numbers existed is shown by its name. */
export const boardLabel = (i: MediaItem) => (i.mediaType && i.seq ? `${i.mediaType}-${String(i.seq).padStart(2, '0')}` : i.name);

/** A board item with every field present (null / empty when never set), so the app can rely on the shape. */
export const presentItem = (i: MediaItem) => ({
  key: i.key, name: i.name, mediaType: i.mediaType ?? null, seq: i.seq ?? null, label: boardLabel(i), quantity: i.quantity ?? 1, width: i.width ?? null, height: i.height ?? null, unit: i.unit ?? 'FT', notes: i.notes ?? '',
  sided: i.sided ?? null, condition: i.condition ?? null, position: i.position ?? '', installationNotes: i.installationNotes ?? '',
});

type ReworkRow = {
  _id: Types.ObjectId; versionNo?: number | null; stage: string; kind: string; status: string; instructions: string; requestedBy: Types.ObjectId; createdAt?: Date; resolvedAt?: Date | null;
  items: { _id: Types.ObjectId; type: string; category?: string | null; mediaKey?: string | null; photo?: Types.ObjectId | null; note?: string | null; resolved?: boolean; resolvedInVersion?: number | null }[];
};
const presentRework = (r: ReworkRow, names: Map<string, string>) => ({
  id: String(r._id), versionNo: r.versionNo ?? null, stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], kind: r.kind, status: r.status, instructions: r.instructions,
  requestedBy: names.get(String(r.requestedBy)) ?? null, requestedAt: r.createdAt ?? null, resolvedAt: r.resolvedAt ?? null,
  items: r.items.map((i) => ({ id: String(i._id), type: i.type, category: i.category ?? null, categoryLabel: i.category ? CATEGORY_LABEL[i.category as keyof typeof CATEGORY_LABEL] : null, mediaKey: i.mediaKey ?? '', photo: i.photo ? String(i.photo) : null, note: i.note ?? '', resolved: !!i.resolved, resolvedInVersion: i.resolvedInVersion ?? null })),
});

type Presented = Awaited<ReturnType<typeof presentPhoto>>;

const time = (d?: Date | null) => d?.getTime() ?? 0;
/** Photo order: the person's own order, then the time it was uploaded. */
export const byPhotoOrder = (a: { order?: number | null; createdAt?: Date | null }, b: { order?: number | null; createdAt?: Date | null }) => (a.order ?? 0) - (b.order ?? 0) || time(a.createdAt) - time(b.createdAt);

async function loadAll(submissionId: Types.ObjectId | string) {
  const sub = await RecceSubmission.findById(oid(submissionId)).select('photos versions reviews reworks').lean();
  const versions = [...(sub?.versions ?? [])].sort((a, b) => a.version - b.version);
  const reviews = sub?.reviews ?? [];
  const reworks = [...(sub?.reworks ?? [])].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const photos = (sub?.photos ?? []).filter((p) => p.state !== 'DRAFT').sort(byPhotoOrder);
  const people = [...photos.flatMap((p) => [p.uploadedBy, p.removedBy]), ...reviews.map((r) => r.reviewer), ...versions.map((v) => v.submittedBy), ...reworks.map((r) => r.requestedBy)];
  const [names, roles] = await Promise.all([nameMap(people), roleMap(photos.map((p) => p.uploadedBy))]);
  const presented = new Map<string, Presented>();
  await Promise.all(photos.map(async (p) => { presented.set(String(p._id), await presentPhoto(p as never, names, { withHistory: true, roles })); }));
  return { versions, reviews, reworks, photos, names, presented };
}
type Loaded = Awaited<ReturnType<typeof loadAll>>;

const decisions = (L: Loaded, versionNo: number) =>
  L.reviews.filter((r) => r.versionNo === versionNo).sort((a, b) => a.stage.localeCompare(b.stage)).map((r) => ({
    stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], decision: r.decision, reviewer: r.reviewer ? (L.names.get(String(r.reviewer)) ?? null) : null, decidedAt: r.decidedAt ?? null, comment: r.comment ?? '',
  }));

const photosOf = (L: Loaded, ids: Types.ObjectId[]) => ids.map((i) => L.presented.get(String(i))).filter((p): p is Presented => !!p);

/** Every immutable version of one shop, oldest first. */
export async function versionHistory(submissionId: Types.ObjectId | string) {
  const L = await loadAll(submissionId);
  return L.versions.map((v, idx) => ({
    version: v.version, current: idx === L.versions.length - 1, submittedAt: v.submittedAt, submittedBy: L.names.get(String(v.submittedBy)) ?? null, notes: v.notes ?? '',
    mediaItems: (v.mediaItems as unknown as MediaItem[]).map(presentItem), installation: presentInstallation(v.installation as never), installationRecorded: !!v.installation,
    photos: photosOf(L, v.photos), addedIds: v.added.map(String), removedIds: v.removed.map(String), stages: v.stages,
    decisions: decisions(L, v.version), reworks: L.reworks.filter((r) => r.versionNo === v.version).map((r) => presentRework(r as never, L.names)),
  }));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What changed between two versions of one shop: photos, board items, installation, notes, plus each side's date and reviewer comments. */
export async function compareVersions(submissionId: Types.ObjectId | string, from: number, to: number) {
  const L = await loadAll(submissionId);
  const a = L.versions.find((v) => v.version === from);
  const b = L.versions.find((v) => v.version === to);
  if (!a || !b) throw AppError.notFound('Version not found');
  const inA = new Set(a.photos.map(String));
  const inB = new Set(b.photos.map(String));
  const byId = new Map(L.photos.map((p) => [String(p._id), p]));
  const pv = (id: string) => L.presented.get(id)!;
  const added: Presented[] = [];
  const replaced: { from: Presented; to: Presented }[] = [];
  const claimed = new Set<string>();
  for (const id of inB) {
    if (inA.has(id)) continue;
    // Follow the replaces chain back until it reaches a photo that was in the older version.
    const up = (x: string) => (byId.get(x)?.replaces ? String(byId.get(x)!.replaces) : null);
    let cur = up(id);
    for (let hops = 0; cur && !inA.has(cur) && hops < 50; hops++) cur = up(cur);
    if (cur && inA.has(cur) && !claimed.has(cur)) { claimed.add(cur); replaced.push({ from: pv(cur), to: pv(id) }); }
    else added.push(pv(id));
  }
  const removed = [...inA].filter((id) => !inB.has(id) && !claimed.has(id)).map(pv);
  const unchanged = [...inA].filter((id) => inB.has(id)).map(pv);

  const itemsA = new Map((a.mediaItems as unknown as MediaItem[]).map((i) => [i.key, presentItem(i)]));
  const itemsB = new Map((b.mediaItems as unknown as MediaItem[]).map((i) => [i.key, presentItem(i)]));
  const itemsAdded = [...itemsB.values()].filter((i) => !itemsA.has(i.key));
  const itemsRemoved = [...itemsA.values()].filter((i) => !itemsB.has(i.key));
  const changed = [...itemsB.values()].filter((i) => itemsA.has(i.key)).map((i) => {
    const o = itemsA.get(i.key)!;
    return { key: i.key, name: i.name, fields: ITEM_FIELDS.filter((f) => !same(o[f], i[f])).map((f) => ({ field: f, from: o[f] ?? null, to: i[f] ?? null })) };
  }).filter((c) => c.fields.length);

  const ia = presentInstallation(a.installation as never) as Record<string, unknown>;
  const ib = presentInstallation(b.installation as never) as Record<string, unknown>;
  const installation = Object.keys(ib).filter((k) => !same(ia[k], ib[k])).map((k) => ({ field: k, from: ia[k], to: ib[k] }));
  const notesChanged = !same(a.notes ?? '', b.notes ?? '');

  const side = (v: typeof a) => ({ version: v.version, submittedAt: v.submittedAt, submittedBy: L.names.get(String(v.submittedBy)) ?? null, reviewerComments: decisions(L, v.version).filter((d) => d.decision !== 'PENDING' && d.decision !== 'VOID') });
  return {
    from: side(a), to: side(b),
    photos: { added, replaced, unchanged, removed },
    mediaItems: { added: itemsAdded, removed: itemsRemoved, changed },
    installation, notes: notesChanged ? { from: a.notes ?? '', to: b.notes ?? '' } : null,
    changed: !!(added.length || replaced.length || removed.length || changed.length || itemsAdded.length || itemsRemoved.length || installation.length || notesChanged),
  };
}

/* ------------------------------------------------ per-photo review state and history ------------------------------------------------ */

type LivePhoto = { _id: Types.ObjectId; category: string; mediaKey?: string | null; state: string };

/**
 * Review state of each live photo for the field app. REWORK_REQUIRED when an open rework item points at the photo (or, for a REPLACE_PHOTO
 * item without a photo, at its category). APPROVED once the whole shop is approved. Otherwise PENDING.
 */
export function photoReviews(photos: LivePhoto[], openReworks: ReworkRow[], submissionStatus: string | null | undefined, names: Map<string, string>) {
  type Review = { status: 'PENDING' | 'APPROVED' | 'REWORK_REQUIRED'; openRework: null | { reworkId: string; itemId: string; note: string; stage: string; stageLabel: string; instructions: string; requestedBy: string | null; requestedAt: Date | null } };
  const out = new Map<string, Review>();
  const newestFirst = openReworks.filter((r) => r.status === 'OPEN').sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0));
  for (const p of photos) {
    let hit: null | { r: ReworkRow; i: ReworkRow['items'][number] } = null;
    for (const r of newestFirst) {
      const i = r.items.find((it) => !it.resolved && (it.photo ? String(it.photo) === String(p._id) : it.type === 'REPLACE_PHOTO' && !!it.category && it.category === p.category && (!it.mediaKey || it.mediaKey === (p.mediaKey ?? '')) && p.state === 'SUBMITTED'));
      if (i) { hit = { r, i }; break; }
    }
    out.set(String(p._id), hit
      ? { status: 'REWORK_REQUIRED', openRework: { reworkId: String(hit.r._id), itemId: String(hit.i._id), note: hit.i.note ?? '', stage: hit.r.stage, stageLabel: STAGE_LABEL[hit.r.stage as ReviewStage], instructions: hit.r.instructions, requestedBy: names.get(String(hit.r.requestedBy)) ?? null, requestedAt: hit.r.createdAt ?? null } }
      : { status: submissionStatus === 'APPROVED' && p.state === 'SUBMITTED' ? 'APPROVED' : 'PENDING', openRework: null });
  }
  return out;
}

/** One photo's revisions (replaces chain, oldest first), its timeline events and the rework requests that named it. */
export async function photoHistory(submissionId: Types.ObjectId | string, photoId: string, visibility: string[]) {
  const sid = oid(submissionId);
  const sub = await RecceSubmission.findById(sid).select('photos reworks').lean();
  const all = sub?.photos ?? [];
  const byId = new Map(all.map((p) => [String(p._id), p]));
  const start = byId.get(photoId);
  if (!start) throw AppError.notFound('Photo not found');
  let root = start;
  for (let hops = 0; root.replaces && byId.has(String(root.replaces)) && hops < 50; hops++) root = byId.get(String(root.replaces))!;
  const chain = [root];
  for (let hops = 0; hops < 50; hops++) {
    const last = chain[chain.length - 1]!;
    const next = all.find((p) => p.replaces && String(p.replaces) === String(last._id));
    if (!next) break;
    chain.push(next);
  }
  const ids = chain.map((p) => p._id);
  const events = await AuditLog.find({ entity: 'RecceSubmission', entityId: sid, 'meta.photo': { $in: ids }, 'meta.visibility': { $in: visibility } }).sort({ at: 1 }).populate('user', 'name').lean();
  const reworks = (sub?.reworks ?? []).filter((r) => r.items.some((i) => i.photo && ids.some((x) => String(x) === String(i.photo)))).sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const [names, roles] = await Promise.all([nameMap([...chain.flatMap((p) => [p.uploadedBy, p.removedBy]), ...reworks.map((r) => r.requestedBy)]), roleMap(chain.map((p) => p.uploadedBy))]);
  const revisions = await Promise.all(chain.map(async (p, i) => ({ revision: i + 1, current: i === chain.length - 1, ...(await presentPhoto(p as never, names, { withHistory: true, roles })) })));
  const isMine = (x: Types.ObjectId | null | undefined) => !!x && ids.some((i) => String(i) === String(x));
  return {
    photoId: String(start._id), revisions,
    events: events.map((l) => ({ id: String(l._id), type: l.action, label: EVENT_LABEL[l.action] ?? l.action, actor: (l.user as unknown as { name?: string } | null)?.name ?? 'Unknown', role: l.role ?? '', at: l.at, reason: l.reason ?? '', photoId: String((l.meta as { photo?: unknown } | undefined)?.photo ?? ''), version: (l.meta as { version?: number | null } | undefined)?.version ?? null })),
    reworks: reworks.flatMap((r) => r.items.filter((i) => isMine(i.photo as never)).map((i) => ({ reworkId: String(r._id), itemId: String(i._id), photoId: String(i.photo), stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], requestedBy: names.get(String(r.requestedBy)) ?? null, requestedAt: r.createdAt ?? null, note: i.note ?? '', instructions: r.instructions, resolved: !!i.resolved, resolvedInVersion: i.resolvedInVersion ?? null }))),
  };
}
