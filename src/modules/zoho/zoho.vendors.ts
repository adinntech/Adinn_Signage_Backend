import { z } from 'zod';
import { env } from '../../config/env';
import { exportFormat, tabularFile, type ExportColumn } from '../../common/tabular';
import { escapeRegex, listQuery, pageMeta } from '../../common/query';
import { Vendor } from '../vendors/vendor.model';
import { VendorPrice } from '../vendors/vendorPrice.model';
import { pricedZohoContactIds, pricesOfZohoVendors, zohoSnapshot } from '../vendors/vendorPrice.service';
import { VendorRateApproval } from '../vendors/vendorRateApproval.model';
import { zohoGet } from './zoho.client';
import { toZohoVendorRow, type ZohoContact } from './zoho.mapper';

/**
 * The "Zoho vendors" list. Nothing of Zoho's vendor list is stored here: the list is read from Zoho Books when the screen asks
 * for it. Only a vendor that gets a cost (price per shop, travelling cost) is kept, as a small snapshot on VendorPrice, so
 * "Vendors with cost" and the cost planning work without calling Zoho.
 */

export const zohoVendorListQuery = listQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['active', 'inactive']).optional(),
  registered: z.enum(['yes', 'no']).optional(),
  /** Vendor price management: only vendors whose price per shop is set / not set yet. "set" is read from what is stored, not from Zoho. */
  price: z.enum(['set', 'missing']).optional(),
  /** true: only the Signage creditors (Zoho Contact Code = ZOHO_VENDOR_CONTACT_CODE). false: every vendor in Zoho. Left out: ZOHO_SIGNAGE_CREDITORS_ONLY. */
  signageOnly: z.enum(['true', 'false']).optional(),
});
type ListQuery = z.infer<typeof zohoVendorListQuery>;

type Row = ReturnType<typeof toZohoVendorRow> & { city?: string | null; address?: string | null; createdByName?: string | null };

/**
 * Zoho only searches one field per call. The searches to run for what was typed: an e-mail, or the name (the vendor number is
 * part of the name: "12543 - NAME"); digits are tried as the vendor number AND as a phone number, and the results are merged.
 */
function searchParams(term?: string): Record<string, string>[] {
  const t = term?.trim();
  if (!t) return [{}];
  if (t.includes('@')) return [{ email_contains: t }];
  const digits = t.replace(/\D/g, '');
  if (/^\+?[\d\s-]+$/.test(t) && digits.length >= 4) return [{ contact_name_contains: digits }, { phone_contains: digits.length > 10 ? digits.slice(-10) : digits }];
  return [{ contact_name_contains: t }, { company_name_contains: t }];
}

/** Letters and digits only, lower case: "M.K.M Tractors" and "mkm tractors" read the same. */
const squash = (v?: string) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every word typed must be found in the vendor's name (with its number), company, e-mail, phone, mobile, GST or PAN. */
export function matchesTerm(c: ZohoContact, term: string): boolean {
  const fields = [c.contact_name, c.company_name, c.email, c.phone, c.mobile, c.gst_no, c.pan_no].map(squash).filter(Boolean);
  const words = term.split(/s+/).map(squash).filter(Boolean);
  return words.length > 0 && words.every((w) => fields.some((f) => f.includes(w)));
}

/** Who already holds each Zoho vendor in the vendor master, and the price typed for it. */
async function decorate(rows: Row[]) {
  const ids = rows.map((r) => r.zohoContactId);
  const linked = await Vendor.find({ zohoContactId: { $in: ids }, deletedAt: null }).select('zohoContactId code status').lean();
  const byZoho = new Map(linked.map((v) => [v.zohoContactId, { id: String(v._id), code: v.code, status: v.status }]));
  const prices = await pricesOfZohoVendors(ids);
  return rows.map((r) => ({ ...r, _id: r.zohoContactId, vendor: byZoho.get(r.zohoContactId) ?? null, price: prices.get(r.zohoContactId) ?? { ratePerShop: null, farRatePerShop: null, source: null } }));
}

/** A waiting request made before the vendor's details were kept has no name or ID: read them from Zoho once and keep them on the request. */
async function fillBlankApprovals() {
  const blank = await VendorRateApproval.find({ status: 'PENDING', $or: [{ vendorName: { $in: [null, '', 'Vendor'] } }, { vendorName: { $exists: false } }] }).limit(20);
  for (const a of blank) {
    try {
      const s = await zohoSnapshot(a.zohoContactId, false);
      if (!s) continue;
      const info = Object.fromEntries(Object.entries({ email: s.email, mobile: s.mobile, gstin: s.gstin, pan: s.pan, city: s.city, address: s.address, createdByName: s.createdByName, contactCode: s.contactCode }).filter(([, v]) => v));
      await VendorRateApproval.updateOne({ _id: a._id }, { $set: { vendorName: s.name, ...(s.vendorNo ? { vendorNo: s.vendorNo } : {}), info } });
    } catch { /* Zoho unreachable: the row stays as it was and is tried again next time */ }
  }
}

/** Vendors that have a cost (and registered Zoho vendors), from what is stored. */
async function storedRows(q: Pick<ListQuery, 'q' | 'status' | 'registered' | 'price'>): Promise<Row[]> {
  if (q.price === 'set') await fillBlankApprovals();
  const [snaps, vendors] = await Promise.all([VendorPrice.find().lean(), Vendor.find({ zohoContactId: { $exists: true, $ne: null }, deletedAt: null }).lean()]);
  const rows = new Map<string, Row>();
  for (const s of snaps) {
    if (s.ratePerShop == null) continue;
    rows.set(s.zohoContactId, { zohoContactId: s.zohoContactId, vendorNo: s.vendorNo ?? undefined, name: s.name ?? 'Zoho vendor', email: s.email ?? undefined, mobile: s.mobile ?? undefined, gstin: s.gstin ?? undefined, pan: s.pan ?? undefined, contactCode: s.contactCode ?? undefined, zohoStatus: s.zohoStatus === 'inactive' ? 'inactive' : 'active', zohoModifiedAt: undefined, zohoCreatedAt: s.zohoCreatedAt ?? undefined, city: s.city ?? null, address: s.address ?? null, createdByName: s.createdByName ?? null });
  }
  for (const v of vendors) {
    const id = v.zohoContactId as string;
    const costed = v.ratePerShop != null;
    if (!costed && q.registered !== 'yes') continue;
    if (!rows.has(id)) rows.set(id, { zohoContactId: id, vendorNo: v.zohoVendorNo ?? undefined, name: v.name, email: v.email ?? undefined, mobile: v.mobile ?? undefined, gstin: v.gstin ?? undefined, pan: v.pan ?? undefined, contactCode: undefined, zohoStatus: v.status === 'INACTIVE' ? 'inactive' : 'active', zohoModifiedAt: undefined, zohoCreatedAt: undefined, city: v.district ?? null, address: v.address ?? null, createdByName: null });
  }
  // A vendor whose first cost is waiting for the approver is listed too (marked "waiting for approval"), so it is not lost.
  if (q.price === 'set') {
    for (const a of await VendorRateApproval.find({ status: 'PENDING' }).lean()) {
      if (rows.has(a.zohoContactId)) continue;
      const v = vendors.find((x) => x.zohoContactId === a.zohoContactId);
      const i = a.info;
      rows.set(a.zohoContactId, { zohoContactId: a.zohoContactId, vendorNo: a.vendorNo ?? v?.zohoVendorNo ?? undefined, name: a.vendorName ?? v?.name ?? 'Zoho vendor', email: v?.email ?? i?.email ?? undefined, mobile: v?.mobile ?? i?.mobile ?? undefined, gstin: v?.gstin ?? i?.gstin ?? undefined, pan: v?.pan ?? i?.pan ?? undefined, contactCode: i?.contactCode ?? undefined, zohoStatus: 'active', zohoModifiedAt: undefined, zohoCreatedAt: undefined, city: v?.district ?? i?.city ?? null, address: v?.address ?? i?.address ?? null, createdByName: i?.createdByName ?? null });
    }
  }
  let list = [...rows.values()];
  if (q.status) list = list.filter((r) => r.zohoStatus === q.status);
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    list = list.filter((r) => [r.name, r.vendorNo, r.gstin, r.pan, r.mobile, r.email, r.city, r.zohoContactId].some((x) => x && re.test(x)));
  }
  if (q.registered) {
    const reg = new Set(vendors.map((v) => v.zohoContactId));
    list = list.filter((r) => reg.has(r.zohoContactId) === (q.registered === 'yes'));
  }
  // "Vendors with cost": the cost added or changed last is on top (same dates the list shows). Other lists stay A to Z.
  if (q.price === 'set') {
    const stamp = new Map<string, number>();
    for (const s of snaps) if (s.ratePerShop != null && s.updatedAt) stamp.set(s.zohoContactId, new Date(s.updatedAt).getTime());
    for (const v of vendors) if (v.ratePerShop != null && v.updatedAt) stamp.set(v.zohoContactId as string, new Date(v.updatedAt).getTime());
    // A cost waiting for approval counts from the moment its request was sent.
    for (const a of await VendorRateApproval.find({ status: 'PENDING' }).select('zohoContactId createdAt').lean()) {
      const t = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      if (t > (stamp.get(a.zohoContactId) ?? 0)) stamp.set(a.zohoContactId, t);
    }
    return list.sort((a, b) => (stamp.get(b.zohoContactId) ?? 0) - (stamp.get(a.zohoContactId) ?? 0) || a.name.localeCompare(b.name));
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Signage creditors (about 577), all of them, kept in memory only for SIGNAGE_TTL_MS. Zoho drops the Contact Code filter when it
 * is combined with the Active/Inactive filter or with a search, so for this small group the whole list is read once (200 per
 * call) and the status, the search and the paging are done here.
 */
const SIGNAGE_TTL_MS = 15 * 60 * 1000;
let signageCache: { rows: Row[]; at: number } | null = null;
let signageLoading: Promise<Row[]> | null = null;
async function signageRows(): Promise<Row[]> {
  if (signageCache && Date.now() - signageCache.at < SIGNAGE_TTL_MS) return signageCache.rows;
  if (!signageLoading) {
    signageLoading = (async () => {
      const wanted = env.ZOHO_VENDOR_CONTACT_CODE.trim().toLowerCase();
      const rows: Row[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await zohoGet<{ contacts?: (ZohoContact & { cf_contact_code?: string })[]; page_context?: { has_more_page?: boolean } }>('/contacts', { contact_type: 'vendor', per_page: 200, page, cf_contact_code: env.ZOHO_VENDOR_CONTACT_CODE });
        for (const c of r.contacts ?? []) if (c.cf_contact_code === undefined || c.cf_contact_code.trim().toLowerCase() === wanted) rows.push(toZohoVendorRow(c));
        if (!r.page_context?.has_more_page) break;
      }
      signageCache = { rows, at: Date.now() };
      return rows;
    })().finally(() => { signageLoading = null; });
  }
  return signageLoading;
}

/**
 * One page of Zoho vendors. "Vendors with cost" (price=set) and "registered" come from what is stored; everything else is read
 * live from Zoho Books, one page at a time (Zoho does not say how many vendors match, only whether another page exists).
 */
export async function listZohoVendors(q: ListQuery) {
  if (q.price === 'set' || q.registered === 'yes') {
    const all = await storedRows(q);
    const items = all.slice((q.page - 1) * q.limit, q.page * q.limit);
    return { items: await decorate(items), meta: pageMeta(q.page, q.limit, all.length) };
  }
  // A typed search always looks through every vendor in Zoho (a vendor of another Contact Code, e.g. "Creditors - Admin", must be found too);
  // the Signage-only switch narrows only the browsing list.
  const signage = !q.q?.trim() && (q.signageOnly ?? env.ZOHO_SIGNAGE_CREDITORS_ONLY) === 'true';
  if (signage) {
    let all = await signageRows();
    if (q.status) all = all.filter((r) => r.zohoStatus === q.status);
    let items = await decorate(all.slice((q.page - 1) * q.limit, q.page * q.limit));
    if (q.price === 'missing') items = items.filter((i) => i.price.ratePerShop == null);
    if (q.registered === 'no') items = items.filter((i) => !i.vendor);
    return { items, meta: pageMeta(q.page, q.limit, all.length) };
  }
  type Page = { contacts?: (ZohoContact & { last_modified_time?: string; created_time?: string })[]; page_context?: { has_more_page?: boolean } };
  const call = (extra: Record<string, string>, perPage: number, page: number) => zohoGet<Page>('/contacts', {
    contact_type: 'vendor',
    per_page: perPage,
    page,
    ...(q.status ? { filter_by: q.status === 'active' ? 'Status.Active' : 'Status.Inactive' } : {}),
    ...extra,
  });
  const term = q.q?.trim();
  if (term) {
    // Zoho's "contains" is loose (it matches on parts of the words), so the first 200 answers of each search are checked here
    // against the whole text typed, and only the real matches are shown and paged.
    const pages = await Promise.all(searchParams(term).map((s) => call(s, 200, 1)));
    const seen = new Set<string>();
    const hits = pages.flatMap((p) => p.contacts ?? []).filter((c) => !seen.has(c.contact_id) && !!seen.add(c.contact_id) && matchesTerm(c, term));
    let found = await decorate(hits.map(toZohoVendorRow));
    if (q.price === 'missing') found = found.filter((i) => i.price.ratePerShop == null);
    if (q.registered === 'no') found = found.filter((i) => !i.vendor);
    return { items: found.slice((q.page - 1) * q.limit, q.page * q.limit), meta: pageMeta(q.page, q.limit, found.length) };
  }
  const r = await call({}, q.limit, q.page);
  const rows: Row[] = (r.contacts ?? []).map(toZohoVendorRow);
  let items = await decorate(rows);
  if (q.price === 'missing') items = items.filter((i) => i.price.ratePerShop == null);
  if (q.registered === 'no') items = items.filter((i) => !i.vendor);
  // Zoho does not give a total: when another page exists, the total is just past this page so the pager offers "next".
  const more = !!r.page_context?.has_more_page;
  return { items, meta: pageMeta(q.page, q.limit, more ? q.page * q.limit + 1 : (q.page - 1) * q.limit + (r.contacts ?? []).length) };
}

/**
 * How many vendors Zoho holds (total, active, inactive) for the Signage creditors or for every vendor. Zoho gives no total, so the
 * pages are counted (200 vendors per call: about 3 calls for the Signage creditors, about 41 for all). The result is kept in
 * memory only (never in the database) for COUNT_TTL_MS, and counting runs in the background so the screen is not held up.
 */
export interface ZohoCounts { total: number; active: number; inactive: number }
type CountState = { running: boolean; counted: number; at: number; error?: string; counts?: ZohoCounts };
const COUNT_TTL_MS = 15 * 60 * 1000;
const countCache = new Map<'signage' | 'all', CountState>();

async function countZohoVendors(scope: 'signage' | 'all', state: CountState) {
  try {
    const tally: ZohoCounts = { total: 0, active: 0, inactive: 0 };
    if (scope === 'signage') {
      for (const row of await signageRows()) {
        tally.total += 1;
        if (row.zohoStatus === 'inactive') tally.inactive += 1;
        else tally.active += 1;
      }
      state.counted = tally.total;
      state.counts = tally;
      state.error = undefined;
      state.at = Date.now();
      return;
    }
    for (let page = 1; page <= 200; page++) {
      const r = await zohoGet<{ contacts?: ZohoContact[]; page_context?: { has_more_page?: boolean } }>('/contacts', {
        contact_type: 'vendor',
        per_page: 200,
        page,
      });
      for (const c of r.contacts ?? []) {
        tally.total += 1;
        if (toZohoVendorRow(c).zohoStatus === 'inactive') tally.inactive += 1;
        else tally.active += 1;
      }
      state.counted = tally.total;
      if (!r.page_context?.has_more_page) break;
    }
    state.counts = tally;
    state.error = undefined;
    state.at = Date.now();
  } catch (e) {
    state.error = e instanceof Error ? e.message : 'Zoho could not be reached';
  } finally {
    state.running = false;
  }
}

/** Starts counting (only when `start`) when there is no fresh result; returns what is known now (ready false while counting). Without `start` Zoho is not called. */
function zohoCounts(signage: boolean, start: boolean) {
  const scope = signage ? 'signage' : 'all';
  let state = countCache.get(scope);
  if (!state) { state = { running: false, counted: 0, at: 0 }; countCache.set(scope, state); }
  const stale = !state.counts || Date.now() - state.at > COUNT_TTL_MS;
  if (start && stale && !state.running) {
    state.running = true;
    state.counted = 0;
    void countZohoVendors(scope, state);
  }
  return { ready: !!state.counts && !state.running, counting: state.running, counted: state.counted, error: state.error, ...(state.counts ?? { total: null, active: null, inactive: null }) };
}

/** Counts for the tiles: vendors with a cost and registered ones come from what is stored; the Zoho counts are counted live and kept in memory. */
export async function zohoVendorStatus(signageOnly?: 'true' | 'false', count = false) {
  const signage = (signageOnly ?? env.ZOHO_SIGNAGE_CREDITORS_ONLY) === 'true';
  const [costed, registered] = await Promise.all([pricedZohoContactIds().then((x) => x.length), Vendor.countDocuments({ zohoContactId: { $exists: true, $ne: null }, deletedAt: null })]);
  return { live: true, costed, registered, signageOnlyDefault: env.ZOHO_SIGNAGE_CREDITORS_ONLY === 'true', contactCode: env.ZOHO_VENDOR_CONTACT_CODE, scope: signage ? 'signage' : 'all', zoho: zohoCounts(signage, count) };
}

export const zohoExportQuery = z.object({ format: exportFormat, status: z.enum(['active', 'inactive']).optional(), q: z.string().trim().max(100).optional(), price: z.enum(['set', 'missing']).optional() });

const ZOHO_EXPORT: ExportColumn<Record<string, any>>[] = [
  { header: 'Vendor ID', value: (v) => v.vendorNo, width: 12 },
  { header: 'Vendor Name', value: (v) => v.name, width: 32 },
  { header: 'Phone', value: (v) => v.mobile, width: 14 },
  { header: 'Email', value: (v) => v.email, width: 30 },
  { header: 'Created By', value: (v) => v.createdByName, width: 28 },
  { header: 'Created On', value: (v) => v.zohoCreatedAt, width: 12 },
  { header: 'Status', value: (v) => (v.zohoStatus === 'inactive' ? 'Inactive' : 'Active'), width: 10 },
  { header: 'City', value: (v) => v.city, width: 16 },
  { header: 'Address', value: (v) => v.address, width: 40 },
  { header: 'GSTIN', value: (v) => v.gstin, width: 18 },
  { header: 'PAN', value: (v) => v.pan, width: 12 },
  { header: 'Price per Shop', value: (v) => v.price?.ratePerShop, width: 14 },
  { header: 'Far Price per Shop', value: (v) => v.price?.farRatePerShop, width: 18 },
  { header: 'Contact Code', value: (v) => v.contactCode, width: 22 },
  { header: 'Zoho Contact ID', value: (v) => v.zohoContactId, width: 22 },
];

/** The vendors that have a cost (all pages), as Excel or CSV. The full Zoho list is not exported: it is not stored. */
export async function exportZohoVendors(q: z.infer<typeof zohoExportQuery>) {
  const rows = (await storedRows({ q: q.q, status: q.status, registered: undefined, price: 'set' })).slice(0, 20000);
  return tabularFile(q.format, 'Vendors with cost', ZOHO_EXPORT, (await decorate(rows)) as Record<string, any>[]);
}
