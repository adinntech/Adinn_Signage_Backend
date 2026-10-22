import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeqBlock } from '../../common/counter.model';
import { pageMeta, type Actor } from '../../common/query';
import { assertNotCancelled } from '../../common/project-access';
import { recordAudit } from '../audit/audit.service';
import { notifyProjectParty } from '../notifications/notification.service';
import { Requirement } from '../projects/project.model';
import { parseWorkbook } from './excel.service';
import {
  autoMap, dealerKeyOf, dupKeyOf, normalise, sqftOf, validateMapping,
  type MapTarget, type MappableField, type RowIssue, type Scenario, type Unit,
} from './site.fields';
import { ImportBatch, ImportRow, Site } from './site.model';
import { requireProject, syncSiteCount } from './site.service';
import type { commitBody, previewBody, rowListQuery, rowPatch } from './site.validators';

const CHUNK = 1000;
type Mapping = Record<string, MapTarget>;
type DupPolicy = 'skip' | 'import' | 'update';

async function getBatch(projectId: string, batchId: string) {
  const b = await ImportBatch.findOne({ _id: batchId, project: projectId });
  if (!b) throw AppError.notFound('Import not found');
  return b;
}

export async function defaultScenario(projectId: string): Promise<Scenario> {
  const r = await Requirement.findOne({ project: projectId }).select('siteDataScenario').lean();
  return (r?.siteDataScenario as Scenario | undefined) ?? 'MEASUREMENT_REQUIRED';
}

// ---- 1. upload & parse ----
export async function uploadSheet(projectId: string, file: { buffer: Buffer; originalname: string; size: number }, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const parsed = await parseWorkbook(file.buffer, file.originalname);
  const scenario = await defaultScenario(projectId);
  const mapping = autoMap(parsed.headers);
  const batch = await ImportBatch.create({
    project: projectId, fileName: file.originalname.slice(0, 200), fileSize: file.size, sheetName: parsed.sheetName,
    headers: parsed.headers, mapping, scenario, totalRows: parsed.rows.length, createdBy: actor.id,
  });
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    await ImportRow.insertMany(parsed.rows.slice(i, i + CHUNK).map((r) => ({ batch: batch._id, rowNumber: r.rowNumber, raw: r.raw })), { ordered: false });
  }
  const sample = parsed.rows.slice(0, 8);
  return { batch: batch.toObject(), suggestedMapping: mapping, sample, problems: validateMapping(mapping, scenario) };
}

// ---- 2. apply mapping + validate ----
function rawFor(raw: Record<string, string>, mapping: Mapping) {
  const out: Partial<Record<MappableField, string>> = {};
  const extra: Record<string, string> = {};
  for (const [header, target] of Object.entries(mapping)) {
    const v = raw[header] ?? '';
    if (target === 'ignore') continue;
    if (target === 'extra') { if (v) extra[header] = v; continue; }
    out[target] = v;
  }
  return { out, extra };
}

interface Evaluated { state: 'VALID' | 'WARNING' | 'ERROR'; mapped: Record<string, unknown>; extra: Record<string, string>; errors: RowIssue[]; warnings: RowIssue[]; dupKey: string }
function evaluate(raw: Record<string, string>, mapping: Mapping, scenario: Scenario, unit: Unit): Evaluated {
  const { out, extra } = rawFor(raw, mapping);
  const n = normalise(out, { scenario, defaultUnit: unit });
  const state = n.errors.length ? 'ERROR' : n.warnings.length ? 'WARNING' : 'VALID';
  return { state, mapped: n.value as Record<string, unknown>, extra, errors: n.errors, warnings: n.warnings, dupKey: dupKeyOf(n.value) };
}

async function existingKeys(projectId: string) {
  const rows = await Site.find({ project: projectId, deletedAt: null }).select('dupKey shopName dealerName district').lean();
  const byKey = new Map<string, string>();
  const dealers = new Set<string>();
  for (const r of rows) {
    if (r.dupKey) byKey.set(r.dupKey, String(r._id));
    const d = dealerKeyOf(r as never);
    if (d) dealers.add(d);
  }
  return { byKey, dealers };
}

export async function previewImport(projectId: string, batchId: string, body: z.infer<typeof previewBody>) {
  const batch = await getBatch(projectId, batchId);
  if (['COMMITTING', 'COMMITTED'].includes(batch.status)) throw AppError.conflict('This import is already committed');
  const scenario = body.scenario ?? (batch.scenario as Scenario) ?? 'MEASUREMENT_REQUIRED';
  const mapping = body.mapping as Mapping;
  for (const h of Object.keys(mapping)) if (!batch.headers.includes(h)) throw AppError.badRequest(`Unknown column "${h}"`);
  const problems = validateMapping(mapping, scenario);
  if (problems.length) throw AppError.badRequest('Column mapping is incomplete', problems.map((message) => ({ path: 'mapping', message })));

  const { byKey, dealers } = await existingKeys(projectId);
  const seenKey = new Map<string, number>();
  const seenDealerShop = new Map<string, string>();
  const summary = { valid: 0, warning: 0, error: 0, duplicates: 0, skipped: 0 };
  const ops: any[] = [];

  const cursor = ImportRow.find({ batch: batchId }).sort({ rowNumber: 1 }).lean().cursor();
  for await (const row of cursor) {
    const e = evaluate(row.raw as Record<string, string>, mapping, scenario, body.defaultUnit);
    let dup: { type: 'FILE' | 'EXISTING' | 'DEALER'; ref: string } | null = null;
    const warnings = [...e.warnings];
    if (e.dupKey) {
      if (seenKey.has(e.dupKey)) {
        dup = { type: 'FILE', ref: String(seenKey.get(e.dupKey)) };
        warnings.push({ field: 'shopName', code: 'DUPLICATE_IN_FILE', message: `Duplicate of row ${seenKey.get(e.dupKey)} in this file` });
      } else {
        seenKey.set(e.dupKey, row.rowNumber);
        if (byKey.has(e.dupKey)) {
          dup = { type: 'EXISTING', ref: byKey.get(e.dupKey)! };
          warnings.push({ field: 'shopName', code: 'DUPLICATE_EXISTING', message: 'Already exists in this project' });
        }
      }
    }
    const dk = dealerKeyOf(e.mapped as never);
    if (!dup && dk) {
      const shop = String(e.mapped.shopName ?? '');
      if (dealers.has(dk) || (seenDealerShop.has(dk) && seenDealerShop.get(dk) !== shop)) {
        dup = { type: 'DEALER', ref: '' };
        warnings.push({ field: 'dealerName', code: 'DUPLICATE_DEALER', message: 'Same dealer already listed in this district (different shop)' });
      }
      if (!seenDealerShop.has(dk)) seenDealerShop.set(dk, shop);
    }
    const state = e.errors.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID';
    summary[state === 'ERROR' ? 'error' : state === 'WARNING' ? 'warning' : 'valid']++;
    if (dup && dup.type !== 'DEALER') summary.duplicates++;
    if (row.skipped) summary.skipped++;
    ops.push({
      updateOne: { filter: { _id: row._id }, update: { $set: { mapped: e.mapped, extra: e.extra, errors: e.errors, warnings, state, dupKey: e.dupKey, dup } } },
    });
    if (ops.length >= CHUNK) await ImportRow.bulkWrite(ops.splice(0));
  }
  if (ops.length) await ImportRow.bulkWrite(ops);
  batch.set({ mapping, scenario, defaultUnit: body.defaultUnit, duplicatePolicy: body.duplicatePolicy, status: 'PREVIEWED', summary });
  await batch.save();
  return batch.toObject();
}

export async function listRows(projectId: string, batchId: string, q: z.infer<typeof rowListQuery>) {
  await getBatch(projectId, batchId);
  const filter: Record<string, unknown> = { batch: new Types.ObjectId(batchId) };
  if (q.state === 'DUPLICATE') filter['dup.type'] = { $in: ['FILE', 'EXISTING'] };
  else if (q.state) filter.state = q.state;
  const [items, total] = await Promise.all([
    ImportRow.find(filter).sort({ rowNumber: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    ImportRow.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

/** Inline fix of a staged row: edits the normalised values, re-validates, keeps duplicate flags. */
export async function patchRow(projectId: string, batchId: string, rowId: string, body: z.infer<typeof rowPatch>) {
  const batch = await getBatch(projectId, batchId);
  if (['COMMITTING', 'COMMITTED'].includes(batch.status)) throw AppError.conflict('This import is already committed');
  const row = await ImportRow.findOne({ _id: rowId, batch: batchId });
  if (!row) throw AppError.notFound('Row not found');
  if (body.skipped !== undefined) row.skipped = body.skipped;
  if (body.mapped) {
    const merged = { ...(row.mapped as Record<string, unknown>), ...body.mapped } as Record<string, unknown>;
    const n = normalise(merged as never, { scenario: batch.scenario as Scenario, defaultUnit: batch.defaultUnit as Unit });
    const warnings = [...n.warnings];
    const dupKey = dupKeyOf(n.value);
    let dup = row.dup?.type ? { type: row.dup.type, ref: row.dup.ref ?? '' } : null;
    if (dup && dup.type !== 'DEALER' && dupKey !== row.dupKey) dup = null; // identity changed: re-evaluated on commit
    if (dup?.type === 'FILE') warnings.push({ field: 'shopName', code: 'DUPLICATE_IN_FILE', message: `Duplicate of row ${dup.ref} in this file` });
    if (dup?.type === 'EXISTING') warnings.push({ field: 'shopName', code: 'DUPLICATE_EXISTING', message: 'Already exists in this project' });
    row.set({ mapped: n.value, errors: n.errors, warnings, state: n.errors.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID', dupKey, dup });
    row.markModified('mapped');
  }
  await row.save();
  const [valid, warning, error, skipped, duplicates] = await Promise.all([
    ImportRow.countDocuments({ batch: batchId, state: 'VALID' }), ImportRow.countDocuments({ batch: batchId, state: 'WARNING' }),
    ImportRow.countDocuments({ batch: batchId, state: 'ERROR' }), ImportRow.countDocuments({ batch: batchId, skipped: true }),
    ImportRow.countDocuments({ batch: batchId, 'dup.type': { $in: ['FILE', 'EXISTING'] } }),
  ]);
  batch.summary = { valid, warning, error, skipped, duplicates } as never;
  await batch.save();
  return { row: row.toObject(), summary: batch.summary };
}

// ---- 3. commit ----
export async function commitImport(projectId: string, batchId: string, body: z.infer<typeof commitBody>, actor: Actor) {
  const project = await requireProject(projectId);
  await assertNotCancelled(projectId);
  const locked = await ImportBatch.findOneAndUpdate({ _id: batchId, project: projectId, status: 'PREVIEWED' }, { status: 'COMMITTING' }, { returnDocument: 'after' });
  if (!locked) {
    const b = await getBatch(projectId, batchId);
    throw AppError.conflict(b.status === 'COMMITTED' ? 'This import was already committed' : 'Preview the import (map columns) before committing');
  }
  const policy = (body.duplicatePolicy ?? locked.duplicatePolicy) as DupPolicy;
  try {
    const scenario = locked.scenario as Scenario;
    const { byKey } = await existingKeys(projectId);
    const seen = new Set<string>();
    const toCreate: any[] = [];
    const toUpdate: { id: string; row: any }[] = [];
    let errorRows = 0, skippedRows = 0;

    const cursor = ImportRow.find({ batch: batchId }).sort({ rowNumber: 1 }).lean().cursor();
    for await (const row of cursor) {
      if (row.skipped) { skippedRows++; continue; }
      // A row still flagged ERROR (e.g. an invalid mobile) is never imported. Re-validating below would not catch it,
      // because the staged values already had the bad field removed. Fixing the row in the review step clears the flag.
      if (row.state === 'ERROR') { errorRows++; continue; }
      // Re-validate: rows may have been edited after preview.
      const n = normalise(row.mapped as never, { scenario, defaultUnit: locked.defaultUnit as Unit });
      if (n.errors.length) { errorRows++; continue; }
      const dupKey = dupKeyOf(n.value);
      const inFile = !!dupKey && seen.has(dupKey);
      const existingId = dupKey ? byKey.get(dupKey) : undefined;
      if (dupKey) seen.add(dupKey);
      if (existingId && !inFile && policy === 'update') { toUpdate.push({ id: existingId, row: { ...row, n } }); continue; }
      if ((inFile || existingId) && policy !== 'import') { skippedRows++; continue; }
      toCreate.push({ ...row, n, dupKey });
    }

    let created = 0;
    if (toCreate.length) {
      const start = await nextSeqBlock(`site:${projectId}`, toCreate.length);
      for (let i = 0; i < toCreate.length; i += CHUNK) {
        const docs = toCreate.slice(i, i + CHUNK).map((r, j) => {
          const seq = start + i + j;
          const v = r.n.value;
          const extra = r.extra && Object.keys(r.extra).length ? r.extra : undefined;
          return {
            ...v, extra, project: projectId, scenario, seq, siteCode: `${project.code}-S${String(seq).padStart(3, '0')}`,
            sqft: sqftOf(v.width, v.height, v.unit ?? 'ft', v.quantity ?? 1), dupKey: r.dupKey,
            importBatch: batchId, sourceRow: r.rowNumber, createdBy: actor.id, updatedBy: actor.id,
          };
        });
        const res = await Site.insertMany(docs, { ordered: false });
        created += res.length;
      }
    }
    let updated = 0;
    if (toUpdate.length) {
      for (let i = 0; i < toUpdate.length; i += CHUNK) {
        const ops = toUpdate.slice(i, i + CHUNK).map(({ id, row }) => {
          const v = row.n.value; // only non-blank values overwrite existing data
          const extra = row.extra ?? {};
          return {
            updateOne: {
              filter: { _id: id },
              update: { $set: { ...v, ...Object.fromEntries(Object.entries(extra).map(([k, val]) => [`extra.${k}`, val])), sqft: sqftOf(v.width, v.height, v.unit ?? 'ft', v.quantity ?? 1), updatedBy: actor.id } },
            },
          };
        });
        const r = await Site.bulkWrite(ops);
        updated += r.modifiedCount;
      }
    }
    await syncSiteCount(projectId);
    const result = { created, updated, skippedRows, errorRows };
    locked.set({ status: 'COMMITTED', result, committedAt: new Date() });
    await locked.save();
    await recordAudit({ actor, action: 'IMPORT_SITES', entity: 'ImportBatch', entityId: locked._id, project: projectId, reason: `${locked.fileName}: ${created} created, ${updated} updated, ${skippedRows} skipped, ${errorRows} with errors` });
    if (created > 0) {
      await notifyProjectParty(
        projectId,
        'owner',
        {
          kind: 'SHOPS_IMPORTED',
          title: 'Shop list imported',
          body: `${created} shop${created > 1 ? 's' : ''} imported into project ${project.code} from ${locked.fileName}${skippedRows + errorRows ? ` (${skippedRows + errorRows} rows skipped)` : ''}.`,
          dedupe: (r) => `import:${locked._id}:${r}`,
        },
        actor.id,
      );
    }
    return locked.toObject();
  } catch (e) {
    // Sites created so far are kept (each has importBatch); allow retry with remaining state.
    await ImportBatch.updateOne({ _id: batchId }, { status: 'FAILED' });
    throw e;
  }
}

export async function discardImport(projectId: string, batchId: string) {
  const b = await getBatch(projectId, batchId);
  if (b.status === 'COMMITTED' || b.status === 'COMMITTING') throw AppError.conflict('A committed import cannot be discarded');
  await ImportRow.deleteMany({ batch: batchId });
  b.status = 'DISCARDED';
  await b.save();
}

export async function listImports(projectId: string) {
  await requireProject(projectId);
  return ImportBatch.find({ project: projectId, status: { $in: ['COMMITTED', 'FAILED'] } })
    .sort({ createdAt: -1 }).limit(50).select('-headers -mapping').populate('createdBy', 'name').lean();
}

export async function getImport(projectId: string, batchId: string) {
  return (await getBatch(projectId, batchId)).toObject();
}

