import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { RecceSubmission } from '../recce-review/recceReview.model';
import { CATALOG_SEED } from './catalog.seed';
import { CatalogInstallation, CatalogMedia, CatalogMeta, CatalogQuestion } from './catalog.model';
import { installationBody, type installationPatch, mediaBody, type mediaPatch, questionBody, type questionPatch } from './catalog.validators';

/** Audit rows need an id: actions on the whole catalog (order, load defaults) use this fixed one. */
const CATALOG_AUDIT_ID = new Types.ObjectId('000000000000000000000c47');

/** Sanity limits: the catalog is a short list a person edits by hand, never a place for runaway data. */
const MAX_MEDIA = 60;
const MAX_INSTALLATIONS = 40;
const MAX_QUESTIONS_PER_GROUP = 40;

/* ------------------------------------------------ presentation ------------------------------------------------ */

type MediaDoc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const presentMedia = (m: MediaDoc) => ({
  code: m.code as string, shortName: m.shortName as string, name: m.name as string, description: (m.description ?? '') as string, icon: m.icon as string, color: m.color as string,
  illuminated: !!m.illuminated, sidedness: m.sidedness as string, depthFt: (m.depthFt ?? 0) as number, thicknessMm: (m.thicknessMm ?? 0) as number, template: (m.template ?? '') as string,
  installations: [...(m.installations ?? [])] as string[], legacy: !!m.legacy, active: m.active !== false, order: (m.order ?? 0) as number,
});
export const presentInstallation = (i: MediaDoc) => ({ code: i.code as string, name: i.name as string, description: (i.description ?? '') as string, icon: i.icon as string, active: i.active !== false, order: (i.order ?? 0) as number });
export const presentQuestion = (q: MediaDoc) => ({
  uid: String(q._id), scope: q.scope as string, scopeCode: (q.scopeCode ?? '') as string, id: q.id as string, label: q.label as string, type: q.type as string, options: [...(q.options ?? [])] as string[],
  unit: (q.unit ?? null) as string | null, required: q.required !== false, hint: (q.hint ?? null) as string | null, showIfId: (q.showIfId ?? null) as string | null,
  showIfValue: (q.showIfValue ?? null) as string | number | boolean | null, active: q.active !== false, order: (q.order ?? 0) as number,
});

/* ------------------------------------------------ version, seed ------------------------------------------------ */

const bump = async () => (await CatalogMeta.findOneAndUpdate({ _id: 'catalog' }, { $inc: { version: 1 } }, { upsert: true, returnDocument: 'after' }).lean())!.version;

const ignoreDuplicate = (e: unknown) => {
  if ((e as { code?: number })?.code !== 11000) throw e; // two first requests seeding at once: the other one's insert won
};

/**
 * Adds every built-in entry whose code / key is missing. Never overwrites an entry that exists (so an edit made in the admin screens
 * stays), and never brings back one that was deleted on purpose unless this is asked for ("Load built-in defaults").
 */
export async function seedCatalog() {
  const added = { media: 0, installations: 0, questions: 0 };
  try {
    const m = await CatalogMedia.bulkWrite(CATALOG_SEED.media.map((x) => ({ updateOne: { filter: { code: x.code }, update: { $setOnInsert: { ...x, active: true } }, upsert: true } })), { ordered: false });
    added.media = m.upsertedCount;
    const i = await CatalogInstallation.bulkWrite(CATALOG_SEED.installations.map((x) => ({ updateOne: { filter: { code: x.code }, update: { $setOnInsert: { ...x, active: true } }, upsert: true } })), { ordered: false });
    added.installations = i.upsertedCount;
    const q = await CatalogQuestion.bulkWrite(
      CATALOG_SEED.questions.map((x) => {
        const scopeCode = x.scopeCode ?? '';
        return { updateOne: { filter: { scope: x.scope, scopeCode, id: x.id }, update: { $setOnInsert: { ...x, scopeCode, active: true } }, upsert: true } };
      }),
      { ordered: false },
    );
    added.questions = q.upsertedCount;
  } catch (e) {
    ignoreDuplicate(e);
  }
  await CatalogMeta.updateOne({ _id: 'catalog' }, { $set: { seededAt: new Date() }, $inc: { version: 1 } }, { upsert: true });
  return added;
}

let seededHere = false;
/** The first time anything reads or writes the catalog it is filled from the built-in list, so a new system works with no setup step. */
export async function ensureSeeded() {
  if (seededHere) return;
  const meta = await CatalogMeta.findById('catalog').lean();
  if (!meta?.seededAt) await seedCatalog();
  seededHere = true;
}
/** For tests that empty the database between cases. */
export const forgetSeed = () => {
  seededHere = false;
};

/* ------------------------------------------------ read ------------------------------------------------ */

export async function getCatalog(sinceVersion?: number) {
  await ensureSeeded();
  const meta = await CatalogMeta.findById('catalog').lean();
  const version = meta?.version ?? 1;
  if (sinceVersion !== undefined && sinceVersion === version) return { version, unchanged: true as const };
  const [media, installations, questions] = await Promise.all([
    CatalogMedia.find().sort({ order: 1, code: 1 }).lean(),
    CatalogInstallation.find().sort({ order: 1, code: 1 }).lean(),
    CatalogQuestion.find().sort({ scope: 1, scopeCode: 1, order: 1, id: 1 }).lean(),
  ]);
  return { version, unchanged: false as const, media: media.map(presentMedia), installations: installations.map(presentInstallation), questions: questions.map(presentQuestion) };
}

/** How many boards of recces already made use each media type and installation method (a used entry is made inactive, not deleted). */
export async function catalogUsage() {
  await ensureSeeded();
  const rows = await RecceSubmission.aggregate<{ _id: { code: string | null; name: string; inst: string | null }; boards: number }>([
    { $unwind: '$mediaItems' },
    { $group: { _id: { code: '$mediaItems.mediaCode', name: '$mediaItems.name', inst: '$mediaItems.installationType' }, boards: { $sum: 1 } } },
  ]);
  const media = await CatalogMedia.find().select('code name').lean();
  const byMedia: Record<string, number> = {};
  for (const m of media) byMedia[m.code] = rows.filter((r) => (r._id.code ? r._id.code === m.code : r._id.name === m.name)).reduce((n, r) => n + r.boards, 0);
  const byInstallation: Record<string, number> = {};
  for (const r of rows) if (r._id.inst) byInstallation[r._id.inst] = (byInstallation[r._id.inst] ?? 0) + r.boards;
  return { media: byMedia, installations: byInstallation };
}
const boardsUsingMedia = async (code: string) => (await catalogUsage()).media[code] ?? 0;
const boardsUsingInstallation = async (code: string) => (await catalogUsage()).installations[code] ?? 0;

/* ------------------------------------------------ media ------------------------------------------------ */

const MEDIA_FIELDS = ['shortName', 'name', 'description', 'icon', 'color', 'illuminated', 'sidedness', 'depthFt', 'thicknessMm', 'installations', 'active'];
const INSTALLATION_FIELDS = ['name', 'description', 'icon', 'active'];

async function assertInstallationsExist(codes: string[]) {
  if (!codes.length) return;
  const found = new Set((await CatalogInstallation.find({ code: { $in: codes } }).select('code').lean()).map((i) => i.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length) throw AppError.badRequest(`Unknown installation type: ${missing.join(', ')}`);
}

export async function createMedia(actor: Actor, input: z.infer<typeof mediaBody>) {
  await ensureSeeded();
  if (await CatalogMedia.exists({ code: input.code })) throw AppError.conflict(`A media type with code ${input.code} already exists`);
  if ((await CatalogMedia.countDocuments()) >= MAX_MEDIA) throw AppError.badRequest(`The catalog can hold ${MAX_MEDIA} media types`);
  await assertInstallationsExist(input.installations);
  const last = await CatalogMedia.findOne({ legacy: false }).sort({ order: -1 }).select('order').lean();
  const doc = await CatalogMedia.create({ ...input, template: '', legacy: false, order: (last?.order ?? -1) + 1, updatedBy: actor.id });
  await bump();
  await recordAudit({ actor, action: 'CREATE', entity: 'CatalogMedia', entityId: doc._id, meta: { code: doc.code } });
  return presentMedia(doc.toObject());
}

export async function updateMedia(actor: Actor, code: string, patch: z.infer<typeof mediaPatch>) {
  await ensureSeeded();
  const doc = await CatalogMedia.findOne({ code });
  if (!doc) throw AppError.notFound('Media type not found');
  const before = presentMedia(doc.toObject());
  const merged = mediaBody.parse({ ...before, ...patch, code });
  if (patch.installations) await assertInstallationsExist(merged.installations);
  const changes = diff(before as never, merged as never, MEDIA_FIELDS);
  if (!changes.length) return before;
  doc.set({ ...Object.fromEntries(MEDIA_FIELDS.map((f) => [f, (merged as Record<string, unknown>)[f]])), updatedBy: actor.id });
  await doc.save();
  await bump();
  await recordAudit({ actor, action: 'UPDATE', entity: 'CatalogMedia', entityId: doc._id, changes, meta: { code } });
  return presentMedia(doc.toObject());
}

export async function deleteMedia(actor: Actor, code: string) {
  await ensureSeeded();
  const doc = await CatalogMedia.findOne({ code });
  if (!doc) throw AppError.notFound('Media type not found');
  const used = await boardsUsingMedia(code);
  if (used > 0) throw AppError.conflict(`${doc.name} is used by ${used} board${used === 1 ? '' : 's'} already. Mark it inactive instead of deleting it.`);
  const questions = await CatalogQuestion.deleteMany({ scope: 'MEDIA', scopeCode: code });
  await doc.deleteOne();
  await bump();
  await recordAudit({ actor, action: 'DELETE', entity: 'CatalogMedia', entityId: doc._id, meta: { code, questionsDeleted: questions.deletedCount } });
  return { deleted: code, questionsDeleted: questions.deletedCount };
}

/* ------------------------------------------------ installations ------------------------------------------------ */

export async function createInstallation(actor: Actor, input: z.infer<typeof installationBody>) {
  await ensureSeeded();
  if (await CatalogInstallation.exists({ code: input.code })) throw AppError.conflict(`An installation type with code ${input.code} already exists`);
  if ((await CatalogInstallation.countDocuments()) >= MAX_INSTALLATIONS) throw AppError.badRequest(`The catalog can hold ${MAX_INSTALLATIONS} installation types`);
  const last = await CatalogInstallation.findOne().sort({ order: -1 }).select('order').lean();
  const doc = await CatalogInstallation.create({ ...input, order: (last?.order ?? -1) + 1, updatedBy: actor.id });
  await bump();
  await recordAudit({ actor, action: 'CREATE', entity: 'CatalogInstallation', entityId: doc._id, meta: { code: doc.code } });
  return presentInstallation(doc.toObject());
}

export async function updateInstallation(actor: Actor, code: string, patch: z.infer<typeof installationPatch>) {
  await ensureSeeded();
  const doc = await CatalogInstallation.findOne({ code });
  if (!doc) throw AppError.notFound('Installation type not found');
  const before = presentInstallation(doc.toObject());
  const merged = installationBody.parse({ ...before, ...patch, code });
  const changes = diff(before as never, merged as never, INSTALLATION_FIELDS);
  if (!changes.length) return before;
  doc.set({ ...Object.fromEntries(INSTALLATION_FIELDS.map((f) => [f, (merged as Record<string, unknown>)[f]])), updatedBy: actor.id });
  await doc.save();
  await bump();
  await recordAudit({ actor, action: 'UPDATE', entity: 'CatalogInstallation', entityId: doc._id, changes, meta: { code } });
  return presentInstallation(doc.toObject());
}

export async function deleteInstallation(actor: Actor, code: string) {
  await ensureSeeded();
  const doc = await CatalogInstallation.findOne({ code });
  if (!doc) throw AppError.notFound('Installation type not found');
  const used = await boardsUsingInstallation(code);
  if (used > 0) throw AppError.conflict(`${doc.name} is used by ${used} board${used === 1 ? '' : 's'} already. Mark it inactive instead of deleting it.`);
  const media = await CatalogMedia.updateMany({ installations: code }, { $pull: { installations: code } });
  const questions = await CatalogQuestion.deleteMany({ scope: 'INSTALLATION', scopeCode: code });
  await doc.deleteOne();
  await bump();
  await recordAudit({ actor, action: 'DELETE', entity: 'CatalogInstallation', entityId: doc._id, meta: { code, removedFromMedia: media.modifiedCount, questionsDeleted: questions.deletedCount } });
  return { deleted: code, removedFromMedia: media.modifiedCount, questionsDeleted: questions.deletedCount };
}

/* ------------------------------------------------ questions ------------------------------------------------ */

const QUESTION_FIELDS = ['label', 'options', 'unit', 'required', 'hint', 'showIfId', 'showIfValue', 'active'];

/** A stored question as the body schema reads it (a cleared value is `null` in the database and missing in the body). */
const asBody = (q: ReturnType<typeof presentQuestion>) => ({ ...q, unit: q.unit ?? undefined, hint: q.hint ?? undefined, showIfId: q.showIfId ?? undefined, showIfValue: q.showIfValue ?? undefined });

export async function createQuestion(actor: Actor, input: z.infer<typeof questionBody>) {
  await ensureSeeded();
  if (input.scope === 'MEDIA' && !(await CatalogMedia.exists({ code: input.scopeCode }))) throw AppError.badRequest('Unknown media type');
  if (input.scope === 'INSTALLATION' && !(await CatalogInstallation.exists({ code: input.scopeCode }))) throw AppError.badRequest('Unknown installation type');
  const group = { scope: input.scope, scopeCode: input.scopeCode };
  if (await CatalogQuestion.exists({ ...group, id: input.id })) throw AppError.conflict(`A question with key ${input.id} already exists here`);
  if ((await CatalogQuestion.countDocuments(group)) >= MAX_QUESTIONS_PER_GROUP) throw AppError.badRequest(`A group can hold ${MAX_QUESTIONS_PER_GROUP} questions`);
  const last = await CatalogQuestion.findOne(group).sort({ order: -1 }).select('order').lean();
  const doc = await CatalogQuestion.create({ ...input, order: (last?.order ?? -1) + 1, updatedBy: actor.id });
  await bump();
  await recordAudit({ actor, action: 'CREATE', entity: 'CatalogQuestion', entityId: doc._id, meta: { scope: input.scope, scopeCode: input.scopeCode, id: input.id } });
  return presentQuestion(doc.toObject());
}

export async function updateQuestion(actor: Actor, uid: string, patch: z.infer<typeof questionPatch>) {
  await ensureSeeded();
  const doc = await CatalogQuestion.findById(uid);
  if (!doc) throw AppError.notFound('Question not found');
  const before = presentQuestion(doc.toObject());
  const withPatch: Record<string, unknown> = { ...asBody(before) };
  for (const [k, v] of Object.entries(patch)) withPatch[k] = v === null ? undefined : v;
  const merged = questionBody.parse(withPatch); // the same rules as a new question, on the whole result
  const changes = diff(before as never, { ...merged, unit: merged.unit ?? null, hint: merged.hint ?? null, showIfId: merged.showIfId ?? null, showIfValue: merged.showIfValue ?? null } as never, QUESTION_FIELDS);
  if (!changes.length) return before;
  for (const f of QUESTION_FIELDS) doc.set(f, (merged as Record<string, unknown>)[f] ?? undefined);
  doc.set('updatedBy', actor.id);
  await doc.save();
  await bump();
  await recordAudit({ actor, action: 'UPDATE', entity: 'CatalogQuestion', entityId: doc._id, changes, meta: { scope: doc.scope, scopeCode: doc.scopeCode, id: doc.id } });
  return presentQuestion(doc.toObject());
}

export async function deleteQuestion(actor: Actor, uid: string) {
  await ensureSeeded();
  const doc = await CatalogQuestion.findById(uid);
  if (!doc) throw AppError.notFound('Question not found');
  await doc.deleteOne();
  await bump();
  // Answers already given stay on their boards under this key; nothing asks for them any more.
  await recordAudit({ actor, action: 'DELETE', entity: 'CatalogQuestion', entityId: doc._id, meta: { scope: doc.scope, scopeCode: doc.scopeCode, id: doc.id } });
  return { deleted: uid };
}

/* ------------------------------------------------ order, seed on demand ------------------------------------------------ */

/** Sets the display order of a list: media, installations, or the questions of ONE group. `ids` must be exactly the entries being ordered. */
export async function reorder(actor: Actor, kind: 'media' | 'installations' | 'questions', ids: string[]) {
  await ensureSeeded();
  if (new Set(ids).size !== ids.length) throw AppError.badRequest('An entry is listed twice');
  if (kind === 'questions') {
    if (ids.some((i) => !/^[a-f\d]{24}$/i.test(i))) throw AppError.badRequest('Invalid question id');
    const rows = await CatalogQuestion.find({ _id: { $in: ids } }).select('scope scopeCode').lean();
    if (rows.length !== ids.length) throw AppError.notFound('A question was not found');
    if (new Set(rows.map((r) => `${r.scope}|${r.scopeCode}`)).size > 1) throw AppError.badRequest('Order the questions of one group at a time');
    await CatalogQuestion.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id }, update: { $set: { order } } } })));
  } else {
    const found = await (kind === 'media' ? CatalogMedia : CatalogInstallation).countDocuments({ code: { $in: ids } });
    if (found !== ids.length) throw AppError.notFound('An entry was not found');
    const ops = ids.map((code, order) => ({ updateOne: { filter: { code }, update: { $set: { order } } } }));
    if (kind === 'media') await CatalogMedia.bulkWrite(ops);
    else await CatalogInstallation.bulkWrite(ops);
  }
  const version = await bump();
  await recordAudit({ actor, action: 'UPDATE', entity: 'Catalog', entityId: CATALOG_AUDIT_ID, meta: { reorder: kind, count: ids.length } });
  return { version, ordered: ids.length };
}

/** "Load built-in defaults": adds back any built-in entry that is missing. Existing entries are never touched. */
export async function loadDefaults(actor: Actor) {
  await ensureSeeded();
  const added = await seedCatalog();
  await recordAudit({ actor, action: 'UPDATE', entity: 'Catalog', entityId: CATALOG_AUDIT_ID, meta: { loadDefaults: added } });
  return added;
}

/* ------------------------------------------------ used by the recce draft ------------------------------------------------ */

type RefItem = { key: string; mediaCode?: string | null | undefined; installationType?: string | null | undefined };

/**
 * A board may only be given a media type / installation that the catalog offers. Checked only when the value CHANGED against what the
 * board already holds, so an older draft that still carries a code since made inactive or deleted can be saved again unchanged.
 */
export async function assertBoardRefs(items: RefItem[], stored: RefItem[]) {
  const changed = items.filter((i) => {
    const s = stored.find((x) => x.key === i.key);
    return (i.mediaCode ?? null) !== (s?.mediaCode ?? null) || (i.installationType ?? null) !== (s?.installationType ?? null);
  });
  if (!changed.length) return;
  await ensureSeeded();
  for (const i of changed) {
    const media = i.mediaCode ? await CatalogMedia.findOne({ code: i.mediaCode }).lean() : null;
    if (i.mediaCode && (!media || media.active === false)) throw AppError.badRequest(`Unknown media type ${i.mediaCode}`);
    if (!i.installationType) continue;
    const inst = await CatalogInstallation.findOne({ code: i.installationType }).lean();
    if (!inst || inst.active === false) throw AppError.badRequest(`Unknown installation type ${i.installationType}`);
    if (media && !media.installations.includes(i.installationType)) throw AppError.badRequest(`${inst.name} is not offered for ${media.name}`);
  }
}
