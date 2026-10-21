import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeqBlock } from '../../common/counter.model';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { Project } from '../projects/project.model';
import { buildSitesFile, buildTemplate, DEFAULT_EXPORT, EXPORT_COLUMNS } from './excel.service';
import { dupKeyOf, normalise, sqftOf, type Scenario, type SiteInput, type Unit } from './site.fields';
import { Site } from './site.model';
import type { bulkBody, exportQuery, siteCreate, siteFilter, siteListQuery, sitePatch } from './site.validators';

export const SORTABLE = ['seq', 'siteCode', 'shopName', 'dealerName', 'district', 'location', 'sqft', 'status', 'createdAt'];
const AUDIT_FIELDS = ['shopName', 'dealerName', 'location', 'district', 'address1', 'address2', 'pincode', 'mobile', 'gstin', 'contactPerson', 'width', 'height', 'unit', 'quantity', 'boardType', 'remarks', 'clientSiteCode', 'scenario'];

export async function requireProject(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}

type Filter = z.infer<typeof siteFilter>;
export function buildFilter(projectId: string, f: Filter, ids?: string[]) {
  const q: Record<string, any> = { project: new Types.ObjectId(projectId), deletedAt: null };
  if (ids?.length) q._id = { $in: ids.map((i) => new Types.ObjectId(i)) };
  if (f.district) q.district = new RegExp(`^${escapeRegex(f.district)}$`, 'i');
  if (f.status) q.status = f.status;
  if (f.scenario) q.scenario = f.scenario;
  if (f.importBatchId) q.importBatch = new Types.ObjectId(f.importBatchId);
  if (f.q) {
    const re = new RegExp(escapeRegex(f.q), 'i');
    q.$or = [{ shopName: re }, { dealerName: re }, { siteCode: re }, { mobile: re }, { district: re }, { location: re }];
  }
  const empty = (field: string) => ({ $or: [{ [field]: null }, { [field]: '' }] });
  const and: unknown[] = [];
  if (f.missing === 'address') and.push(empty('address1'), empty('address2'));
  if (f.missing === 'mobile') and.push(empty('mobile'));
  if (f.missing === 'gst') and.push(empty('gstin'));
  if (f.missing === 'district') and.push(empty('district'));
  if (f.missing === 'measurement') and.push({ $or: [{ width: null }, { height: null }] });
  if (and.length) q.$and = and;
  return q;
}

export async function syncSiteCount(projectId: string) {
  const n = await Site.countDocuments({ project: projectId, deletedAt: null });
  await Project.updateOne({ _id: projectId }, { siteCount: n });
  return n;
}

export async function listSites(projectId: string, q: z.infer<typeof siteListQuery>) {
  await requireProject(projectId);
  const filter = buildFilter(projectId, q);
  const [items, total] = await Promise.all([
    Site.find(filter).sort(parseSort(q.sort, SORTABLE, 'seq')).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Site.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

export async function siteStats(projectId: string) {
  await requireProject(projectId);
  const base = { project: new Types.ObjectId(projectId), deletedAt: null };
  const [total, districts, noAddr, noMobile, noMeasure, noGst, sqft] = await Promise.all([
    Site.countDocuments(base),
    Site.aggregate([{ $match: base }, { $group: { _id: { $ifNull: ['$district', ''] }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 500 }]),
    Site.countDocuments(buildFilter(projectId, { missing: 'address' })),
    Site.countDocuments(buildFilter(projectId, { missing: 'mobile' })),
    Site.countDocuments(buildFilter(projectId, { missing: 'measurement' })),
    Site.countDocuments(buildFilter(projectId, { missing: 'gst' })),
    Site.aggregate([{ $match: base }, { $group: { _id: null, s: { $sum: '$sqft' } } }]),
  ]);
  return {
    total, totalSqft: Math.round((sqft[0]?.s ?? 0) * 100) / 100,
    districts: districts.map((d) => ({ district: d._id || '(none)', count: d.n })),
    missing: { address: noAddr, mobile: noMobile, measurement: noMeasure, gst: noGst },
  };
}

type Raw = z.infer<typeof sitePatch>;
function prepare(raw: Raw, scenario: Scenario) {
  const n = normalise(raw as never, { scenario, defaultUnit: (raw.unit as Unit | undefined) ?? 'ft' });
  const v = n.value;
  const doc = { ...v, sqft: sqftOf(v.width, v.height, v.unit ?? 'ft', v.quantity ?? 1), dupKey: dupKeyOf(v) };
  return { ...n, doc };
}
const fail = (errors: { field: string; message: string }[]) => {
  throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', errors.map((e) => ({ path: e.field, message: e.message })));
};

export async function createSite(projectId: string, input: z.infer<typeof siteCreate>, actor: Actor) {
  const project = await requireProject(projectId);
  const { allowDuplicate, scenario: sc, ...raw } = input;
  const scenario = (sc as Scenario | undefined) ?? 'MEASUREMENT_REQUIRED';
  const n = prepare(raw, scenario);
  if (n.errors.length) fail(n.errors);
  if (n.doc.dupKey && !allowDuplicate && (await Site.exists({ project: projectId, dupKey: n.doc.dupKey, deletedAt: null }))) {
    throw AppError.conflict('A site with the same shop, dealer and district already exists');
  }
  const seq = await nextSeqBlock(`site:${projectId}`, 1);
  const site = await Site.create({
    ...n.doc, project: projectId, scenario, seq, siteCode: `${project.code}-S${String(seq).padStart(3, '0')}`,
    createdBy: actor.id, updatedBy: actor.id,
  });
  await syncSiteCount(projectId);
  await recordAudit({ actor, action: 'CREATE', entity: 'Site', entityId: site._id, project: projectId });
  return { site: site.toObject(), warnings: n.warnings };
}

export async function updateSite(id: string, patch: Raw, actor: Actor) {
  const before = await Site.findOne({ _id: id, deletedAt: null }).lean();
  if (!before) throw AppError.notFound('Site not found');
  const merged = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Record<string, unknown>;
  // Cleared text fields arrive as ''. Merge, then re-validate everything with the same rules as import.
  const scenario = (patch.scenario as Scenario | undefined) ?? (before.scenario as Scenario) ?? 'MEASUREMENT_REQUIRED';
  const n = prepare(merged as Raw, scenario);
  if (n.errors.length) fail(n.errors);
  // Editing must not silently create a duplicate of another shop in the same project.
  if (n.doc.dupKey && n.doc.dupKey !== before.dupKey && (await Site.exists({ project: before.project, dupKey: n.doc.dupKey, deletedAt: null, _id: { $ne: id } }))) {
    throw AppError.conflict('Another site with the same shop, dealer and district already exists');
  }
  const set = { ...n.doc, scenario, updatedBy: actor.id } as Record<string, unknown>;
  // A changed size or board type must be re-verified, so both approvals start again.
  const num = (v: unknown) => (v == null ? null : Number(v));
  if (num(n.doc.width) !== num(before.width) || num(n.doc.height) !== num(before.height) || (n.doc.boardType ?? null) !== (before.boardType ?? null) || (n.doc.unit ?? null) !== (before.unit ?? null)) {
    if (before.opsApproval !== 'PENDING' || before.bdApproval !== 'PENDING') {
      set.opsApproval = 'PENDING';
      set.bdApproval = 'PENDING';
    }
  }
  const unset: Record<string, 1> = {};
  for (const f of AUDIT_FIELDS) if (f !== 'scenario' && !(f in n.doc) && (before as never)[f] != null) unset[f] = 1;
  const after = await Site.findByIdAndUpdate(id, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { returnDocument: 'after' }).lean();
  await recordAudit({
    actor, action: 'UPDATE', entity: 'Site', entityId: id, project: before.project,
    changes: diff(before as never, { ...n.doc, scenario, ...Object.fromEntries(Object.keys(unset).map((k) => [k, null])) } as never, AUDIT_FIELDS),
  });
  return { site: after, warnings: n.warnings };
}

export async function deleteSite(id: string, actor: Actor) {
  const s = await Site.findOneAndUpdate({ _id: id, deletedAt: null }, { deletedAt: new Date(), updatedBy: actor.id });
  if (!s) throw AppError.notFound('Site not found');
  await syncSiteCount(String(s.project));
  await recordAudit({ actor, action: 'DELETE', entity: 'Site', entityId: id, project: s.project });
}

export async function duplicateSite(id: string, actor: Actor) {
  const s = await Site.findOne({ _id: id, deletedAt: null }).lean();
  if (!s) throw AppError.notFound('Site not found');
  const project = await requireProject(String(s.project));
  const seq = await nextSeqBlock(`site:${s.project}`, 1);
  const { _id, siteCode, seq: _seq, createdAt, updatedAt, importBatch, sourceRow, ...rest } = s as Record<string, any>;
  const copy = await Site.create({ ...rest, seq, siteCode: `${project.code}-S${String(seq).padStart(3, '0')}`, createdBy: actor.id, updatedBy: actor.id });
  await syncSiteCount(String(s.project));
  await recordAudit({ actor, action: 'DUPLICATE', entity: 'Site', entityId: copy._id, project: s.project, reason: `Duplicated from ${siteCode}` });
  return copy.toObject();
}

export async function bulk(projectId: string, b: z.infer<typeof bulkBody>, actor: Actor) {
  await requireProject(projectId);
  const filter = buildFilter(projectId, b.ids?.length ? {} : (b.filter ?? {}), b.ids);
  if (b.action === 'delete') {
    const r = await Site.updateMany(filter, { deletedAt: new Date(), updatedBy: actor.id });
    await syncSiteCount(projectId);
    await recordAudit({ actor, action: 'BULK_DELETE', entity: 'Site', entityId: new Types.ObjectId(projectId), project: projectId, reason: `${r.modifiedCount} sites` });
    return { affected: r.modifiedCount };
  }
  const patch = Object.fromEntries(Object.entries(b.patch ?? {}).filter(([, v]) => v !== undefined)) as Raw;
  const set: Record<string, unknown> = { updatedBy: actor.id };
  const touchesSize = 'width' in patch || 'height' in patch || 'unit' in patch;
  for (const [k, v] of Object.entries(patch)) {
    if (['width', 'height'].includes(k)) continue;
    set[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (!touchesSize) {
    const r = await Site.updateMany(filter, { $set: set });
    await recordAudit({ actor, action: 'BULK_UPDATE', entity: 'Site', entityId: new Types.ObjectId(projectId), project: projectId, reason: `${r.modifiedCount} sites`, changes: Object.entries(patch).map(([field, newValue]) => ({ field, oldValue: null, newValue })) });
    return { affected: r.modifiedCount };
  }
  // Size changes need per-row sq.ft recalculation.
  const rows = await Site.find(filter).select('width height unit quantity').lean();
  const ops = rows.map((r) => {
    const w = patch.width !== undefined ? Number(patch.width) : r.width;
    const h = patch.height !== undefined ? Number(patch.height) : r.height;
    if ((patch.width !== undefined && !(w! > 0)) || (patch.height !== undefined && !(h! > 0))) throw AppError.badRequest('Width and height must be positive numbers');
    const unit = (patch.unit as Unit | undefined) ?? r.unit ?? 'ft';
    return { updateOne: { filter: { _id: r._id }, update: { $set: { ...set, width: w, height: h, unit, sqft: sqftOf(w, h, unit, r.quantity ?? 1) } } } };
  });
  if (ops.length) await Site.bulkWrite(ops);
  await recordAudit({ actor, action: 'BULK_UPDATE', entity: 'Site', entityId: new Types.ObjectId(projectId), project: projectId, reason: `${ops.length} sites`, changes: Object.entries(patch).map(([field, newValue]) => ({ field, oldValue: null, newValue })) });
  return { affected: ops.length };
}

export async function exportSites(projectId: string, q: z.infer<typeof exportQuery>) {
  const project = await requireProject(projectId);
  const ids = q.ids?.split(',').filter((i) => /^[a-f\d]{24}$/i.test(i));
  const sites = await Site.find(buildFilter(projectId, q, ids)).sort(parseSort(q.sort, SORTABLE, 'seq')).limit(50000).lean();
  const cols = (q.columns?.split(',').filter((c) => c in EXPORT_COLUMNS) ?? []);
  const buffer = await buildSitesFile(sites as never, cols.length ? cols : DEFAULT_EXPORT, q.format, 'Sites');
  return { buffer, fileName: `${project.code}-sites.${q.format}`, count: sites.length };
}

export const templateFile = (scenario: Scenario) => buildTemplate(scenario);
export type { SiteInput };

