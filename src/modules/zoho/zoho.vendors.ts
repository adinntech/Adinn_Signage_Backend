import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { exportFormat, tabularFile, type ExportColumn } from '../../common/tabular';
import { escapeRegex, listQuery, pageMeta, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Vendor } from '../vendors/vendor.model';
import { zohoGet } from './zoho.client';
import { toZohoVendorDetail, toZohoVendorRow, type ZohoContact } from './zoho.mapper';
import { ZohoVendor } from './zohoVendor.model';

const PER_PAGE = 200; // Zoho's maximum
const DETAIL_PARALLEL = 3; // Zoho Books allows about 100 calls a minute; three at a time stays well under it

export interface SyncState {
  running: boolean;
  phase: 'list' | 'details' | null;
  /** Vendors read from the Zoho list. */
  fetched: number;
  /** Detail calls (city, address, created by) done / needed in this run. */
  detailsDone: number;
  detailsTotal: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
const idle = (): SyncState => ({ running: false, phase: null, fetched: 0, detailsDone: 0, detailsTotal: 0, startedAt: null, finishedAt: null, error: null });
/** One backend process runs one sync at a time; the state is for the progress bar and is lost on restart (the data is not). */
let state: SyncState = idle();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Zoho answers "too many requests" with an error body; wait and try again a few times before giving up on that vendor. */
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= 3 || !(e instanceof AppError) || e.statusCode !== 502) throw e;
      await sleep(attempt * 5000);
    }
  }
}

async function runSync() {
  const started = new Date();
  const wanted = env.ZOHO_VENDOR_CONTACT_CODE.trim().toLowerCase();
  try {
    // 1) the list: only vendors whose Zoho "Contact Code" is the configured one (Creditors - Signage). Zoho filters; we check again.
    for (let page = 1; ; page++) {
      const r = await withRetry(() =>
        zohoGet<{ contacts?: (ZohoContact & { last_modified_time?: string; created_time?: string; cf_contact_code?: string })[]; page_context?: { has_more_page?: boolean } }>('/contacts', {
          contact_type: 'vendor',
          cf_contact_code: env.ZOHO_VENDOR_CONTACT_CODE,
          per_page: PER_PAGE,
          page,
        }),
      );
      const rows = (r.contacts ?? []).filter((c) => (c.cf_contact_code ?? '').trim().toLowerCase() === wanted).map(toZohoVendorRow);
      if (rows.length) {
        await ZohoVendor.bulkWrite(
          rows.map((row) => ({
            updateOne: {
              filter: { zohoContactId: row.zohoContactId },
              // null (not undefined) so a value removed in Zoho is cleared here too.
              update: { $set: { ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? null])), syncedAt: started } },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      }
      state.fetched += rows.length;
      if (!r.page_context?.has_more_page) break;
    }
    // Only after a complete read: vendors that are no longer in the list (removed, or no longer this Contact Code) are gone here too.
    await ZohoVendor.deleteMany({ syncedAt: { $lt: started } });

    // 2) details (city, address, created by) only for vendors that are new or changed in Zoho since their details were read.
    state.phase = 'details';
    const todo = await ZohoVendor.find({ syncedAt: started, $or: [{ detailAt: null }, { $expr: { $ne: ['$detailModifiedAt', '$zohoModifiedAt'] } }] })
      .select('zohoContactId zohoModifiedAt')
      .lean();
    state.detailsTotal = todo.length;
    let next = 0;
    let failed = 0;
    await Promise.all(
      Array.from({ length: DETAIL_PARALLEL }, async () => {
        while (next < todo.length) {
          const row = todo[next++]!;
          try {
            const d = await withRetry(() => zohoGet<{ contact: ZohoContact & { created_by_name?: string } }>(`/contacts/${encodeURIComponent(row.zohoContactId)}`));
            const f = toZohoVendorDetail(d.contact);
            await ZohoVendor.updateOne({ _id: row._id }, { $set: { city: f.city ?? null, address: f.address ?? null, createdByName: f.createdByName ?? null, detailAt: new Date(), detailModifiedAt: row.zohoModifiedAt ?? null } });
          } catch (e) {
            failed++; // left without detailAt: the next sync reads it again
            console.error('zoho vendor detail failed', row.zohoContactId, (e as Error).message);
          }
          state.detailsDone++;
        }
      }),
    );
    state = { ...state, running: false, phase: null, finishedAt: new Date().toISOString(), error: failed ? `${failed} vendor(s) could not be read fully. Run the sync again to retry them.` : null };
  } catch (e) {
    state = { ...state, running: false, phase: null, finishedAt: new Date().toISOString(), error: e instanceof AppError ? e.message : 'The sync stopped. Try again in a minute.' };
    console.error('zoho vendor sync failed', e);
  }
}

/** Starts reading every vendor from Zoho in the background and returns at once; poll zohoVendorStatus() for progress. */
export async function startZohoVendorSync(actor: Actor) {
  if (state.running) throw AppError.conflict('A Zoho sync is already running');
  state = { ...idle(), running: true, phase: 'list', startedAt: new Date().toISOString() };
  await recordAudit({ actor, action: 'ZOHO_VENDOR_SYNC', entity: 'ZohoVendor', entityId: actor.id });
  void runSync();
  return state;
}

export async function zohoVendorStatus() {
  const [total, active, registered, last] = await Promise.all([
    ZohoVendor.countDocuments(),
    ZohoVendor.countDocuments({ zohoStatus: 'active' }),
    Vendor.countDocuments({ zohoContactId: { $exists: true, $ne: null }, deletedAt: null }),
    ZohoVendor.findOne().sort({ syncedAt: -1 }).select('syncedAt').lean(),
  ]);
  return { sync: state, total, active, registered, lastSyncedAt: last?.syncedAt ?? null };
}

export const zohoVendorListQuery = listQuery.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['active', 'inactive']).optional(),
  registered: z.enum(['yes', 'no']).optional(),
});

/** The list screen and the export share this filter. */
async function zohoFilter(q: Pick<z.infer<typeof zohoVendorListQuery>, 'status' | 'q' | 'registered'>) {
  const f: Record<string, unknown> = {};
  if (q.status) f.zohoStatus = q.status;
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    f.$or = [{ name: re }, { vendorNo: re }, { gstin: re }, { pan: re }, { mobile: re }, { email: re }, { city: re }, { createdByName: re }, { zohoContactId: re }];
  }
  if (q.registered) {
    const ids = (await Vendor.find({ zohoContactId: { $exists: true, $ne: null }, deletedAt: null }).select('zohoContactId').lean()).map((v) => v.zohoContactId);
    f.zohoContactId = q.registered === 'yes' ? { $in: ids } : { $nin: ids };
  }
  return f;
}

/** One page of the stored Zoho vendors; each row says whether it is already in the vendor master. */
export async function listZohoVendors(q: z.infer<typeof zohoVendorListQuery>) {
  const f = await zohoFilter(q);
  const [items, total] = await Promise.all([
    ZohoVendor.find(f).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    ZohoVendor.countDocuments(f),
  ]);
  const linked = await Vendor.find({ zohoContactId: { $in: items.map((i) => i.zohoContactId) }, deletedAt: null }).select('zohoContactId code status').lean();
  const byZoho = new Map(linked.map((v) => [v.zohoContactId, { id: String(v._id), code: v.code, status: v.status }]));
  return { items: items.map((i) => ({ ...i, vendor: byZoho.get(i.zohoContactId) ?? null })), meta: pageMeta(q.page, q.limit, total) };
}

export const zohoExportQuery = z.object({ format: exportFormat, status: z.enum(['active', 'inactive']).optional(), q: z.string().trim().max(100).optional() });

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
  { header: 'Zoho Contact ID', value: (v) => v.zohoContactId, width: 22 },
  { header: 'Last Synced', value: (v) => v.syncedAt, width: 12 },
];

/** Every stored Zoho vendor matching the screen's search and status (all pages), as Excel or CSV. */
export async function exportZohoVendors(q: z.infer<typeof zohoExportQuery>) {
  const items = await ZohoVendor.find(await zohoFilter({ status: q.status, q: q.q, registered: undefined })).sort({ name: 1 }).limit(20000).lean();
  return tabularFile(q.format, 'Zoho vendors', ZOHO_EXPORT, items as Record<string, any>[]);
}
