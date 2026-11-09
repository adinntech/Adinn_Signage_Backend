import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { exportFormat } from '../../common/tabular';
import { nextSeq } from '../../common/counter.model';
import { escapeRegex, listQuery, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { discardStoredFiles, eraseStoredFile, removeStoredFiles, storedFileUrl, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { parseWorkbook } from '../sites/excel.service';
import { GST_RE, normKey, normalisePhone } from '../sites/site.fields';
import { Site } from '../sites/site.model';
import { KYC_DOC_TYPES, KYC_ITEMS, VENDOR_STATUSES, VENDOR_TYPES, Vendor } from './vendor.model';
import { CostPlan } from '../costing/costing.model';
import { Notification } from '../notifications/notification.model';
import { deleteUser } from '../users/user.service';
import { User } from '../users/user.model';
import { VendorPrice } from './vendorPrice.model';
import { VendorTypeOption } from './vendorType.model';
import { lookupGst } from './gstPortal.service';

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_RE = /^[1-9]\d{5}$/;
const AADHAAR_RE = /^[2-9]\d{11}$/;
const opt = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const rate = z.coerce.number().min(0).max(100000).optional().or(z.literal('').transform(() => undefined));

export const vendorBody = z.object({
  name: z.string().trim().min(2, 'Enter the vendor name').max(150),
  type: z.enum(VENDOR_TYPES),
  /** The vendor type chosen in the form (a VendorTypeOption name). Its rule class overrides `type`. */
  typeName: opt(60),
  contactPerson: opt(120),
  designation: opt(80),
  mobile: z.string().trim().min(1, 'Enter the mobile number').max(40),
  mobileAlt: opt(40),
  email: z.string().trim().toLowerCase().email('Enter a valid email').optional().or(z.literal('').transform(() => undefined)),
  gstin: opt(30),
  pan: opt(20),
  address: opt(400),
  pincode: opt(10),
  state: opt(60),
  district: opt(120),
  aadhaar: opt(20),
  /** Does the vendor have a GST number? Sent by the registration form; it decides the mandatory documents. */
  hasGst: z.boolean().optional(),
  /** The full registration form (not quick registration): every detail below is mandatory. Not stored. */
  fullDetails: z.boolean().optional(),
  serviceAreas: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
  skills: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  bank: z.object({ accountName: opt(120), accountNo: opt(30), ifsc: opt(20) }).optional(),
  ratePerShop: rate,
  farRatePerShop: rate,
  notes: opt(1000),
  /** Set when the form was filled from a Zoho Books vendor (see GET /vendors/zoho/:vendorNo). */
  zohoContactId: z.string().regex(/^\d{10,25}$/, 'Invalid Zoho contact id').optional(),
  zohoVendorNo: z.string().regex(/^\d{2,8}$/, 'Invalid Zoho vendor number').optional(),
});
export const vendorPatch = vendorBody.partial();
export const zohoVendorNoParam = z.object({ vendorNo: z.string().trim().regex(/^\d{2,8}$/, 'Enter the Zoho vendor number (2 to 8 digits)') });
export const kycFileBody = z.object({ docType: z.enum(KYC_DOC_TYPES) });
export const vendorTypeBody = z.object({ name: z.string().trim().min(2, 'Enter the vendor type name').max(60), rules: z.enum(VENDOR_TYPES) });
export const vendorIdBody = z.object({ vendorNo: z.string().trim().regex(/^\d{2,8}$/, 'Enter the vendor ID (2 to 8 digits)') });
export const priceBody = z.object({ ratePerShop: z.coerce.number().min(0).max(100000).nullable(), farRatePerShop: z.coerce.number().min(0).max(100000).nullable().optional(), skills: z.array(z.string().trim().min(1).max(60)).max(20).optional() });
export const skillBody = z.object({ name: z.string().trim().min(2, 'Enter the skill name').max(60) });
export const vendorListQuery = listQuery.extend({
  status: z.enum(VENDOR_STATUSES).optional(),
  type: z.enum(VENDOR_TYPES).optional(),
  district: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export const statusBody = z
  .object({ status: z.enum(VENDOR_STATUSES), reason: z.string().trim().max(500).optional() })
  .refine((v) => !['INACTIVE', 'BLACKLISTED'].includes(v.status) || !!v.reason, { path: ['reason'], message: 'Give the reason' });
export const kycBody = z.object({ pan: z.boolean().optional(), gst: z.boolean().optional(), bank: z.boolean().optional(), address: z.boolean().optional(), aadhaar: z.boolean().optional() });

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
  if (raw.pincode) { const p = raw.pincode.replace(/\s/g, ''); if (PINCODE_RE.test(p)) v.pincode = p; else errors.push({ field: 'pincode', message: 'Enter a 6-digit pincode' }); }
  if (raw.aadhaar) { const a = raw.aadhaar.replace(/[\s-]/g, ''); if (AADHAAR_RE.test(a)) v.aadhaar = a; else errors.push({ field: 'aadhaar', message: 'Aadhaar number must be 12 digits' }); }
  if (raw.pan) { const p = raw.pan.toUpperCase().replace(/\s/g, ''); if (PAN_RE.test(p)) v.pan = p; else errors.push({ field: 'pan', message: `Invalid PAN "${raw.pan}"` }); }
  if (raw.bank?.ifsc) { const i = raw.bank.ifsc.toUpperCase().replace(/\s/g, ''); if (IFSC_RE.test(i)) v.bank = { ...raw.bank, ifsc: i }; else errors.push({ field: 'bank.ifsc', message: 'Invalid IFSC code' }); }
  if (raw.bank?.accountNo && !/^\d{9,18}$/.test(raw.bank.accountNo)) errors.push({ field: 'bank.accountNo', message: 'Account number must be 9 to 18 digits' });
  if (raw.ratePerShop != null && raw.farRatePerShop != null && raw.farRatePerShop < raw.ratePerShop) errors.push({ field: 'farRatePerShop', message: 'Far rate cannot be lower than the normal rate' });
  return { value: v, errors };
}
const fail = (errors: Issue[]) => { throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', errors.map((e) => ({ path: e.field, message: e.message }))); };

/**
 * Only the mobile number must be new. The name is NOT checked: the same firm may be registered again with a different
 * phone, email, address or PAN, so a repeated name is not a duplicate.
 */
export async function duplicateOf(v: { mobile?: string | undefined }, exceptId?: string) {
  if (!v.mobile) return null;
  const ne = exceptId ? { _id: { $ne: exceptId } } : {};
  const m = await Vendor.findOne({ mobile: v.mobile, deletedAt: null, ...ne }).select('name code').lean();
  return m ? `Mobile ${v.mobile} already belongs to ${m.name} (${m.code})` : null;
}

const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;

/** An organization must have a contact person (the Recce contact) and a GST number; a one-man / freelancer vendor needs neither. */
export function organizationIssues(v: { type?: string | undefined; contactPerson?: string | undefined; gstin?: string | undefined }): Issue[] {
  if (v.type !== 'ORGANIZATION') return [];
  const e: Issue[] = [];
  if (!v.contactPerson?.trim()) e.push({ field: 'contactPerson', message: 'Enter the contact person for an organization' });
  if (!v.gstin?.trim()) e.push({ field: 'gstin', message: 'Enter the GST number for an organization' });
  return e;
}

/**
 * New registration form (it sends `hasGst`): the GST number when the vendor has GST, otherwise the Aadhaar number; with the
 * full form also the contact person, designation, email, address, pincode, state, city and the PAN number. Older vendors and
 * imports (no `hasGst`) keep the organization rule above.
 */
export function onboardingIssues(v: { hasGst?: boolean | undefined; fullDetails?: boolean | undefined; gstin?: string | undefined; pan?: string | undefined; aadhaar?: string | undefined; contactPerson?: string | undefined; designation?: string | undefined; email?: string | undefined; address?: string | undefined; pincode?: string | undefined; state?: string | undefined; district?: string | undefined }): Issue[] {
  const e: Issue[] = [];
  const need = (field: string, ok: unknown, message: string) => { if (!String(ok ?? '').trim()) e.push({ field, message }); };
  if (v.hasGst) need('gstin', v.gstin, 'Enter the GST number');
  if (!v.fullDetails) return e;
  need('contactPerson', v.contactPerson, 'Enter the contact person name');
  need('designation', v.designation, 'Enter the designation');
  need('email', v.email, 'Enter the email');
  need('address', v.address, 'Enter the address');
  need('pincode', v.pincode, 'Enter the pincode');
  need('state', v.state, 'Choose the state');
  need('district', v.district, 'Enter the city / district');
  need('pan', v.pan, 'Enter the PAN number');
  if (!v.hasGst) need('aadhaar', v.aadhaar, 'Enter the Aadhaar number');
  return e;
}

/**
 * Checks a typed GST number against what the company already has (the Zoho Books vendors and the registered vendors) and,
 * when GST_VERIFY_KEY is set, against the GST portal through a paid lookup service (legal name, status, address, PAN).
 */
export async function verifyGstin(raw: string) {
  const gstin = raw.trim().toUpperCase();
  if (!GST_RE.test(gstin)) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'gstin', message: 'Enter a valid GST number' }]);
  const [zoho, registered, portal] = await Promise.all([
    VendorPrice.findOne({ gstin }).select('name vendorNo zohoStatus city zohoContactId').lean(),
    Vendor.findOne({ gstin, deletedAt: null }).select('name code status').lean(),
    lookupGst(gstin),
  ]);
  return {
    gstin,
    /** The GST portal's own details (legal name, status, address, PAN) when the paid lookup is set up (GST_VERIFY_KEY). */
    portal,
    zoho: zoho?.name ? { name: zoho.name, vendorNo: zoho.vendorNo ?? null, status: zoho.zohoStatus, city: zoho.city ?? null, zohoContactId: zoho.zohoContactId } : null,
    registered: registered ? { id: String(registered._id), name: registered.name, code: registered.code, status: registered.status } : null,
  };
}

/* ------------------------------------- vendor types ------------------------------------- */

const BUILT_IN_TYPES = [
  { name: 'Organization', rules: 'ORGANIZATION' },
  { name: 'One-man / Freelancer', rules: 'ONE_MAN' },
] as const;

/** The type choices of the registration form. The two built-in ones are created on first use. */
export async function listVendorTypes() {
  await VendorTypeOption.bulkWrite(
    BUILT_IN_TYPES.map((t) => ({ updateOne: { filter: { nameKey: normKey(t.name) }, update: { $setOnInsert: { name: t.name, nameKey: normKey(t.name), rules: t.rules, builtIn: true } }, upsert: true } })),
  );
  const all = await VendorTypeOption.find().lean();
  const order = (t: { builtIn?: boolean | null; name: string }) => (t.builtIn ? BUILT_IN_TYPES.findIndex((b) => b.name === t.name) : BUILT_IN_TYPES.length);
  return all.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

export async function addVendorType(body: z.infer<typeof vendorTypeBody>, actor: Actor) {
  await listVendorTypes();
  const nameKey = normKey(body.name);
  if (await VendorTypeOption.exists({ nameKey })) throw AppError.conflict(`"${body.name}" is already in the list`);
  const t = await VendorTypeOption.create({ name: body.name, nameKey, rules: body.rules, createdBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'VendorTypeOption', entityId: t._id, reason: `${body.name} (${body.rules})` });
  return t.toObject();
}

/** The chosen type name decides the rule class on the server; an unknown name is rejected. */
async function resolveType<T extends { type?: string | undefined; typeName?: string | undefined }>(body: T): Promise<T> {
  if (!body.typeName) return body;
  await listVendorTypes();
  const t = await VendorTypeOption.findOne({ nameKey: normKey(body.typeName) }).lean();
  if (!t) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'typeName', message: 'Choose a vendor type from the list' }]);
  return { ...body, type: t.rules, typeName: t.name };
}

export async function createVendor(rawBody: z.infer<typeof vendorBody>, actor: Actor, source: 'MANUAL' | 'IMPORT' | 'ZOHO' = 'MANUAL') {
  const { fullDetails, ...body } = await resolveType(rawBody);
  const { value, errors } = checkVendor(body);
  if (source !== 'IMPORT') errors.push(...(value.hasGst !== undefined ? onboardingIssues({ ...value, fullDetails }) : organizationIssues(value)));
  if (errors.length) fail(errors);
  const dup = await duplicateOf(value as never);
  if (dup) throw AppError.conflict(dup);
  if (body.zohoContactId) {
    const z = await Vendor.findOne({ zohoContactId: body.zohoContactId, deletedAt: null }).select('name code').lean();
    if (z) throw AppError.conflict(`This Zoho vendor is already registered as ${z.name} (${z.code})`);
    source = 'ZOHO';
  }
  const code = `VND-${String(await nextSeq('vendor')).padStart(4, '0')}`;
  // A price typed earlier for this Zoho vendor (Vendor price management) is carried over, so it is typed once only.
  const prior = body.zohoContactId ? await VendorPrice.findOne({ zohoContactId: body.zohoContactId }).lean() : null;
  if (prior) { value.ratePerShop ??= prior.ratePerShop ?? undefined; value.farRatePerShop ??= prior.farRatePerShop ?? undefined; if (!value.skills?.length && prior.skills?.length) value.skills = prior.skills; }
  const v = await Vendor.create({ ...strip(value), code, nameKey: normKey(body.name), source, status: 'PENDING_KYC', createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'Vendor', entityId: v._id, reason: `${code} ${v.name}` });
  return v.toObject();
}

const AUDIT = ['name', 'type', 'contactPerson', 'designation', 'mobile', 'email', 'gstin', 'pan', 'address', 'pincode', 'state', 'district', 'hasGst', 'ratePerShop', 'farRatePerShop'];
export async function updateVendor(id: string, rawPatch: z.infer<typeof vendorPatch>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  const { fullDetails, ...patch } = await resolveType(rawPatch);
  const before = v.toObject() as Record<string, unknown>;
  const merged = { ...before, ...strip(patch) } as Partial<VendorInput>;
  const { value, errors } = checkVendor(merged);
  // Older vendors may lack these; the organization rules are checked only when the type, contact person or GST is being changed.
  if (value.hasGst !== undefined) { if (patch.hasGst !== undefined || patch.gstin !== undefined) errors.push(...onboardingIssues({ ...value, fullDetails })); }
  else if (patch.type || patch.typeName || patch.contactPerson !== undefined || patch.gstin !== undefined) errors.push(...organizationIssues(value));
  if (errors.length) fail(errors);
  const dup = await duplicateOf({ mobile: value.mobile }, id);
  if (dup) throw AppError.conflict(dup);
  v.set({ ...strip(patch), ...(patch.pincode ? { pincode: value.pincode } : {}), ...(patch.aadhaar ? { aadhaar: value.aadhaar } : {}), ...(patch.mobile ? { mobile: value.mobile } : {}), ...(patch.gstin ? { gstin: value.gstin } : {}), ...(patch.pan ? { pan: value.pan } : {}), ...(patch.bank ? { bank: value.bank } : {}), ...(patch.name ? { nameKey: normKey(patch.name) } : {}), updatedBy: actor.id });
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

/**
 * The documents that must be uploaded. Registered with the new form (`hasGst` set): PAN, cancelled cheque (bank) and the GST
 * certificate when the vendor has GST, otherwise the Aadhaar. Older vendors: PAN and bank, plus GST for an organization.
 * Address proof and other documents (for example the vendor agreement) are always optional.
 */
export function requiredKycDocs(v: { type?: string | undefined; hasGst?: boolean | null | undefined }): ('pan' | 'gst' | 'bank' | 'aadhaar')[] {
  if (v.hasGst === true) return ['pan', 'gst', 'bank'];
  if (v.hasGst === false) return ['pan', 'aadhaar', 'bank'];
  return v.type === 'ORGANIZATION' ? ['pan', 'gst', 'bank'] : ['pan', 'bank'];
}

/** The KYC checklist is complete when every required document is ticked. */
export function kycComplete(v: { type?: string; hasGst?: boolean | null; kyc?: Record<string, unknown> | null }) {
  const k = v.kyc ?? {};
  return requiredKycDocs(v).every((d) => !!k[d]);
}

export async function setStatus(id: string, body: z.infer<typeof statusBody>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  if (body.status === 'ACTIVE' && !kycComplete(v.toObject())) throw AppError.conflict('Complete the KYC checklist before activating this vendor');
  if (body.status === 'PENDING_KYC') throw AppError.badRequest('A vendor cannot be moved back to KYC pending');
  if (body.status === 'ACTIVE' && v.registration?.mailSentAt && !v.zohoVendorNo) throw AppError.conflict('Enter the vendor ID received from Accounts before activating this vendor');
  const old = v.status;
  v.set({ status: body.status, statusReason: body.status === 'ACTIVE' ? undefined : body.reason, updatedBy: actor.id });
  await v.save();
  await recordAudit({ actor, action: 'STATUS_CHANGE', entity: 'Vendor', entityId: v._id, changes: [{ field: 'status', oldValue: old, newValue: body.status }], reason: body.reason });
  return v.toObject();
}

/**
 * Deletes a vendor with everything that belongs to it, so a wrongly registered vendor leaves nothing behind: the KYC scans
 * (erased from storage first), the vendor's mobile-app logins (signed out and removed) and their notifications, and the
 * vendor record itself with its mail history, draft and typed details. Only the audit trail stays. A vendor that holds
 * shops or is used in a project cost plan is not deleted: mark it inactive instead.
 */
export async function deleteVendor(id: string, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  const used = await Site.countDocuments({ vendor: id, deletedAt: null });
  if (used) throw AppError.conflict(`${used} shop(s) are allocated to this vendor. Move them first, or mark the vendor inactive`);
  const plans = await CostPlan.countDocuments({ 'legs.vendor': v._id });
  if (plans) throw AppError.conflict(`This vendor is used in ${plans} project cost plan(s). Mark it inactive instead`);
  // Files first: if one cannot be erased nothing changes and the person can retry.
  const { failed } = await removeStoredFiles((v.kycFiles ?? []) as unknown as StoredFile[]);
  if (failed.length) throw AppError.conflict(`Could not remove these files from storage, so the vendor was not deleted: ${failed.join(', ')}. Try again.`);
  const logins = await User.find({ role: 'VENDOR', vendorId: v._id, deletedAt: null }).select('_id').lean();
  for (const u of logins) await deleteUser(String(u._id), actor);
  if (logins.length) await Notification.deleteMany({ recipient: { $in: logins.map((u) => u._id) } });
  await Vendor.deleteOne({ _id: v._id });
  await recordAudit({ actor, action: 'DELETE', entity: 'Vendor', entityId: v._id, reason: `${v.code} ${v.name}` });
}

const MAX_KYC_FILES_PER_ITEM = 3;
const MAX_OTHER_FILES = 5;
const vendorOwner = (id: unknown) => ({ entity: 'Vendor' as const, id: String(id) });

/** Documents still to be uploaded before the registration mail goes (see requiredKycDocs). */
export function missingKycDocs(v: { type?: string; hasGst?: boolean | null; kycFiles?: ArrayLike<object> | null }) {
  const have = new Set(Array.from(v.kycFiles ?? [], (f) => (f as { docType?: string }).docType));
  return requiredKycDocs(v).filter((k) => !have.has(k));
}

/** KYC scans for one document type (up to three per type, five under "other"). They do not tick the checklist: Operations ticks it after viewing them. */
export async function addKycFiles(id: string, docType: (typeof KYC_DOC_TYPES)[number], files: UploadedFile[], actor: Actor) {
  if (!files.length) throw AppError.badRequest('Choose the document to upload');
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  if (v.status === 'BLACKLISTED') throw AppError.conflict('This vendor is blacklisted');
  const have = (v.kycFiles as unknown as { docType?: string }[]).filter((f) => f.docType === docType).length;
  const max = docType === 'other' ? MAX_OTHER_FILES : MAX_KYC_FILES_PER_ITEM;
  if (have + files.length > max) throw AppError.badRequest(`Up to ${max} files per document type`);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeEmbeddedFile({ category: 'VENDOR_KYC_DOCUMENT', clientName: v.name, folderKey: v.code, file: f, actor, owner: vendorOwner(v._id) }));
    await Vendor.updateOne({ _id: v._id }, { $push: { kycFiles: { $each: stored.map((s) => ({ ...s, docType })) } }, $set: { updatedBy: actor.id } });
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  return getVendor(id);
}

export async function removeKycFile(id: string, fileId: string, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  const file = v.kycFiles.find((f) => String(f.fileId) === fileId);
  if (!file) throw AppError.notFound('File not found');
  await Vendor.updateOne({ _id: v._id }, { $pull: { kycFiles: { fileId: file.fileId } }, $set: { updatedBy: actor.id } });
  await eraseStoredFile(file as unknown as StoredFile, actor, vendorOwner(v._id));
  return getVendor(id);
}

/** Short-lived link to view or download one KYC scan. */
export async function kycFileUrl(id: string, fileId: string) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null }).select('kycFiles').lean();
  const file = v?.kycFiles?.find((f) => String(f.fileId) === fileId);
  if (!file) throw AppError.notFound('File not found');
  return storedFileUrl(file as unknown as StoredFile);
}

export async function getVendor(id: string) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null }).populate('createdBy updatedBy', 'name').lean();
  if (!v) throw AppError.notFound('Vendor not found');
  return { ...v, allocatedShops: await Site.countDocuments({ vendor: id, deletedAt: null }) };
}

/** The list screen and the export use the same filter, so an export holds exactly the rows the filters show. */
export function vendorFilter(q: Pick<z.infer<typeof vendorListQuery>, 'status' | 'type' | 'district' | 'q'>) {
  const f: Record<string, unknown> = { deletedAt: null };
  if (q.status) f.status = q.status;
  if (q.type) f.type = q.type;
  if (q.district) f.district = new RegExp(`^${escapeRegex(q.district)}$`, 'i');
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ name: re }, { code: re }, { mobile: re }, { contactPerson: re }, { district: re }, { serviceAreas: re }]; }
  return f;
}
export const vendorExportQuery = z.object({ format: exportFormat, status: z.enum(VENDOR_STATUSES).optional(), type: z.enum(VENDOR_TYPES).optional(), district: z.string().trim().max(120).optional(), q: z.string().trim().max(100).optional() });

export async function listVendors(q: z.infer<typeof vendorListQuery>) {
  const f = vendorFilter(q);
  const [items, total, counts] = await Promise.all([
    Vendor.find(f).sort(parseSort(q.sort, ['name', 'code', 'district', 'status', 'createdAt'], 'name')).skip((q.page - 1) * q.limit).limit(q.limit).populate('createdBy updatedBy', 'name').lean(),
    Vendor.countDocuments(f),
    Vendor.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  // "New" = registered here through New vendor / upload, not brought in from Zoho: these are the ones that go through KYC.
  const fresh = await Vendor.aggregate([{ $match: { deletedAt: null, zohoContactId: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const newBy = Object.fromEntries(fresh.map((c) => [c._id as string, c.n as number]));
  const summary: Record<string, number> = { PENDING_KYC: 0, ACTIVE: 0, INACTIVE: 0, BLACKLISTED: 0 };
  for (const c of counts) summary[c._id] = c.n;
  const shopCounts = await Site.aggregate([{ $match: { vendor: { $in: items.map((i) => i._id) }, deletedAt: null } }, { $group: { _id: '$vendor', n: { $sum: 1 } } }]);
  const byVendor = new Map(shopCounts.map((s) => [String(s._id), s.n]));
  return { items: items.map((i) => ({ ...i, allocatedShops: byVendor.get(String(i._id)) ?? 0 })), meta: pageMeta(q.page, q.limit, total), summary: { ...summary, ALL: Object.values(summary).reduce((a, b) => a + b, 0), NEW: Object.values(newBy).reduce((a, b) => a + b, 0), NEW_PENDING_KYC: newBy.PENDING_KYC ?? 0, NEW_ACTIVE: newBy.ACTIVE ?? 0 } };
}

/** Vendors that can be given shops (active only), light fields. */
export const activeVendors = () => Vendor.find({ status: 'ACTIVE', deletedAt: null }).sort({ name: 1 }).select('code name type district serviceAreas ratePerShop farRatePerShop mobile').limit(500).lean();

/**
 * Accounts replied to the registration mail with the vendor ID (Zoho vendor number). Typing it here is the proof that the
 * vendor now exists in Zoho Books, so a vendor waiting for KYC becomes ACTIVE at once (an inactive or blacklisted vendor
 * keeps its status). Only after the registration mail was really sent.
 */
export async function setVendorId(id: string, body: z.infer<typeof vendorIdBody>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  if (!v.registration?.mailSentAt) throw AppError.conflict('Send the registration mail first');
  const taken = await Vendor.findOne({ zohoVendorNo: body.vendorNo, deletedAt: null, _id: { $ne: v._id } }).select('name code').lean();
  if (taken) throw AppError.conflict(`Vendor ID ${body.vendorNo} already belongs to ${taken.name} (${taken.code})`);
  const old = v.zohoVendorNo ?? null;
  const activate = v.status === 'PENDING_KYC';
  v.set({ zohoVendorNo: body.vendorNo, 'registration.vendorIdAt': new Date(), 'registration.vendorIdBy': actor.id, updatedBy: actor.id, ...(activate ? { status: 'ACTIVE', statusReason: undefined } : {}) });
  await v.save();
  await recordAudit({ actor, action: 'VENDOR_ID_RECEIVED', entity: 'Vendor', entityId: v._id, changes: [{ field: 'zohoVendorNo', oldValue: old, newValue: body.vendorNo }] });
  if (activate) await recordAudit({ actor, action: 'STATUS_CHANGE', entity: 'Vendor', entityId: v._id, changes: [{ field: 'status', oldValue: 'PENDING_KYC', newValue: 'ACTIVE' }], reason: 'Vendor ID received from Accounts' });
  return getVendor(id);
}

/* ------------------------------- Excel template / import / export ------------------------------- */

