import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeq } from '../../common/counter.model';
import { escapeRegex, listQuery, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { parseWorkbook } from '../sites/excel.service';
import { GST_RE, normKey, normalisePhone } from '../sites/site.fields';
import { Site } from '../sites/site.model';
import { KYC_ITEMS, VENDOR_STATUSES, VENDOR_TYPES, Vendor } from './vendor.model';

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const opt = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const rate = z.coerce.number().min(0).max(100000).optional().or(z.literal('').transform(() => undefined));

export const vendorBody = z.object({
  name: z.string().trim().min(2, 'Enter the vendor name').max(150),
  type: z.enum(VENDOR_TYPES),
  contactPerson: opt(120),
  mobile: z.string().trim().min(1, 'Enter the mobile number').max(40),
  mobileAlt: opt(40),
  email: z.string().trim().toLowerCase().email('Enter a valid email').optional().or(z.literal('').transform(() => undefined)),
  gstin: opt(30),
  pan: opt(20),
  address: opt(400),
  district: opt(120),
  serviceAreas: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
  bank: z.object({ accountName: opt(120), accountNo: opt(30), ifsc: opt(20) }).optional(),
  ratePerShop: rate,
  farRatePerShop: rate,
  notes: opt(1000),
});
export const vendorPatch = vendorBody.partial();
export const vendorListQuery = listQuery.extend({
  status: z.enum(VENDOR_STATUSES).optional(),
  type: z.enum(VENDOR_TYPES).optional(),
  district: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export const statusBody = z
  .object({ status: z.enum(VENDOR_STATUSES), reason: z.string().trim().max(500).optional() })
  .refine((v) => !['INACTIVE', 'BLACKLISTED'].includes(v.status) || !!v.reason, { path: ['reason'], message: 'Give the reason' });
export const kycBody = z.object({ pan: z.boolean().optional(), gst: z.boolean().optional(), bank: z.boolean().optional(), address: z.boolean().optional() });

export type VendorInput = z.infer<typeof vendorBody>;
export type Issue = { field: string; message: string };

/** One validation path for manual add, edit and Excel import: normalises phone / GST / PAN / IFSC and reports every problem. */
export function checkVendor(raw: Partial<VendorInput>): { value: Partial<VendorInput>; errors: Issue[] } {
  const errors: Issue[] = [];
  const v: Partial<VendorInput> = { ...raw };
  const phone = normalisePhone(String(raw.mobile ?? ''));
  if (!raw.mobile) errors.push({ field: 'mobile', message: 'Enter the mobile number' });
  else if (!phone.primary) errors.push({ field: 'mobile', message: `Invalid mobile number "${raw.mobile}"` });
  else { v.mobile = phone.primary; if (phone.alt && !v.mobileAlt) v.mobileAlt = phone.alt; }
  if (raw.mobileAlt) { const a = normalisePhone(raw.mobileAlt); if (a.primary) v.mobileAlt = a.primary; else errors.push({ field: 'mobileAlt', message: 'Invalid alternate mobile number' }); }
  if (raw.gstin) { const g = raw.gstin.toUpperCase().replace(/\s/g, ''); if (GST_RE.test(g)) v.gstin = g; else errors.push({ field: 'gstin', message: `Invalid GST number "${raw.gstin}"` }); }
  if (raw.pan) { const p = raw.pan.toUpperCase().replace(/\s/g, ''); if (PAN_RE.test(p)) v.pan = p; else errors.push({ field: 'pan', message: `Invalid PAN "${raw.pan}"` }); }
  if (raw.bank?.ifsc) { const i = raw.bank.ifsc.toUpperCase().replace(/\s/g, ''); if (IFSC_RE.test(i)) v.bank = { ...raw.bank, ifsc: i }; else errors.push({ field: 'bank.ifsc', message: 'Invalid IFSC code' }); }
  if (raw.ratePerShop != null && raw.farRatePerShop != null && raw.farRatePerShop < raw.ratePerShop) errors.push({ field: 'farRatePerShop', message: 'Far rate cannot be lower than the normal rate' });
  return { value: v, errors };
}
const fail = (errors: Issue[]) => { throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', errors.map((e) => ({ path: e.field, message: e.message }))); };

export async function duplicateOf(v: { mobile?: string | undefined; name?: string | undefined; district?: string | undefined }, exceptId?: string) {
  const ne = exceptId ? { _id: { $ne: exceptId } } : {};
  if (v.mobile) {
    const m = await Vendor.findOne({ mobile: v.mobile, deletedAt: null, ...ne }).select('name code').lean();
    if (m) return `Mobile ${v.mobile} already belongs to ${m.name} (${m.code})`;
  }
  if (v.name) {
    const n = await Vendor.findOne({ nameKey: normKey(v.name), district: v.district ?? null, deletedAt: null, ...ne }).select('name code').lean();
    if (n) return `${n.name} (${n.code}) is already registered${v.district ? ` in ${v.district}` : ''}`;
  }
  return null;
}

const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;

export async function createVendor(body: z.infer<typeof vendorBody>, actor: Actor, source: 'MANUAL' | 'IMPORT' = 'MANUAL') {
  const { value, errors } = checkVendor(body);
  if (errors.length) fail(errors);
  const dup = await duplicateOf(value as never);
  if (dup) throw AppError.conflict(dup);
  const code = `VND-${String(await nextSeq('vendor')).padStart(4, '0')}`;
  const v = await Vendor.create({ ...strip(value), code, nameKey: normKey(body.name), source, status: 'PENDING_KYC', createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'Vendor', entityId: v._id, reason: `${code} ${v.name}` });
  return v.toObject();
}

const AUDIT = ['name', 'type', 'contactPerson', 'mobile', 'email', 'gstin', 'pan', 'address', 'district', 'ratePerShop', 'farRatePerShop'];
export async function updateVendor(id: string, patch: z.infer<typeof vendorPatch>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  const before = v.toObject() as Record<string, unknown>;
  const merged = { ...before, ...strip(patch) } as Partial<VendorInput>;
  const { value, errors } = checkVendor(merged);
  if (errors.length) fail(errors);
  const dup = await duplicateOf({ mobile: value.mobile, name: value.name, district: value.district }, id);
  if (dup) throw AppError.conflict(dup);
  v.set({ ...strip(patch), ...(patch.mobile ? { mobile: value.mobile } : {}), ...(patch.gstin ? { gstin: value.gstin } : {}), ...(patch.pan ? { pan: value.pan } : {}), ...(patch.bank ? { bank: value.bank } : {}), ...(patch.name ? { nameKey: normKey(patch.name) } : {}), updatedBy: actor.id });
  await v.save();
  await recordAudit({ actor, action: 'UPDATE', entity: 'Vendor', entityId: v._id, changes: diff(before, v.toObject() as Record<string, unknown>, AUDIT) });
  return v.toObject();
}

export async function setKyc(id: string, body: z.infer<typeof kycBody>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  for (const k of KYC_ITEMS) if (body[k] !== undefined) v.set(`kyc.${k}`, body[k]);
  if (kycComplete(v.toObject())) v.set({ 'kyc.verifiedAt': new Date(), 'kyc.verifiedBy': actor.id });
  else v.set({ 'kyc.verifiedAt': undefined, 'kyc.verifiedBy': undefined });
  v.updatedBy = actor.id as never;
  await v.save();
  await recordAudit({ actor, action: 'KYC_UPDATE', entity: 'Vendor', entityId: v._id, changes: Object.entries(body).map(([field, newValue]) => ({ field: `kyc.${field}`, oldValue: null, newValue })) });
  return v.toObject();
}

/** PAN, bank and address proof are always needed; GST is needed for an organization. */
export function kycComplete(v: { type?: string; kyc?: Record<string, unknown> | null }) {
  const k = v.kyc ?? {};
  return !!(k.pan && k.bank && k.address && (v.type !== 'ORGANIZATION' || k.gst));
}

export async function setStatus(id: string, body: z.infer<typeof statusBody>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  if (body.status === 'ACTIVE' && !kycComplete(v.toObject())) throw AppError.conflict('Complete the KYC checklist before activating this vendor');
  if (body.status === 'PENDING_KYC') throw AppError.badRequest('A vendor cannot be moved back to KYC pending');
  const old = v.status;
  v.set({ status: body.status, statusReason: body.status === 'ACTIVE' ? undefined : body.reason, updatedBy: actor.id });
  await v.save();
  await recordAudit({ actor, action: 'STATUS_CHANGE', entity: 'Vendor', entityId: v._id, changes: [{ field: 'status', oldValue: old, newValue: body.status }], reason: body.reason });
  return v.toObject();
}

export async function deleteVendor(id: string, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  const used = await Site.countDocuments({ vendor: id, deletedAt: null });
  if (used) throw AppError.conflict(`${used} shop(s) are allocated to this vendor. Move them first, or mark the vendor inactive`);
  v.deletedAt = new Date();
  await v.save();
  await recordAudit({ actor, action: 'DELETE', entity: 'Vendor', entityId: v._id });
}

export async function getVendor(id: string) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null }).lean();
  if (!v) throw AppError.notFound('Vendor not found');
  return { ...v, allocatedShops: await Site.countDocuments({ vendor: id, deletedAt: null }) };
}

export async function listVendors(q: z.infer<typeof vendorListQuery>) {
  const f: Record<string, unknown> = { deletedAt: null };
  if (q.status) f.status = q.status;
  if (q.type) f.type = q.type;
  if (q.district) f.district = new RegExp(`^${escapeRegex(q.district)}$`, 'i');
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ name: re }, { code: re }, { mobile: re }, { contactPerson: re }, { district: re }, { serviceAreas: re }]; }
  const [items, total, counts] = await Promise.all([
    Vendor.find(f).sort(parseSort(q.sort, ['name', 'code', 'district', 'status', 'createdAt'], 'name')).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Vendor.countDocuments(f),
    Vendor.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const summary: Record<string, number> = { PENDING_KYC: 0, ACTIVE: 0, INACTIVE: 0, BLACKLISTED: 0 };
  for (const c of counts) summary[c._id] = c.n;
  const shopCounts = await Site.aggregate([{ $match: { vendor: { $in: items.map((i) => i._id) }, deletedAt: null } }, { $group: { _id: '$vendor', n: { $sum: 1 } } }]);
  const byVendor = new Map(shopCounts.map((s) => [String(s._id), s.n]));
  return { items: items.map((i) => ({ ...i, allocatedShops: byVendor.get(String(i._id)) ?? 0 })), meta: pageMeta(q.page, q.limit, total), summary: { ...summary, ALL: Object.values(summary).reduce((a, b) => a + b, 0) } };
}

/** Vendors that can be given shops (active only), light fields. */
export const activeVendors = () => Vendor.find({ status: 'ACTIVE', deletedAt: null }).sort({ name: 1 }).select('code name type district serviceAreas ratePerShop farRatePerShop mobile').limit(500).lean();

/* ------------------------------- Excel template / import / export ------------------------------- */

