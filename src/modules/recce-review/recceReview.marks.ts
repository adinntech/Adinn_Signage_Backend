import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { objectId, type Actor } from '../../common/query';
import { BOARD_FIELD_ITEM, BOARD_FIELDS, checkRule, MARK_DECISIONS, RecceSubmission, REVIEW_STAGES, STAGE_LABEL, type MarkEntry, type ReviewStage } from './recceReview.model';
import { getConfig, REVIEWABLE, oid } from './recceReview.common';

/**
 * Per-photo and per-board answers of a reviewer ("marks"). The review screen shows every board with its angle photos; a reviewer ticks
 * photos and / or board details (media type, quantity, size) and marks them Approved, Rejected or Rework. A remark is mandatory for
 * Rejected and Rework: without it nothing is saved, so the recce person always learns what to fix and why.
 *
 * A mark is one entry per (version, stage, thing). Changing it keeps the earlier answer, with its reason, in `history` (version-wise
 * history: marks of an older version are never touched). When the stage later sends Rework, the Rejected / Rework marks that were not
 * sent yet become the rework items of that request (see `itemsFromMarks`) and turn `sent`.
 *
 * Every write is ONE atomic update on the shop's document. It is a compare-and-set on the single mark (its old decision and time) or a
 * push guarded by "no such mark yet", so two reviewers (the two stages work in parallel) never block each other and nobody can overwrite
 * another stage's mark: a reviewer writes only marks of the own stage.
 */

/** Each target may carry its OWN remark (`reason`); a target without one uses the shared `reason` of the request. */
const ownReason = z.string().trim().max(500).optional();
export const marksBody = z.object({
  stage: z.enum(REVIEW_STAGES),
  versionNo: z.coerce.number().int().min(1),
  decision: z.enum(MARK_DECISIONS),
  reason: z.string().trim().max(500).default(''),
  targets: z.array(z.union([
    z.object({ kind: z.literal('PHOTO'), photo: objectId, reason: ownReason }),
    z.object({ kind: z.literal('BOARD'), mediaKey: z.string().min(1).max(40), field: z.enum(BOARD_FIELDS), reason: ownReason }),
    z.object({ kind: z.literal('CHECK'), key: z.string().min(1).max(40), reason: ownReason }),
  ])).min(1).max(60),
}).superRefine((v, ctx) => {
  if (v.decision === 'APPROVED') return;
  v.targets.forEach((t, i) => {
    if ((t.reason || v.reason).length < 3) ctx.addIssue({ code: 'custom', path: ['targets', i, 'reason'], message: 'Write the remark of every item. A reason is needed to reject or ask for rework.' });
  });
});
export type MarksInput = z.infer<typeof marksBody>;

/** The marks that ask the recce person to do something: Rejected or Rework. */
export const isProblem = (m: { decision: string }) => m.decision === 'REJECTED' || m.decision === 'REWORK';
/** This stage's Rejected / Rework marks of one version that no rework request has carried yet. */
export const unsentProblems = (marks: MarkEntry[], stage: ReviewStage, versionNo: number) => marks.filter((m) => m.versionNo === versionNo && m.stage === stage && !m.sent && isProblem(m));

export type NewItem = { type: string; category?: string | undefined; mediaKey?: string | undefined; photo?: string | undefined; note?: string | undefined; rejected?: boolean | undefined; section?: string | undefined; label?: string | undefined };

/**
 * Rework items made from the marks. A photo mark becomes a REPLACE_PHOTO item (the photo is shown Rejected / Rework required with the
 * reason); a board mark becomes FIX_MEDIA_TYPE / FIX_QUANTITY / FIX_MEASUREMENT with the reason. Items the caller already sent for the
 * same photo or the same board field are not doubled.
 */
// A checklist mark (2026-11-25) becomes the item of its rule (checkRule): size, quantity and media type keep their FIX_* type, the rest is OTHER, with its
// section and label, so the phone shows it in that section with the remark of that item.
export function itemsFromMarks(marks: MarkEntry[], photos: { _id: Types.ObjectId; category: string; mediaKey?: string | null }[], given: NewItem[], labels: Labels = new Map()): NewItem[] {
  const out: NewItem[] = [];
  for (const m of marks) {
    if (m.photo) {
      const pid = String(m.photo);
      if (given.some((g) => g.type === 'REPLACE_PHOTO' && g.photo && String(g.photo).toLowerCase() === pid)) continue;
      const p = photos.find((x) => String(x._id) === pid);
      out.push({ type: 'REPLACE_PHOTO', photo: pid, ...(p ? { category: p.category } : {}), ...(p?.mediaKey ? { mediaKey: p.mediaKey } : {}), note: m.reason, rejected: m.decision === 'REJECTED' });
    } else if (m.check) {
      const rule = checkRule(m.check);
      out.push({ type: rule.type, section: rule.section, label: labels.get(m.check) ?? m.check, note: m.reason, rejected: m.decision === 'REJECTED' });
    } else if (m.field) {
      const type = BOARD_FIELD_ITEM[m.field];
      if (given.some((g) => g.type === type && g.mediaKey === m.mediaKey)) continue;
      out.push({ type, mediaKey: m.mediaKey ?? '', note: m.reason, rejected: m.decision === 'REJECTED' });
    }
  }
  return out;
}

/** Checklist key -> label, as the config holds them. */
type Labels = ReadonlyMap<string | null | undefined, string | null | undefined>;
type Target = MarksInput['targets'][number];
const keyOf = (t: Target) => (t.kind === 'PHOTO' ? { photo: oid(t.photo) } : t.kind === 'CHECK' ? { check: t.key } : { mediaKey: t.mediaKey, field: t.field });
const sameKey = (m: MarkEntry, t: Target) => (t.kind === 'PHOTO' ? !!m.photo && String(m.photo) === String(t.photo).toLowerCase() : t.kind === 'CHECK' ? m.check === t.key : !m.photo && !m.check && m.mediaKey === t.mediaKey && m.field === t.field);
const describe = (t: Target) => (t.kind === 'PHOTO' ? `photo:${t.photo}` : t.kind === 'CHECK' ? `check:${t.key}` : `board:${t.mediaKey}:${t.field}`);

/**
 * Writes the marks of one stage on the current version. The caller has already checked the stage rights and that the stage may still
 * answer (deciding, or approved and allowed to change). Returns what changed, for the timeline.
 */
export async function writeMarks(actor: Actor, sub: InstanceType<typeof RecceSubmission>, input: MarksInput) {
  const version = sub.versions.find((v) => v.version === input.versionNo);
  if (!version) throw AppError.notFound('Version not found');
  const inVersion = new Set(version.photos.map(String));
  // A checklist item must be one of this stage's checklist.
  const checkKeys = new Set((await getConfig()).checklist.filter((c) => c.stage === 'ALL' || c.stage === input.stage).map((c) => c.key));
  const seen = new Set<string>();
  const targets = input.targets.filter((t) => { const k = describe(t); if (seen.has(k)) return false; seen.add(k); return true; });
  for (const t of targets) {
    if (t.kind === 'PHOTO') {
      const p = sub.photos.find((x) => String(x._id) === String(t.photo).toLowerCase());
      if (!p || !inVersion.has(String(p._id))) throw AppError.badRequest('A selected photo is not part of this version');
    } else if (t.kind === 'CHECK') {
      if (!checkKeys.has(t.key)) throw AppError.badRequest('A selected checklist item is not part of this review');
    } else if (!(version.mediaItems as unknown as { key: string }[]).some((b) => b.key === t.mediaKey)) throw AppError.badRequest('A selected board is not part of this version');
  }
  const now = new Date();
  const base = { versionNo: input.versionNo, stage: input.stage };
  const guard = { _id: sub._id, currentVersion: input.versionNo, status: { $in: [...REVIEWABLE, 'APPROVED'] } };
  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  for (const t of targets) {
    const key = keyOf(t);
    const old = sub.marks.find((m) => m.versionNo === input.versionNo && m.stage === input.stage && sameKey(m, t));
    const reason = (t.reason || input.reason).trim(); // the item's own remark, else the shared one
    const next = { ...base, ...key, decision: input.decision, reason, reviewer: actor.id, reviewerRole: actor.role, at: now, sent: false };
    if (!old) {
      const r = await RecceSubmission.updateOne({ ...guard, marks: { $not: { $elemMatch: { ...base, ...key } } } } as never, { $push: { marks: { ...next, history: [] } } } as never);
      if (!r.modifiedCount) throw AppError.conflict('The submission changed while you were marking. Reload and try again.');
    } else {
      if (old.decision === input.decision && (old.reason ?? '') === reason) continue; // nothing new
      // The earlier answer moves into `history`; the change only lands while the mark is still exactly as it was read.
      const earlier = { decision: old.decision, reason: old.reason ?? '', reviewer: old.reviewer, reviewerRole: old.reviewerRole, at: old.at, changedAt: now };
      const r = await RecceSubmission.updateOne(
        { ...guard, marks: { $elemMatch: { ...base, ...key, decision: old.decision, at: old.at } } } as never,
        { $set: { 'marks.$.decision': input.decision, 'marks.$.reason': reason, 'marks.$.reviewer': actor.id, 'marks.$.reviewerRole': actor.role, 'marks.$.at': now, 'marks.$.sent': false }, $push: { 'marks.$.history': earlier } } as never,
      );
      if (!r.modifiedCount) throw AppError.conflict('This mark was changed at the same time. Reload and try again.');
    }
    changes.push({ field: `${STAGE_LABEL[input.stage]}: ${describe(t)}`, oldValue: old?.decision ?? null, newValue: input.decision });
  }
  return { changes, applied: targets.length };
}

/** Marks as the review screen reads them: names instead of ids, history included. All versions, oldest first. */
export function presentMarks(marks: MarkEntry[], names: Map<string, string>, labels: Labels = new Map()) {
  const who = (id: unknown) => (id ? (names.get(String(id)) ?? null) : null);
  return [...marks].sort((a, b) => a.versionNo - b.versionNo || (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0)).map((m) => ({
    id: m.photo ? `p:${String(m.photo)}:${m.stage}:${m.versionNo}` : m.check ? `c:${m.check}:${m.stage}:${m.versionNo}` : `b:${m.mediaKey}:${m.field}:${m.stage}:${m.versionNo}`,
    versionNo: m.versionNo, stage: m.stage, stageLabel: STAGE_LABEL[m.stage as ReviewStage],
    kind: m.photo ? ('PHOTO' as const) : m.check ? ('CHECK' as const) : ('BOARD' as const), photo: m.photo ? String(m.photo) : null, mediaKey: m.mediaKey ?? '', field: m.field ?? null, check: m.check ?? null, label: m.check ? (labels.get(m.check) ?? m.check) : null,
    decision: m.decision, reason: m.reason ?? '', reviewer: who(m.reviewer), at: m.at ?? null, sent: !!m.sent,
    history: (m.history ?? []).map((h) => ({ decision: h.decision ?? null, reason: h.reason ?? '', reviewer: who(h.reviewer), at: h.at ?? null, changedAt: h.changedAt ?? null })),
  }));
}
