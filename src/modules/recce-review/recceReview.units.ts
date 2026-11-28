import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { objectId, type Actor } from '../../common/query';
import { discardStoredFiles, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import {
  assertCanSeeProject, assertProjectOpen, clientNameFor, EDITABLE_UNIT, flatItems, getConfig, link, logEvent, mediaTypeOf, mergeFieldItems, nameMap, presentPhoto, REVIEWABLE, roleMap, stageOf, unitIdOf, type MediaItem,
} from './recceReview.common';
import { CATEGORY_LABEL, MEASURE_FIELDS, RecceSubmission, REVIEW_STAGES, STAGE_LABEL, type ReviewStage } from './recceReview.model';
import { afterDecision, notifyFinalApproval, workspace } from './recceReview.review';

/**
 * Unit-wise review on the shop's own record: mediaItems[] → units[] → photos / versions / reviews / reworks.
 * The field app (unchanged) sends flat lines and flat photos; its draft is merged into the units (common.mergeFieldItems) and
 * `syncAfterSubmit` turns every submit into unit versions (a new version only for units that are new or were sent back).
 * Reviewers decide each unit for their own stage (`decideUnits`). The shop status, pending stage, shop-level reviews and the
 * field app's rework list are rolled up from the units. Every write is one compare-and-set on the shop's `rev`, retried when
 * another write landed first.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;

const OPEN = ['SUBMITTED', 'UNDER_REVIEW'];
const unitLabel = (m: Row, u: Row) => `${m.name ?? m.mediaType ?? m.mediaKey} · ${u.unitId}`;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x ?? null));
const unitsOf = (items: Row[]) => (items ?? []).flatMap((m: Row) => (m.units ?? []).map((u: Row) => ({ m, u })));
const reviewOf = (u: Row, stage: string, version = u.currentVersion) => (u.reviews ?? []).find((r: Row) => r.version === version && r.stage === stage);
const currentReviews = (u: Row) => (u.reviews ?? []).filter((r: Row) => r.version === u.currentVersion);
const reworkIdOf = (u: Row, version: number, stage: string) => `rw_${String(u.unitId).toLowerCase()}_v${version}_${stage.toLowerCase()}`;

/** True when the shop is reviewed unit by unit (it has a submitted unit, or older unit data still to be moved). */
export const hasUnits = (sub: Row) => !!sub?.boards?.length || unitsOf(sub?.mediaItems ?? []).some(({ u }) => u.currentVersion > 0);

/* ------------------------------------------------ flat submit (field app) → unit versions ------------------------------------------------ */

/** The unit a flat photo belongs to: its unitKey when the app sent one, otherwise Unit 1 of its media line (or of the first line). */
function targetOf(p: Row, items: Row[]): { m: Row; u: Row } | null {
  if (p.unitKey) for (const m of items) for (const u of m.units ?? []) if (u.fieldKey === p.unitKey || `${m.mediaKey}-${u.unitId}` === p.unitKey) return { m, u };
  const m = items.find((x) => x.mediaKey === p.mediaKey) ?? items[0];
  return m?.units?.[0] ? { m, u: m.units[0] } : null;
}

function changedFieldsOf(prev: Row, next: Row, photosById: Map<string, Row>) {
  if (!prev) return [];
  const out: string[] = [];
  for (const k of ['width', 'height']) if ((prev.measurement?.[k] ?? null) !== (next.measurement?.[k] ?? null)) out.push(`measurement.${k}`);
  if ((prev.installationType ?? null) !== (next.installationType ?? null)) out.push('installationType');
  const ans = (l: Row[]) => new Map((l ?? []).map((a: Row) => [a.questionId, a.answer ?? '']));
  const a = ans(prev.answers);
  const b = ans(next.answers);
  for (const q of new Set([...a.keys(), ...b.keys()])) if ((a.get(q) ?? '') !== (b.get(q) ?? '')) out.push(`answers.${q}`);
  const before = new Set((prev.photoIds ?? []).map(String));
  for (const id of next.photoIds ?? []) if (!before.has(String(id))) { const c = photosById.get(String(id))?.category; if (c && !out.includes(`photos.${c}`)) out.push(`photos.${c}`); }
  return out;
}

/**
 * Applies one flat shop version to the media items. Line fields and editable units come from the version's snapshot; every unit's
 * photos are refreshed (old ones kept); units that are new or were sent back get a new version with pending reviews, and their open
 * rework is marked as resubmitted. Approved and waiting units stay as they are.
 */
function applyFlatVersion(items: Row[], flat: Row, allPhotos: Row[], stages: ReviewStage[]) {
  const merged = mergeFieldItems(items, (flat.mediaItems ?? []) as MediaItem[]);
  const inVersion = new Set((flat.photos ?? []).map(String));
  const nonDraft = allPhotos.filter((p) => p.state !== 'DRAFT');
  const byId = new Map(nonDraft.map((p) => [String(p._id), p]));
  const touched: { m: Row; u: Row }[] = [];
  for (const m of merged) {
    for (const u of m.units) {
      const mine = (p: Row) => targetOf(p, merged)?.u === u;
      u.photos = nonDraft.filter(mine).map((p) => clone(p));
      if (u.currentVersion > 0 && !EDITABLE_UNIT.includes(u.status)) continue;
      const prev = (u.versions ?? []).at(-1);
      const version = (u.currentVersion ?? 0) + 1;
      const next = {
        version, shopVersion: flat.version, submittedBy: flat.submittedBy, submittedAt: flat.submittedAt, installationType: u.installationType ?? null,
        measurement: u.measurement, answers: u.answers ?? [], photoIds: nonDraft.filter((p) => inVersion.has(String(p._id)) && mine(p)).map((p) => p._id),
      };
      for (const rw of u.reworks ?? []) if (rw.status === 'OPEN') Object.assign(rw, { status: 'RESUBMITTED', resolvedInVersion: version, resolvedAt: flat.submittedAt });
      (u.versions ??= []).push({ ...next, changedFields: changedFieldsOf(prev, next, byId) });
      (u.reviews ??= []).push(...stages.map((stage) => ({ version, stage, decision: 'PENDING', comment: '', checklist: [] })));
      Object.assign(u, { currentVersion: version, status: 'SUBMITTED', approvedAt: null });
      touched.push({ m, u });
    }
  }
  items.splice(0, items.length, ...merged);
  return touched;
}

/** A unit's status from its current version's reviews. */
function unitOutcome(u: Row) {
  const rs = currentReviews(u);
  if (!u.currentVersion || !rs.length) return;
  if (rs.some((r: Row) => r.decision === 'REJECTED')) {
    for (const r of rs) if (r.decision === 'PENDING') r.decision = 'VOID';
    if (u.status !== 'REJECTED') u.status = 'REWORK';
    u.approvedAt = null;
  } else if (rs.every((r: Row) => r.decision === 'APPROVED')) {
    u.status = 'APPROVED';
    u.approvedAt = rs.reduce((mx: Date | null, r: Row) => (r.decidedAt && (!mx || new Date(r.decidedAt) > mx) ? new Date(r.decidedAt) : mx), null);
  } else if (OPEN.includes(u.status)) {
    u.status = rs.some((r: Row) => r.decision !== 'PENDING') ? 'UNDER_REVIEW' : 'SUBMITTED';
  }
}

export function summaryOf(items: Row[]) {
  const all = unitsOf(items).map((x) => x.u);
  return {
    units: all.length, approved: all.filter((u) => u.status === 'APPROVED').length, underReview: all.filter((u) => OPEN.includes(u.status)).length,
    rework: all.filter((u) => u.status === 'REWORK' || u.status === 'REJECTED').length, draft: all.filter((u) => u.status === 'DRAFT').length,
  };
}

/**
 * Shop-level state from the units: status, pending stage, each stage's decision on the current shop version (kept for the inbox,
 * dashboards and lists) and, when the round ends with units sent back, the rework list the field app answers.
 */
function rollUp(sub: Row, items: Row[], stages: ReviewStage[]) {
  const units = unitsOf(items).filter((x) => x.u.currentVersion > 0);
  if (!units.length) return null;
  const open = units.filter((x) => OPEN.includes(x.u.status));
  let status: string;
  if (units.every((x) => x.u.status === 'APPROVED')) status = 'APPROVED';
  else if (open.length) status = units.some((x) => currentReviews(x.u).some((r: Row) => r.decision !== 'PENDING') && x.u.versions.at(-1)?.shopVersion === sub.currentVersion) ? 'UNDER_REVIEW' : 'SUBMITTED';
  else if (units.some((x) => x.u.status === 'REWORK')) status = 'REWORK_REQUIRED';
  else status = 'REJECTED';
  const pendingStage = open.length ? (stages.find((s) => open.some((x) => reviewOf(x.u, s)?.decision === 'PENDING')) ?? null) : null;

  // Each stage on the current shop version: still deciding (PENDING), done (APPROVED / REWORK) or not needed (VOID).
  const stageDecision = (s: ReviewStage) => {
    const mine = units.map((x) => reviewOf(x.u, s)).filter(Boolean);
    if (status === 'APPROVED') return 'APPROVED';
    if (mine.some((r: Row) => r.decision === 'PENDING')) return status === 'REWORK_REQUIRED' ? 'VOID' : 'PENDING';
    if (mine.some((r: Row) => r.decision === 'REJECTED')) return status === 'REJECTED' ? 'REJECTED' : 'REWORK';
    return mine.every((r: Row) => r.decision === 'APPROVED') ? 'APPROVED' : 'VOID';
  };
  const lastBy = (s: ReviewStage) => units.map((x) => reviewOf(x.u, s)).filter((r: Row) => r?.decidedAt).sort((a: Row, b: Row) => +new Date(b.decidedAt) - +new Date(a.decidedAt))[0];
  const reviews = clone(sub.reviews ?? []).map((r: Row) => {
    if (r.versionNo !== sub.currentVersion || !stages.includes(r.stage)) return r;
    const d = stageDecision(r.stage);
    const by = lastBy(r.stage);
    return { ...r, decision: d, ...(d !== 'PENDING' && by ? { reviewer: by.reviewer, reviewerRole: by.reviewerRole, decidedAt: by.decidedAt, comment: (by.comment ?? '').slice(0, 2000) } : {}) };
  });

  // Rework list for the field app (one entry per round): every rejected photo / measurement of the units sent back.
  let rework: Row = null;
  if (status === 'REWORK_REQUIRED' && sub.status !== 'REWORK_REQUIRED') {
    const list: Row[] = [];
    const lines: string[] = [];
    let by: Row = null;
    for (const { m, u } of units.filter((x) => x.u.status === 'REWORK')) {
      for (const r of currentReviews(u).filter((x: Row) => x.decision === 'REJECTED')) {
        by ??= r;
        const rw = (u.reworks ?? []).find((x: Row) => x.reworkId === r.reworkId);
        const its = rw?.items ?? [];
        lines.push(`${unitLabel(m, u)}: ${r.comment || its.map((i: Row) => i.reason).join(', ')}`);
        for (const it of its) {
          if (it.kind === 'PHOTO') list.push({ _id: new Types.ObjectId(), type: 'REPLACE_PHOTO', photo: it.photoId, category: it.category, mediaKey: m.mediaKey, note: `${u.unitId}: ${it.reason}`.slice(0, 500), resolved: false });
          else list.push({ _id: new Types.ObjectId(), type: 'FIX_MEASUREMENT', mediaKey: m.mediaKey, note: `${u.unitId} ${it.field ?? ''}: ${it.reason}`.slice(0, 500), resolved: false });
        }
        if (!its.length) list.push({ _id: new Types.ObjectId(), type: 'OTHER', mediaKey: m.mediaKey, note: `${u.unitId}: ${r.comment}`.slice(0, 500), resolved: false });
      }
    }
    rework = { _id: new Types.ObjectId(), versionNo: sub.currentVersion, stage: by?.stage ?? 'CS', kind: 'REWORK', instructions: lines.join('\n').slice(0, 2000) || 'Correct the rejected units', items: list.slice(0, 60), status: 'OPEN', requestedBy: by?.reviewer, createdAt: new Date() };
  }
  return { status, pendingStage, reviews, rework, summary: summaryOf(items), final: status === 'APPROVED' && sub.status !== 'APPROVED' };
}

/** Writes the media items + rolled-up shop state with a compare-and-set on `rev`. Returns null when another write landed first. */
async function commit(sub: Row, items: Row[], stages: ReviewStage[], extra: { requireReviewable?: boolean } = {}) {
  const roll = rollUp(sub, items, stages);
  const set: Record<string, unknown> = { mediaItems: items, summary: summaryOf(items) };
  if (roll && (!extra.requireReviewable || OPEN.includes(sub.status))) {
    Object.assign(set, { status: roll.status, pendingStage: roll.pendingStage, reviews: roll.reviews });
    if (roll.final) set.finalApprovedAt = new Date();
  }
  const filter: Record<string, unknown> = { _id: sub._id, rev: sub.rev };
  if (extra.requireReviewable) filter.status = { $in: REVIEWABLE };
  const r = await RecceSubmission.updateOne(
    filter,
    { $set: set, $unset: { boards: 1 }, ...(roll?.rework && set.status === 'REWORK_REQUIRED' ? { $push: { reworks: roll.rework } } : {}), $inc: { rev: 1 } },
    { runValidators: false, strict: false },
  );
  return r.modifiedCount ? roll : null;
}

/** The shop's units, moving older records on the fly (unit data in `boards`, or a shop reviewed the old shop-level way). */
function itemsOf(sub: Row): Row[] {
  if (sub.boards?.length) return fromBoards(sub);
  const items = (sub.mediaItems ?? []).filter((m: Row) => m.mediaKey);
  if (items.length && items.length === (sub.mediaItems ?? []).length) return clone(items);
  if (sub.currentVersion > 0) return buildFromLegacy(sub);
  return mergeFieldItems([], flatItems(sub.mediaItems));
}

/** The stored media items of a shop (older records moved on the fly). Used by the field draft merge. */
export const storedItemsOf = (sub: Row): Row[] => itemsOf(sub);

/* ------------------------------------------------ after a field submit ------------------------------------------------ */

/** Called right after the field app submits a version: new / sent-back units get a unit version waiting for both stages. */
export async function syncAfterSubmit(submissionId: Types.ObjectId | string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await RecceSubmission.findById(submissionId).lean<Row>().exec();
    if (!sub?.currentVersion) return;
    const flat = (sub.versions ?? []).find((v: Row) => v.version === sub.currentVersion);
    if (!flat) return;
    const stages = (flat.stages ?? REVIEW_STAGES) as ReviewStage[];
    let items: Row[];
    if (hasUnits(sub)) {
      items = itemsOf(sub);
      applyFlatVersion(items, flat, sub.photos ?? [], stages);
    } else {
      // Not moved yet: build the whole history (the new version is the last one in it), so nothing is lost.
      items = buildFromLegacy(sub);
    }
    if (await commit(sub, items, stages)) return;
  }
  console.error('unit sync failed after retries', String(submissionId));
}

/* ------------------------------------------------ unit decisions ------------------------------------------------ */

/** boardKey = mediaItems[].mediaKey, unitKey = units[].unitId (the web keeps these names). */
const unitRef = z.object({ boardKey: z.string().trim().min(1).max(20), unitKey: z.string().trim().min(1).max(20), versionNo: z.coerce.number().int().min(1) });
export const unitDecisionBody = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  units: z.array(unitRef).min(1).max(50),
  comment: z.string().trim().max(1500).default(''),
  rejectMode: z.enum(['PHOTO', 'MEASUREMENT', 'BOTH']).optional(),
  checklist: z.array(z.object({ key: z.string().max(40), passed: z.boolean() })).max(30).default([]),
  /** REJECT: what is wrong in each unit (photo id or measurement field), with a reason. */
  items: z.array(z.object({ boardKey: z.string().max(20), unitKey: z.string().max(20), kind: z.enum(['PHOTO', 'MEASUREMENT']), ref: objectId.optional(), field: z.enum(MEASURE_FIELDS).optional(), reason: z.string().trim().min(3, 'Give a reason').max(500) })).max(200).default([]),
});
export type UnitDecisionInput = z.infer<typeof unitDecisionBody>;
export const submissionParam = z.object({ id: objectId });

/** The reviewer decides one or more units of a shop for their own stage. */
export async function decideUnits(actor: Actor, id: string, input: UnitDecisionInput) {
  const stage = stageOf(actor.role);
  if (!stage) throw AppError.forbidden('Only Client Servicing or Recce Operations can review units');
  const sub = await RecceSubmission.findById(id).select('project').lean();
  if (!sub) throw AppError.notFound('Submission not found');
  await assertCanSeeProject(actor, sub.project);
  await assertProjectOpen(sub.project);
  await applyUnitDecisions(id, actor, stage, input, { notify: true });
  return workspace(actor, id);
}

/** Validation and the write, without the access checks (also used by the demo seed). */
export async function applyUnitDecisions(id: string | Types.ObjectId, actor: Actor, stage: ReviewStage, input: UnitDecisionInput, opts: { notify: boolean; at?: Date }) {
  const cfg = await getConfig();
  const labels = new Map(cfg.checklist.map((c) => [c.key, c.label]));
  const checklist = input.checklist.filter((c) => labels.has(c.key)).map((c) => ({ key: c.key, label: labels.get(c.key)!, passed: c.passed }));
  if (input.decision === 'APPROVE') {
    const failed = cfg.checklist.filter((c) => (c.stage === 'ALL' || c.stage === stage) && !(c.gps && !cfg.requireGps)).filter((c) => !checklist.find((x) => x.key === c.key)?.passed);
    if (failed.length) throw AppError.badRequest(`Tick every checklist item before approving: ${failed.map((f) => f.label).join(', ')}`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await RecceSubmission.findById(id).lean<Row>().exec();
    if (!sub) throw AppError.notFound('Submission not found');
    if (!REVIEWABLE.includes(sub.status)) throw AppError.conflict('This shop is not waiting for review');
    const items = itemsOf(sub);
    const at = opts.at ?? new Date();
    const decided: { m: Row; u: Row; r: Row; rw: Row }[] = [];
    for (const ref of input.units) {
      const m = items.find((x: Row) => x.mediaKey === ref.boardKey);
      const u = m?.units.find((x: Row) => x.unitId === ref.unitKey);
      if (!m || !u) throw AppError.notFound(`Unit ${ref.boardKey}/${ref.unitKey} not found`);
      if (u.currentVersion !== ref.versionNo) throw AppError.conflict(`${unitLabel(m, u)} is on version ${u.currentVersion} now. Reload before deciding.`);
      if (!OPEN.includes(u.status)) throw AppError.conflict(`${unitLabel(m, u)} is not waiting for review`);
      const v = u.versions.at(-1);
      const r = reviewOf(u, stage);
      if (!r) throw AppError.badRequest(`${STAGE_LABEL[stage]} is not part of this review`);
      if (r.decision !== 'PENDING') throw AppError.conflict(`${STAGE_LABEL[stage]} has already decided ${unitLabel(m, u)} V${u.currentVersion}`);
      const flat = (sub.versions ?? []).find((x: Row) => x.version === v?.shopVersion);
      if (flat?.sequential) {
        const order = (flat.stages ?? []) as string[];
        const before = order.slice(0, order.indexOf(stage));
        if (before.some((s) => (reviewOf(u, s)?.decision ?? 'APPROVED') !== 'APPROVED')) throw AppError.conflict('An earlier review stage must approve this unit first');
      }
      let rw: Row = null;
      if (input.decision === 'REJECT') {
        const its = input.items.filter((i) => i.boardKey === m.mediaKey && i.unitKey === u.unitId).map((i) => {
          if (i.kind === 'PHOTO') {
            if (!i.ref || !(v?.photoIds ?? []).map(String).includes(i.ref.toLowerCase())) throw AppError.badRequest(`A chosen photo is not part of ${unitLabel(m, u)} V${u.currentVersion}`);
            const p = (u.photos ?? []).find((x: Row) => String(x._id) === i.ref!.toLowerCase());
            return { kind: 'PHOTO', photoId: new Types.ObjectId(i.ref), category: p?.category, reason: i.reason };
          }
          return { kind: 'MEASUREMENT', field: i.field ?? 'both', reason: i.reason };
        });
        if (!its.length && input.comment.length < 5) throw AppError.badRequest(`Say what is wrong in ${unitLabel(m, u)}: choose a photo or measurement, or write a comment`);
        rw = { reworkId: reworkIdOf(u, u.currentVersion, stage), sourceVersion: u.currentVersion, stage, requestedBy: new Types.ObjectId(actor.id), requestedAt: at, status: 'OPEN', items: its };
        (u.reworks ??= []).push(rw);
      }
      Object.assign(r, {
        decision: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewer: new Types.ObjectId(actor.id), reviewerRole: actor.role, decidedAt: at, comment: input.comment,
        checklist: input.decision === 'APPROVE' ? checklist : [],
        ...(rw ? { reworkId: rw.reworkId, rejectMode: input.rejectMode ?? (rw.items.some((i: Row) => i.kind === 'PHOTO') && rw.items.some((i: Row) => i.kind === 'MEASUREMENT') ? 'BOTH' : rw.items.some((i: Row) => i.kind === 'MEASUREMENT') ? 'MEASUREMENT' : 'PHOTO') } : {}),
      });
      unitOutcome(u);
      decided.push({ m, u, r, rw });
    }
    const flat = (sub.versions ?? []).find((x: Row) => x.version === sub.currentVersion);
    const stages = (flat?.stages ?? REVIEW_STAGES) as ReviewStage[];
    const roll = await commit(sub, items, stages, { requireReviewable: true });
    if (!roll) continue;

    for (const { m, u, r, rw } of decided) {
      await logEvent(actor, {
        submission: sub._id, project: sub.project, site: sub.site, type: r.decision === 'APPROVED' ? 'UNIT_APPROVED' : 'UNIT_REJECTED', version: sub.currentVersion, mediaKey: `${m.mediaKey}/${u.unitId}`, visibility: 'ALL',
        reason: r.decision === 'REJECTED' ? [r.comment, ...(rw?.items ?? []).map((i: Row) => `${i.kind === 'PHOTO' ? (CATEGORY_LABEL[i.category as keyof typeof CATEGORY_LABEL] ?? 'Photo') : `Measurement (${i.field})`}: ${i.reason}`)].filter(Boolean).join('; ').slice(0, 1000) : r.comment || undefined,
        changes: [{ field: `${unitLabel(m, u)} V${u.currentVersion}.${stage}`, oldValue: 'PENDING', newValue: r.decision }],
      });
    }
    if (roll.final) await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'FINAL_APPROVAL', version: sub.currentVersion });
    if (opts.notify && (roll.status === 'REWORK_REQUIRED' || roll.status === 'APPROVED') && roll.status !== sub.status) {
      const fresh = await RecceSubmission.findById(sub._id);
      if (fresh) {
        const back = unitsOf(items).filter((x) => x.u.status === 'REWORK').map((x) => unitLabel(x.m, x.u));
        await afterDecision(actor, fresh, { versionNo: sub.currentVersion, stage, decision: roll.status === 'APPROVED' ? 'APPROVE' : 'REWORK', comment: roll.status === 'APPROVED' ? '' : (roll.rework?.instructions ?? ''), title: roll.status === 'APPROVED' ? 'Final approval' : 'Rework required', tone: roll.status === 'APPROVED' ? 'good' : 'warn', extra: back.length ? [{ label: 'Units to correct', value: back.join(', ') }] : [] }).catch((e) => console.error('unit decision notify failed', e));
        if (roll.status === 'APPROVED') await notifyFinalApproval(actor, fresh, sub.currentVersion, stages).catch(() => undefined);
      }
    }
    return roll;
  }
  throw AppError.conflict('The shop changed while you were deciding. Reload and try again.');
}

/* ------------------------------------------------ voice note on a unit rejection ------------------------------------------------ */

export const voiceBody = unitRef;

export async function addUnitVoiceNote(actor: Actor, id: string, ref: z.infer<typeof unitRef>, file: UploadedFile | undefined) {
  const stage = stageOf(actor.role);
  if (!stage) throw AppError.forbidden('Only Client Servicing or Recce Operations can add a review voice note');
  if (!file) throw AppError.badRequest('Attach the voice note file');
  const sub = await RecceSubmission.findById(id).select('project site mediaItems').lean<Row>().exec();
  if (!sub) throw AppError.notFound('Submission not found');
  await assertCanSeeProject(actor, sub.project);
  const mi = (sub.mediaItems ?? []).findIndex((m: Row) => m.mediaKey === ref.boardKey);
  const ui = mi >= 0 ? (sub.mediaItems[mi].units ?? []).findIndex((u: Row) => u.unitId === ref.unitKey) : -1;
  const ri = ui >= 0 ? (sub.mediaItems[mi].units[ui].reviews ?? []).findIndex((r: Row) => r.version === ref.versionNo && r.stage === stage) : -1;
  const review = ri >= 0 ? sub.mediaItems[mi].units[ui].reviews[ri] : null;
  if (!review || String(review.reviewer) !== actor.id || review.decision !== 'REJECTED') throw AppError.conflict(`Add a voice note only to your own ${STAGE_LABEL[stage]} rejection`);
  if (review.voiceNote?.key) throw AppError.conflict('A voice note is already attached to this decision');
  const [project, site] = await Promise.all([Project.findById(sub.project).select('code client clientDetails').lean(), Site.findById(sub.site).select('siteCode').lean()]);
  const stored = await storeEmbeddedFile({
    category: 'RECCE_REVIEW_VOICE_NOTE', clientName: (project ? await clientNameFor(project) : null) ?? 'Client', folderKey: `${project?.code ?? 'project'}_${site?.siteCode ?? 'shop'}`,
    file, actor, workflowAuthorized: true, owner: { entity: 'RecceSubmission', id: sub._id },
  });
  const unitPath = `mediaItems.${mi}.units.${ui}`;
  const path = `${unitPath}.reviews.${ri}.voiceNote`;
  const r = await RecceSubmission.updateOne({ _id: sub._id, [`${path}.key`]: { $exists: false }, [`${unitPath}.unitId`]: ref.unitKey }, { $set: { [path]: stored } });
  if (!r.modifiedCount) {
    await discardStoredFiles([stored]);
    throw AppError.conflict('The shop changed. Reload and try again.');
  }
  await logEvent(actor, { submission: sub._id, project: sub.project, site: sub.site, type: 'VOICE_NOTE_ADDED', version: ref.versionNo, mediaKey: `${ref.boardKey}/${ref.unitKey}` });
  return { attached: true };
}

/* ------------------------------------------------ admin override / reopen ------------------------------------------------ */

async function writeItems(id: Types.ObjectId, rev: number, items: Row[]) {
  const r = await RecceSubmission.updateOne({ _id: id, rev }, { $set: { mediaItems: items, summary: summaryOf(items) }, $unset: { boards: 1 }, $inc: { rev: 1 } }, { strict: false });
  return r.modifiedCount > 0;
}

/** Admin override of the shop: every unit still waiting is decided the same way (with the reason), so the units match the shop. */
export async function overrideUnits(id: Types.ObjectId, actor: Actor, action: 'APPROVE' | 'REJECT', reason: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await RecceSubmission.findById(id).lean<Row>().exec();
    if (!sub || !hasUnits(sub)) return;
    const items = itemsOf(sub);
    for (const { u } of unitsOf(items)) {
      if (!OPEN.includes(u.status)) continue;
      for (const r of currentReviews(u)) {
        if (r.decision !== 'PENDING') continue;
        Object.assign(r, { decision: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewer: new Types.ObjectId(actor.id), reviewerRole: actor.role, decidedAt: new Date(), comment: reason, override: { by: new Types.ObjectId(actor.id), reason } });
      }
      if (action === 'REJECT') u.status = 'REJECTED';
      unitOutcome(u);
    }
    if (await writeItems(id, sub.rev, items)) return;
  }
}

/** Reopen: units that were rejected (or the whole approved shop) go back to the field person for a new unit version. */
export async function reopenUnits(id: Types.ObjectId, previousStatus: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await RecceSubmission.findById(id).lean<Row>().exec();
    if (!sub || !hasUnits(sub)) return;
    const items = itemsOf(sub);
    for (const { u } of unitsOf(items)) {
      if (!u.currentVersion) continue;
      for (const r of currentReviews(u)) if (r.decision === 'PENDING') r.decision = 'VOID';
      if (u.status === 'REJECTED' || OPEN.includes(u.status) || previousStatus === 'APPROVED') u.status = 'REWORK';
    }
    if (await writeItems(id, sub.rev, items)) return;
  }
}

/* ------------------------------------------------ moving older records ------------------------------------------------ */

const UNIT_STATUS_OF: Record<string, string> = { IN_PROGRESS: 'DRAFT', REWORK_REQUIRED: 'REWORK' };
const answersOf = (l: Row[]) => (l ?? []).map((a: Row) => ({ questionId: a.questionId ?? a.key, question: a.question, answer: a.answer }));

/**
 * Converts the earlier unit record (`boards[]` → units → versions[] → reviews[] → items[]) into mediaItems → units with
 * flat reviews (by version) and reworks. The field app's current draft lines are merged on top.
 */
export function fromBoards(sub: Row): Row[] {
  const flat = flatItems(sub.mediaItems);
  const items: Row[] = (sub.boards ?? []).map((b: Row) => {
    const line = flat.find((f) => f.key === b.key);
    const sideType = b.sided === 'DOUBLE' ? 'DOUBLE' : 'SINGLE';
    return {
      mediaKey: b.key, mediaType: mediaTypeOf(b.name), sideType, quantity: b.quantity ?? b.units?.length ?? 1, name: b.name ?? line?.name,
      condition: b.condition ?? line?.condition ?? undefined, position: b.position ?? line?.position ?? undefined, notes: line?.notes ?? undefined, installationNotes: line?.installationNotes ?? undefined,
      units: (b.units ?? []).map((u: Row) => {
        const unitId = unitIdOf(sideType, u.unitNo);
        const photosById = new Map((u.photos ?? []).map((p: Row) => [String(p._id), p]));
        const reviews: Row[] = [];
        const reworks: Row[] = [];
        const versions = (u.versions ?? []).map((v: Row, i: number, all: Row[]) => {
          const later = all[i + 1];
          for (const r of v.reviews ?? []) {
            let reworkId: string | undefined;
            if (r.decision === 'REJECTED') {
              reworkId = reworkIdOf({ unitId }, v.version, r.stage);
              reworks.push({
                reworkId, sourceVersion: v.version, stage: r.stage, requestedBy: r.reviewer, requestedAt: r.decidedAt, status: later ? 'RESUBMITTED' : u.status === 'REJECTED' ? 'CANCELLED' : 'OPEN',
                items: (r.items ?? []).map((it: Row) => (it.kind === 'PHOTO' ? { kind: 'PHOTO', photoId: it.ref, category: it.category, reason: it.reason } : { kind: 'MEASUREMENT', field: it.field ?? 'both', reason: it.reason })),
                resolvedInVersion: later?.version, resolvedAt: later?.submittedAt,
              });
            }
            reviews.push({ version: v.version, stage: r.stage, decision: r.decision, reviewer: r.reviewer, reviewerRole: r.reviewerRole, decidedAt: r.decidedAt, comment: r.comment ?? '', checklist: r.checklist ?? [], rejectMode: r.rejectMode, reworkId, voiceNote: r.voiceNote, override: r.override });
          }
          const next = { measurement: v.measurement, answers: answersOf(v.answers), photoIds: v.photos ?? [] };
          const prev = all[i - 1];
          return {
            version: v.version, shopVersion: v.shopVersion, submittedBy: v.submittedBy, submittedAt: v.submittedAt, installationType: null, ...next,
            changedFields: prev ? changedFieldsOf({ measurement: prev.measurement, answers: answersOf(prev.answers), photoIds: prev.photos ?? [] }, next, photosById) : [],
          };
        });
        const fieldUnit = line?.units?.find((x) => x.unitNo === u.unitNo);
        return {
          unitId, unitNo: u.unitNo, fieldKey: fieldUnit?.key, status: UNIT_STATUS_OF[u.status] ?? u.status, currentVersion: u.currentVersion ?? 0, approvedAt: u.approvedAt,
          installationType: null, measurement: u.measurement, answers: answersOf(u.answers), notes: u.notes, photos: u.photos ?? [], versions, reviews, reworks,
        };
      }),
    };
  });
  return mergeFieldItems(items, flat);
}

/**
 * Builds the units of a shop reviewed the old way (shop-level reviews and item decisions): each shop version becomes a unit version
 * for the units it (re)submitted, and that version's stage decisions apply to those units, with the rejected photos / measurements
 * that belong to each unit. Nothing of the flat record is changed.
 */
export function buildFromLegacy(sub: Row): Row[] {
  // A first submit on the new record starts from its DRAFT units (keeps what the draft holds, eg installationType).
  const drafts = (sub.mediaItems ?? []).filter((m: Row) => m.mediaKey && (m.units ?? []).every((u: Row) => !u.currentVersion));
  const items: Row[] = drafts.length === (sub.mediaItems ?? []).length ? clone(drafts) : [];
  const versions = [...(sub.versions ?? [])].sort((a: Row, b: Row) => a.version - b.version);
  for (const flat of versions) {
    const stages = (flat.stages ?? REVIEW_STAGES) as ReviewStage[];
    const touched = applyFlatVersion(items, flat, sub.photos ?? [], stages);
    const shopReviews = (sub.reviews ?? []).filter((r: Row) => r.versionNo === flat.version);
    const itemRows = (sub.itemReviews ?? []).filter((i: Row) => i.versionNo === flat.version && i.decision === 'REJECTED');
    for (const { m, u } of touched) {
      const v = u.versions.at(-1);
      for (const r of currentReviews(u)) {
        const old = shopReviews.find((x: Row) => x.stage === r.stage);
        if (!old || old.decision === 'PENDING') continue;
        const rejected = old.decision === 'REJECTED' || old.decision === 'REWORK';
        Object.assign(r, { decision: old.decision === 'VOID' ? 'VOID' : rejected ? 'REJECTED' : 'APPROVED', reviewer: old.reviewer, reviewerRole: old.reviewerRole, decidedAt: old.decidedAt, comment: old.comment ?? '', checklist: old.checklist ?? [], ...(old.override?.reason ? { override: old.override } : {}) });
        if (!rejected) continue;
        const its = itemRows.filter((i: Row) => i.stage === r.stage).flatMap((i: Row) => {
          if (i.kind === 'PHOTO') return (v.photoIds ?? []).map(String).includes(String(i.ref)) ? [{ kind: 'PHOTO', photoId: i.ref, category: (u.photos ?? []).find((p: Row) => String(p._id) === String(i.ref))?.category, reason: i.reason || 'Rejected' }] : [];
          return i.ref === m.mediaKey || String(i.ref).startsWith(`${m.mediaKey}-`) ? [{ kind: 'MEASUREMENT', field: 'both', reason: i.reason || 'Rejected' }] : [];
        });
        r.reworkId = reworkIdOf(u, u.currentVersion, r.stage);
        (u.reworks ??= []).push({ reworkId: r.reworkId, sourceVersion: u.currentVersion, stage: r.stage, requestedBy: old.reviewer, requestedAt: old.decidedAt, status: 'OPEN', items: its });
      }
      if (shopReviews.some((x: Row) => x.decision === 'REJECTED')) u.status = 'REJECTED';
      unitOutcome(u);
    }
  }
  // The field app's current draft (units not submitted yet) on top.
  const out = mergeFieldItems(items, flatItems(sub.mediaItems));
  // The shop was reopened after a decision: its units wait for a new version.
  if (sub.status === 'IN_PROGRESS' && sub.currentVersion > 0) for (const { u } of unitsOf(out)) if (u.currentVersion > 0 && u.status !== 'APPROVED') u.status = 'REWORK';
  return out;
}

/* ------------------------------------------------ presenting ------------------------------------------------ */

/**
 * The units for the review screens, in the shape the web reads (board = media item, key = mediaKey / unitId, each version with its
 * stage reviews and the rejected items): photo links, reviewer names, voice note links.
 */
export async function presentBoards(rawItems: Row[]) {
  const items = (rawItems ?? []).filter((m: Row) => m.mediaKey && (m.units ?? []).length);
  if (!items.length) return [];
  const all = unitsOf(items);
  const reviews = all.flatMap(({ u }) => u.reviews ?? []);
  const photos = all.flatMap(({ u }) => u.photos ?? []);
  const names = await nameMap([...reviews.map((r: Row) => r.reviewer), ...reviews.map((r: Row) => r.override?.by), ...all.flatMap(({ u }) => (u.versions ?? []).map((v: Row) => v.submittedBy)), ...photos.map((p: Row) => p.uploadedBy)]);
  const roles = await roleMap(photos.map((p: Row) => p.uploadedBy));
  const presented = new Map(await Promise.all(photos.map(async (p: Row) => [String(p._id), await presentPhoto(p, names, { withHistory: true, roles })] as const)));
  const voice = async (f: Row) => (f?.key ? ((await link(f))?.url ?? null) : null);
  const answers = (l: Row[]) => (l ?? []).map((a: Row) => ({ key: a.questionId, questionId: a.questionId, question: a.question, answer: a.answer }));
  return Promise.all(items.map(async (m: Row) => ({
    key: m.mediaKey, name: m.name ?? m.mediaType ?? m.mediaKey, mediaType: m.mediaType ?? null, sideType: m.sideType ?? null, quantity: m.quantity ?? m.units?.length ?? 1, sided: m.sideType ?? null, condition: m.condition ?? null, position: m.position ?? null,
    units: await Promise.all((m.units ?? []).map(async (u: Row) => ({
      key: u.unitId, unitId: u.unitId, unitNo: u.unitNo, status: u.status, currentVersion: u.currentVersion ?? 0, approvedAt: u.approvedAt ?? null, installationType: u.installationType ?? null,
      measurement: u.measurement ?? null, answers: answers(u.answers), notes: u.notes ?? '',
      photos: (u.photos ?? []).map((p: Row) => presented.get(String(p._id))).filter(Boolean),
      reworks: (u.reworks ?? []).map((rw: Row) => ({ reworkId: rw.reworkId, sourceVersion: rw.sourceVersion, stage: rw.stage, status: rw.status, requestedAt: rw.requestedAt ?? null, resolvedInVersion: rw.resolvedInVersion ?? null, items: (rw.items ?? []).map((i: Row) => ({ kind: i.kind, ref: i.photoId ? String(i.photoId) : null, category: i.category ?? null, field: i.field ?? null, reason: i.reason })) })),
      versions: await Promise.all((u.versions ?? []).map(async (v: Row, i: number, list: Row[]) => {
        const before = new Set((list[i - 1]?.photoIds ?? []).map(String));
        return {
          version: v.version, shopVersion: v.shopVersion ?? null, submittedBy: v.submittedBy ? (names.get(String(v.submittedBy)) ?? null) : null, submittedAt: v.submittedAt ?? null,
          installationType: v.installationType ?? null, photos: (v.photoIds ?? []).map(String), changedFields: v.changedFields ?? [],
          changed: { photos: i ? (v.photoIds ?? []).map(String).filter((id: string) => !before.has(id)) : [], measurement: (v.changedFields ?? []).filter((f: string) => f.startsWith('measurement.')).map((f: string) => f.slice(12)) },
          measurement: v.measurement ?? null, answers: answers(v.answers),
          reviews: await Promise.all((u.reviews ?? []).filter((r: Row) => r.version === v.version).map(async (r: Row) => {
            const rw = r.reworkId ? (u.reworks ?? []).find((x: Row) => x.reworkId === r.reworkId) : null;
            return {
              stage: r.stage, stageLabel: STAGE_LABEL[r.stage as ReviewStage], decision: r.decision, reviewer: r.reviewer ? (names.get(String(r.reviewer)) ?? null) : null, decidedAt: r.decidedAt ?? null,
              comment: r.comment ?? '', rejectMode: r.rejectMode ?? null, reworkId: r.reworkId ?? null, voiceNoteUrl: await voice(r.voiceNote), override: r.override?.reason ? { reason: r.override.reason, by: names.get(String(r.override.by)) ?? null } : null,
              items: (rw?.items ?? []).map((it: Row) => ({ kind: it.kind, ref: it.photoId ? String(it.photoId) : null, category: it.category ?? null, categoryLabel: it.category ? (CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? it.category) : null, field: it.field ?? null, reason: it.reason, fixedInVersion: rw?.resolvedInVersion ?? null })),
            };
          })),
        };
      })),
    }))),
  })));
}

/** The units of a shop for the review screens, moving an older record on the fly (read only). */
export const presentShopUnits = (sub: Row) => presentBoards(hasUnits(sub) ? itemsOf(sub) : []);
