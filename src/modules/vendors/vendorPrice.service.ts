import type { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { normKey } from '../sites/site.fields';
import { zohoGet } from '../zoho/zoho.client';
import { toZohoVendorDetail, toZohoVendorRow, type ZohoContact } from '../zoho/zoho.mapper';
import { Vendor } from './vendor.model';
import type { priceBody, skillBody } from './vendor.service';
import { VendorPrice } from './vendorPrice.model';
import { VendorSkill } from './vendorSkill.model';

export type Price = { ratePerShop: number | null; farRatePerShop: number | null; skills: string[]; source: 'VENDOR' | 'ZOHO' | null };
const NONE: Price = { ratePerShop: null, farRatePerShop: null, skills: [], source: null };

/* --------------------------------------- skills --------------------------------------- */

export const listVendorSkills = () => VendorSkill.find().sort({ name: 1 }).lean();

export async function addVendorSkill(body: z.infer<typeof skillBody>, actor: Actor) {
  const nameKey = normKey(body.name);
  if (await VendorSkill.exists({ nameKey })) throw AppError.conflict(`"${body.name}" is already in the skills list`);
  const s = await VendorSkill.create({ name: body.name, nameKey, createdBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'VendorSkill', entityId: s._id, reason: body.name });
  return s.toObject();
}

/** Skills must come from the list (so the same skill is never spelled two ways); returns them as stored. */
async function checkedSkills(names: string[]): Promise<string[]> {
  const keys = [...new Set(names.map(normKey))];
  const found = await VendorSkill.find({ nameKey: { $in: keys } }).lean();
  const missing = keys.filter((k) => !found.some((f) => f.nameKey === k));
  if (missing.length) throw new AppError(422, 'VALIDATION_ERROR', 'Validation failed', [{ path: 'skills', message: 'Choose skills from the list, or add the new skill first' }]);
  return keys.map((k) => found.find((f) => f.nameKey === k)!.name);
}

/* --------------------------------------- prices --------------------------------------- */

/** Price per shop and skills of each Zoho vendor: the registered vendor's own when it is registered, otherwise the ones typed in Vendor master. */
export async function pricesOfZohoVendors(contactIds: string[]): Promise<Map<string, Price>> {
  const [vendors, typed] = await Promise.all([
    Vendor.find({ zohoContactId: { $in: contactIds }, deletedAt: null }).select('zohoContactId ratePerShop farRatePerShop skills').lean(),
    VendorPrice.find({ zohoContactId: { $in: contactIds } }).lean(),
  ]);
  const out = new Map<string, Price>();
  for (const t of typed) out.set(t.zohoContactId, { ratePerShop: t.ratePerShop ?? null, farRatePerShop: t.farRatePerShop ?? null, skills: t.skills ?? [], source: 'ZOHO' });
  for (const v of vendors) if (v.zohoContactId) out.set(v.zohoContactId, { ratePerShop: v.ratePerShop ?? null, farRatePerShop: v.farRatePerShop ?? null, skills: v.skills ?? [], source: 'VENDOR' });
  return out;
}

/** Zoho contact ids that already have a cost added (used by the "cost added / not added" filter). */
export async function pricedZohoContactIds(): Promise<string[]> {
  const [vendors, typed] = await Promise.all([
    Vendor.find({ zohoContactId: { $exists: true, $ne: null }, ratePerShop: { $ne: null }, deletedAt: null }).select('zohoContactId').lean(),
    VendorPrice.find({ ratePerShop: { $ne: null } }).select('zohoContactId').lean(),
  ]);
  return [...new Set([...vendors.map((v) => v.zohoContactId as string), ...typed.map((t) => t.zohoContactId)])];
}

/**
 * Saves the cost of one Zoho vendor: price per shop, far-distance price and skills. A registered vendor keeps it on the
 * vendor (so allocation and costing see it); a vendor not registered yet keeps it here until it is registered. An empty
 * price removes the cost (the vendor leaves the "cost added" list and the company rate applies). Skills left out stay as they are.
 */
export async function setZohoVendorPrice(contactId: string, body: z.infer<typeof priceBody>, actor: Actor) {
  const vendor = await Vendor.findOne({ zohoContactId: contactId, deletedAt: null });
  const far = body.farRatePerShop ?? null;
  if (body.ratePerShop == null && far != null) throw AppError.badRequest('Enter the price per shop first');
  if (body.ratePerShop != null && far != null && far < body.ratePerShop) throw AppError.badRequest('The far-distance price cannot be lower than the normal price');
  const skills = body.skills ? await checkedSkills(body.skills) : undefined;
  const set = { ratePerShop: body.ratePerShop, farRatePerShop: far };
  if (vendor) {
    const old = { ratePerShop: vendor.ratePerShop ?? null, farRatePerShop: vendor.farRatePerShop ?? null };
    // An empty value removes the field: the vendor falls back to the company rate.
    const given = Object.entries(set).filter(([, x]) => x != null);
    const cleared = Object.entries(set).filter(([, x]) => x == null);
    await Vendor.updateOne({ _id: vendor._id }, { $set: { updatedBy: actor.id, ...Object.fromEntries(given), ...(skills ? { skills } : {}) }, ...(cleared.length ? { $unset: Object.fromEntries(cleared.map(([k]) => [k, ''])) } : {}) });
    await recordAudit({ actor, action: 'PRICE_UPDATE', entity: 'Vendor', entityId: vendor._id, changes: [{ field: 'ratePerShop', oldValue: old.ratePerShop, newValue: set.ratePerShop }, { field: 'farRatePerShop', oldValue: old.farRatePerShop, newValue: set.farRatePerShop }] });
  } else {
    const prior = await VendorPrice.findOne({ zohoContactId: contactId }).lean();
    const keepSkills = skills ?? prior?.skills ?? [];
    // No price and no skills: nothing is kept for this vendor (the Zoho list itself is never stored).
    if (set.ratePerShop == null && !keepSkills.length) {
      if (prior) {
        await VendorPrice.deleteOne({ _id: prior._id });
        await recordAudit({ actor, action: 'PRICE_UPDATE', entity: 'VendorPrice', entityId: prior._id, reason: prior.name ?? contactId, changes: [{ field: 'ratePerShop', oldValue: prior.ratePerShop ?? null, newValue: null }, { field: 'farRatePerShop', oldValue: prior.farRatePerShop ?? null, newValue: null }] });
      }
      return NONE;
    }
    // Who the vendor is, read from Zoho now (the browser never supplies it); an earlier snapshot is kept when Zoho cannot be reached.
    const detail = await zohoGet<{ contact: ZohoContact & { created_by_name?: string; cf_contact_code?: string; created_time?: string; last_modified_time?: string } }>(`/contacts/${encodeURIComponent(contactId)}`).then((d) => d.contact, (e) => { if (prior?.name) return null; throw e; });
    const snap = detail ? { ...toZohoVendorRow(detail), ...toZohoVendorDetail(detail) } : null;
    const snapshot = snap ? { vendorNo: snap.vendorNo, name: snap.name, email: snap.email, mobile: snap.mobile, gstin: snap.gstin, pan: snap.pan, city: snap.city, address: snap.address, createdByName: snap.createdByName, contactCode: snap.contactCode, zohoStatus: snap.zohoStatus, zohoCreatedAt: snap.zohoCreatedAt, snapshotAt: new Date() } : {};
    const row = await VendorPrice.findOneAndUpdate({ zohoContactId: contactId }, { $set: { ...set, ...snapshot, skills: keepSkills, updatedBy: actor.id } }, { upsert: true, new: true });
    await recordAudit({ actor, action: 'PRICE_UPDATE', entity: 'VendorPrice', entityId: row._id, reason: row.name ?? contactId, changes: [{ field: 'ratePerShop', oldValue: prior?.ratePerShop ?? null, newValue: set.ratePerShop }, { field: 'farRatePerShop', oldValue: prior?.farRatePerShop ?? null, newValue: set.farRatePerShop }] });
  }
  return (await pricesOfZohoVendors([contactId])).get(contactId) ?? NONE;
}
