import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Schema, Types, model } from 'mongoose';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { SalesOrder } from './sales.model';

/**
 * Shop list version history (Recce Team > Assign Type & Details, Only Shop Details / Shop + Measurement).
 *
 * Every successful change of the shop table (Excel upload, add / edit / delete of a row, Clear All) saves a snapshot of
 * the whole table as the next version (V1, V2...), per order AND assign type, so each type keeps its own history.
 * Versions are never changed or deleted (Clear All saves an empty version). A save whose table is identical to the
 * latest version adds nothing, so retries, double clicks and navigation never create duplicates.
 *
 * Kept in its own collection (not inside the order) so large tables never push the order towards the document limit.
 */

/** A snapshot of the table as shown: columns in sheet order (header as uploaded) and rows by their stable Row ID. */
export interface VersionTable {
  columns: { id: string; header: string }[];
  rows: { rowId: string; cells: Record<string, string> }[];
}
export const VERSION_KINDS = ['LEGACY', 'UPLOAD', 'ADD', 'EDIT', 'DELETE', 'CLEAR'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

const shopListVersionSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'SalesOrder', required: true },
    type: { type: String, required: true },
    version: { type: Number, required: true },
    kind: { type: String, enum: VERSION_KINDS, required: true },
    /** The Excel file the table came from (the last uploaded file for manual changes). */
    fileName: { type: String, default: null },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, required: true },
    total: { type: Number, required: true },
    summary: { added: Number, modified: Number, removed: Number },
    columns: { type: [Schema.Types.Mixed], default: [] },
    rows: { type: [Schema.Types.Mixed], default: [] },
    hash: { type: String, required: true },
  },
  { versionKey: false },
);
// One number per order and type: two saves racing for the same number cannot both win.
shopListVersionSchema.index({ order: 1, type: 1, version: -1 }, { unique: true });
export const ShopListVersion = model('ShopListVersion', shopListVersionSchema);

const hashOf = (t: VersionTable) => createHash('sha256').update(JSON.stringify(t)).digest('hex');
const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

type RowStatus = 'ADDED' | 'REMOVED' | 'MODIFIED' | 'UNCHANGED';
/** Rows matched by Row ID: added / removed / modified (with the changed column ids) / unchanged. */
function diffTables(a: VersionTable | null, b: VersionTable) {
  const header = new Map<string, string>();
  for (const c of a?.columns ?? []) header.set(c.id, c.header);
  for (const c of b.columns) header.set(c.id, c.header);
  const columns = [...b.columns.map((c) => c.id), ...(a?.columns ?? []).map((c) => c.id).filter((id) => !b.columns.some((c) => c.id === id))].map((id) => ({ id, header: header.get(id) ?? id }));
  const old = new Map((a?.rows ?? []).map((r) => [r.rowId, r]));
  const rows: { rowId: string; status: RowStatus; cells: Record<string, string>; before?: Record<string, string>; changed: string[] }[] = [];
  for (const r of b.rows) {
    const o = old.get(r.rowId);
    if (!o) {
      rows.push({ rowId: r.rowId, status: 'ADDED', cells: r.cells, changed: [] });
      continue;
    }
    old.delete(r.rowId);
    const changed = columns.filter((c) => (o.cells[c.id] ?? '') !== (r.cells[c.id] ?? '')).map((c) => c.id);
    rows.push({ rowId: r.rowId, status: changed.length ? 'MODIFIED' : 'UNCHANGED', cells: r.cells, ...(changed.length ? { before: o.cells } : {}), changed });
  }
  for (const o of old.values()) rows.push({ rowId: o.rowId, status: 'REMOVED', cells: o.cells, changed: [] });
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  return { columns, rows, counts: { added: count('ADDED'), removed: count('REMOVED'), modified: count('MODIFIED'), unchanged: count('UNCHANGED') } };
}

const tableOf = (v: { columns?: unknown; rows?: unknown } | null): VersionTable | null =>
  v ? { columns: (v.columns ?? []) as VersionTable['columns'], rows: (v.rows ?? []) as VersionTable['rows'] } : null;

/**
 * Saves the table as the next version, unless it equals the latest one. Returns the version number saved (or null).
 * A parallel save that took the same number is retried once against the new latest version.
 */
export async function recordShopVersion(i: { orderId: Types.ObjectId; type: string; table: VersionTable; kind: VersionKind; fileName?: string | null; actor: Actor }) {
  const hash = hashOf(i.table);
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await ShopListVersion.findOne({ order: i.orderId, type: i.type }).sort({ version: -1 }).lean();
    if (latest?.hash === hash) return null;
    const { counts } = diffTables(tableOf(latest), i.table);
    try {
      const v = (latest?.version ?? 0) + 1;
      await ShopListVersion.create({
        order: i.orderId,
        type: i.type,
        version: v,
        kind: i.kind,
        fileName: i.fileName ?? null,
        by: new Types.ObjectId(i.actor.id),
        at: new Date(),
        total: i.table.rows.length,
        summary: { added: counts.added, modified: counts.modified, removed: counts.removed },
        columns: i.table.columns,
        rows: i.table.rows,
        hash,
      });
      return v;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
    }
  }
  return null;
}

/**
 * Orders with shop data from before version history: the table as it is (before the first change) becomes V1
 * ("Existing data"), so the first change can be compared with it. Nothing for an empty table or a type with versions.
 */
export async function ensureBaselineVersion(i: { orderId: Types.ObjectId; type: string; load: () => Promise<{ table: VersionTable; fileName: string | null } | null>; actor: Actor }) {
  if (await ShopListVersion.exists({ order: i.orderId, type: i.type })) return;
  const loaded = await i.load();
  const table = loaded?.table;
  if (!table?.rows.length) return;
  try {
    await ShopListVersion.create({
      order: i.orderId,
      type: i.type,
      version: 1,
      kind: 'LEGACY',
      fileName: loaded!.fileName,
      by: new Types.ObjectId(i.actor.id),
      at: new Date(),
      total: table.rows.length,
      summary: { added: table.rows.length, modified: 0, removed: 0 },
      columns: table.columns,
      rows: table.rows,
      hash: hashOf(table),
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
}

/** The order's current assign type (versions are kept per type). */
async function orderType(orderId: string) {
  const o = await SalesOrder.findOne({ _id: orderId, deletedAt: null }).select('orderNo handoverType').lean();
  if (!o) throw AppError.notFound('Order not found');
  if (o.handoverType !== 'SHOP_DETAILS' && o.handoverType !== 'SHOP_MEASUREMENT') throw AppError.conflict('This assign type has no shop list (SO).');
  return { orderNo: o.orderNo, type: o.handoverType as string };
}

/** Versions of the current assign type, newest first (without the rows). */
export async function listShopVersions(orderId: string) {
  const { type } = await orderType(orderId);
  const list = await ShopListVersion.find({ order: orderId, type }).select('-rows -columns -hash').sort({ version: -1 }).populate('by', 'name').lean();
  const first = list.length ? list[list.length - 1]!.version : 0;
  return list.map((v, i) => ({
    version: v.version,
    kind: v.kind,
    fileName: v.fileName ?? null,
    by: v.by && typeof v.by === 'object' && 'name' in v.by ? { _id: String((v.by as { _id: unknown })._id), name: (v.by as { name?: string }).name ?? '' } : null,
    at: v.at,
    total: v.total,
    summary: v.summary ?? { added: 0, modified: 0, removed: 0 },
    status: i === 0 ? 'CURRENT' : v.version === first ? 'FIRST' : 'PREVIOUS',
    hasPrevious: v.version !== first,
  }));
}

async function findVersion(orderId: string, version: number) {
  const { orderNo, type } = await orderType(orderId);
  const v = await ShopListVersion.findOne({ order: orderId, type, version }).lean();
  if (!v) throw AppError.notFound(`Version V${version} not found`);
  return { orderNo, type, v };
}

/** One saved version exactly as it was: all columns and rows (read-only). */
export async function getShopVersion(orderId: string, version: number) {
  const { v } = await findVersion(orderId, version);
  return { version: v.version, kind: v.kind, fileName: v.fileName ?? null, at: v.at, total: v.total, ...tableOf(v)! };
}

/** The version compared with the version before it (rows matched by Row ID). */
export async function compareShopVersion(orderId: string, version: number) {
  const { type, v } = await findVersion(orderId, version);
  const prev = await ShopListVersion.findOne({ order: orderId, type, version: { $lt: version } }).sort({ version: -1 }).lean();
  if (!prev) throw AppError.conflict(`V${version} is the first version: there is no earlier version to compare with.`);
  return { from: prev.version, to: v.version, ...diffTables(tableOf(prev), tableOf(v)!) };
}

/** Neutralise spreadsheet formula injection. */
const cellSafe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

/**
 * The selected version as Excel (not the current table): S.No first, the columns as saved, and the Row ID as the last,
 * hidden column (so the file can be uploaded again to update those rows).
 */
export async function exportShopVersion(orderId: string, version: number) {
  const { orderNo, v } = await findVersion(orderId, version);
  const t = tableOf(v)!;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shops');
  const headers = ['S.No', ...t.columns.map((c) => c.header), 'Row ID'];
  ws.columns = headers.map((header, i) => ({ header, width: i === 0 ? 7 : i === headers.length - 1 ? 26 : Math.min(40, Math.max(12, header.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  t.rows.forEach((r, i) => ws.addRow([i + 1, ...t.columns.map((c) => cellSafe(r.cells[c.id] ?? '')), r.rowId]));
  ws.getColumn(headers.length).hidden = true;
  return { name: `${orderNo.replace(/[^\w-]+/g, '_')}_shop_list_V${v.version}.xlsx`, buffer: Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer) };
}
