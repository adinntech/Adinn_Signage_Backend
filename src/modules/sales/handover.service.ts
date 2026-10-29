import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { AppError } from '../../common/errors';
import { type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { notify } from '../notifications/notification.service';
import { buildTemplate, MAX_ROWS, readGrids, type SheetGrid } from '../sites/excel.service';
import { autoMap, dupKeyOf, MAPPABLE, normalise, validateMapping, type MapTarget, type MappableField } from '../sites/site.fields';
import { User } from '../users/user.model';
import { handoverUnlocked } from './lead.service';
import { leadLog, liveOrder, pipelineLog } from './order.service';
import { SalesOrder, type AssignRoute, type HandoverType } from './sales.model';

/** Client Servicing only sees orders handed to them; everyone else with sales access sees all. */
export const isCs = (actor: Actor) => actor.role === 'CLIENT_SERVICING';

/** 404 (not 403) for an order that is not this Client Servicing person's, so other orders are not disclosed. */
export async function assertOrderAccess(id: string, actor: Actor) {
  if (!isCs(actor)) return;
  if (!(await SalesOrder.exists({ _id: id, deletedAt: null, csAssignee: actor.id }))) throw AppError.notFound('Order not found');
}

/** Before handover the BD may change everything; afterwards (to Client Servicing or the Recce team) only add documents. */
const assertNotHandedOver = (o: { csAssignee?: unknown; recce?: { assignee?: unknown } | null }) => {
  if (o.csAssignee) throw AppError.conflict('This order is already handed over to Client Servicing. You can only add documents now.');
  if (o.recce?.assignee) throw AppError.conflict('This order is already assigned to the Recce team. You can only add documents now.');
};

const ownerOf = (id: Types.ObjectId) => ({ entity: 'SalesOrder' as const, id });

/** Active Client Servicing people the BD can hand an order to. */
export const csUsers = () => User.find({ role: 'CLIENT_SERVICING', isActive: true, deletedAt: null }).select('name email phone').sort({ name: 1 }).lean();

export const HANDOVER_TYPE_LABELS: Record<HandoverType, string> = { ASO: 'ASO', SHOP_DETAILS: 'Shop Details Only', SHOP_MEASUREMENT: 'Shop + Measurement' };
const shopTypes: readonly string[] = ['SHOP_DETAILS', 'SHOP_MEASUREMENT'];
const isShopType = (t: string | null | undefined) => !!t && shopTypes.includes(t);

type GapInput = {
  handoverFull?: boolean | null;
  handoverType?: string | null;
  shopList?: { total?: number | null; error?: number | null } | null;
};
/** Toggle off = client details and contact persons only. Orders from before the toggle count as full. */
const isFull = (o: { handoverFull?: boolean | null }) => o.handoverFull !== false;

/**
 * What is still missing before the order can be handed over (empty = ready). Contact persons are optional.
 * ASO: no shop list. Shop types: at least one shop row and no row with errors (Total Shops = the rows in the table).
 */
export function handoverGaps(o: GapInput): string[] {
  if (!isFull(o)) return [];
  if (!o.handoverType) return ['Choose the handover type: ASO, Shop Details Only or Shop + Measurement'];
  // ASO goes without a shop list (rows of the shop types stay in their own datasets and are not handed over).
  if (o.handoverType === 'ASO') return [];
  if (!o.shopList?.total) return ['Add the shop list: upload the Excel or add the shops'];
  const bad = o.shopList.error ?? 0;
  if (bad) return [`${bad} shop row${bad === 1 ? ' has' : 's have'} errors: edit or delete ${bad === 1 ? 'it' : 'them'}`];
  return [];
}

/** Handover: type, who it went to, the shop list summary, the communication and what is still missing (rows come from listShops). */
export async function getHandover(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select('orderNo client csAssignee handover handoverFull handoverType handoverUpdatedAt soContacts shopColumns declaredShopTotal shopList handoverDocumentsArray handoverMessagesArray handoverShopsArray.attachments.fileId')
    .populate('csAssignee', 'name email phone')
    .populate('handover.assignedBy', 'name role')
    .populate('handoverMessagesArray.by', 'name role')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  // Only the selected type's dataset is shown and handed over (ASO: none; leftovers from older orders stay stored).
  const shop = isShopType(o.handoverType);
  const shops = shop ? (o.handoverShopsArray ?? []) : [];
  return {
    orderId: String(o._id),
    orderNo: o.orderNo,
    assignee: o.csAssignee ?? null,
    handover: o.handover ?? null,
    /** Toggle: full handover (true) or client details and contacts only (false). */
    full: isFull(o),
    type: (o.handoverType ?? null) as HandoverType | null,
    /** Row counts of the shop table (total = Total Shops) and the last uploaded Excel. */
    shopList: shop ? (o.shopList ?? null) : null,
    declaredShopTotal: shop ? (o.declaredShopTotal ?? null) : null,
    shopsWithFiles: shops.filter((x) => x.attachments?.length).length,
    shopFiles: shops.reduce((n, x) => n + (x.attachments?.length ?? 0), 0),
    /** Uploaded shop list files (Excel / CSV), newest first. */
    documents: [...(o.handoverDocumentsArray ?? [])].filter((d) => shop && d.kind === 'SHOP_LIST' && !d.shopType).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)),
    /** Communication & attachments, oldest first (chat order). */
    messages: o.handoverMessagesArray ?? [],
    /** ASO: the SO contacts (kept when the type changes; shown for ASO only). */
    soContacts: (o.soContacts ?? []).map((k) => ({ _id: String(k._id), name: k.name ?? '', phone: k.phone ?? '', email: k.email ?? '', isPrimary: !!k.isPrimary })),
    updatedAt: o.handoverUpdatedAt ?? null,
    /** Imported columns of the shop table (null for tables from before them). */
    columns: shop ? columnsOf(o) : null,
    missing: o.csAssignee ? [] : handoverGaps(o),
  };
}

/** Changes are only made while nobody has handed the order over; a parallel handover makes them no-ops (409). */
const stillOpen = (o: { _id: Types.ObjectId }) => ({ _id: o._id, csAssignee: null, 'recce.assignee': null });

/* ------------------------------ Project Assign route ------------------------------ */

type RouteInput = {
  _id: Types.ObjectId;
  assignRoute?: string | null;
  csAssignee?: unknown;
  recce?: { assignee?: unknown; projectCode?: string | null } | null;
  lead?: { status?: string | null; stage?: string | null } | null;
};
const ROUTE_LOCKED: Record<AssignRoute, string> = {
  HANDOVER: 'This lead is on the Client Servicing route, so the Recce team route is disabled.',
  RECCE: 'This lead is on the Recce team route, so the Client Servicing route is disabled.',
};

/** The route the order is on: the saved one or, for orders from before routes, what was already done on it. */
export async function routeOf(o: RouteInput): Promise<AssignRoute | null> {
  if (o.assignRoute) return o.assignRoute as AssignRoute;
  if (o.csAssignee) return 'HANDOVER';
  if (o.recce?.assignee || o.recce?.projectCode) return 'RECCE';
  if (await SalesOrder.exists({ _id: o._id, 'salesprofile.kind': 'PROJECT_CODE_REQUEST' })) return 'RECCE';
  return null;
}

/** The first save on a route takes it; the other route is then disabled (409 when the order is already on it). */
export async function claimRoute(o: RouteInput, route: AssignRoute) {
  const current = await routeOf(o);
  if (current && current !== route) throw AppError.conflict(ROUTE_LOCKED[current]);
  if (o.assignRoute) return;
  // Conditional: two first saves at once (one per route) cannot both win.
  const r = await SalesOrder.updateOne({ _id: o._id, assignRoute: null }, { $set: { assignRoute: route } });
  if (!r.modifiedCount) {
    const now = await SalesOrder.findById(o._id).select('assignRoute').lean();
    if (now?.assignRoute && now.assignRoute !== route) throw AppError.conflict(ROUTE_LOCKED[now.assignRoute as AssignRoute]);
  }
}

/**
 * Handover details are shared by both Project Assign routes (Client Servicing and Recce), so saving them takes no
 * route: the route is taken by the Client Servicing assignment or the first project code request email. Only the
 * last-update time is kept (shown on the mind map's Handover step).
 */
async function handoverRoute(o: RouteInput) {
  await SalesOrder.updateOne({ _id: o._id }, { $set: { handoverUpdatedAt: new Date() } });
}

/**
 * Leads that took the Client Servicing route by a handover save alone (the earlier rule) are released once, so the
 * route is open again until the Client Servicing person is assigned. Assigned orders keep their route.
 */
let routesReleased = false;
export async function releaseHandoverRoutes() {
  if (routesReleased) return;
  await SalesOrder.updateMany({ assignRoute: 'HANDOVER', csAssignee: null, deletedAt: null }, { $set: { assignRoute: null } });
  routesReleased = true;
}

/** Assign to Client Servicing toggle. Switching it off keeps what was entered (type, list, notes); it is just not required. */
export async function setHandoverScope(id: string, full: boolean, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  await handoverRoute(o);
  const r = await SalesOrder.updateOne(stillOpen(o), { $set: { handoverFull: full, updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  return getHandover(id);
}

export async function setHandoverType(id: string, type: HandoverType, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  await handoverRoute(o);
  if (o.handoverType === type) return getHandover(id);
  const swap = await swapShopSet(o._id, o.handoverType ?? null, type);
  const r = await SalesOrder.updateOne(swap.where, {
    $set: { ...swap.set, handoverType: type, updatedBy: actor.id },
    $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, `Handover type set to ${HANDOVER_TYPE_LABELS[type]}`, { step: 'handover-type', oldValue: o.handoverType ?? null, newValue: type }) },
  });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  return getHandover(id);
}

type ShopSet = { rows?: unknown[]; columns?: unknown; list?: unknown; declared?: number | null };

/**
 * Each handover type keeps its own shop dataset (rows, columns, counts, uploaded files, history). The selected type's
 * dataset lives in handoverShopsArray / shopColumns / shopList; switching the type stores it in shopSets under the old
 * type and brings back the new type's (empty the first time). History entries and shop list files are tagged with the
 * type they leave with (untagged = the selected type). Nothing is deleted.
 */
async function swapShopSet(orderId: Types.ObjectId, from: string | null, to: string) {
  const doc = await SalesOrder.findById(orderId).select('handoverShopsArray shopColumns shopList declaredShopTotal shopSets handoverShopLogs handoverDocumentsArray').lean();
  const rows = doc?.handoverShopsArray ?? [];
  const logs = doc?.handoverShopLogs ?? [];
  const docs = doc?.handoverDocumentsArray ?? [];
  const sets = { ...((doc?.shopSets ?? {}) as Record<string, ShopSet>) };
  // Conditional on the same state, so a row or log written meanwhile is not lost.
  const where: Record<string, unknown> = { _id: orderId, csAssignee: null, 'recce.assignee': null, handoverType: from, handoverShopsArray: { $size: rows.length }, handoverShopLogs: { $size: logs.length } };
  // Older orders: rows left from before (no type yet, or kept when ASO was chosen) go to the first shop type chosen
  // that has no dataset of its own, as before.
  if (!isShopType(from) && rows.length && isShopType(to) && !sets[to]) return { where, set: {} };
  const key = from ?? 'NONE';
  if (rows.length || doc?.shopList || logs.some((l) => !l.type)) sets[key] = { rows, columns: doc?.shopColumns ?? null, list: doc?.shopList ?? null, declared: doc?.declaredShopTotal ?? null };
  const next = isShopType(to) ? sets[to] : undefined;
  if (next) delete sets[to];
  // Untagged entries leave with the old type; the new type's own entries become untagged again.
  const retag = <T>(x: T, f: 'type' | 'shopType'): T => {
    const own = (x as Record<string, unknown>)[f] ?? null;
    if (!own) return { ...x, [f]: key };
    return own === to && isShopType(to) ? { ...x, [f]: null } : x;
  };
  return {
    where,
    set: {
      handoverShopsArray: next?.rows ?? [],
      shopColumns: next?.columns ?? null,
      shopList: next?.list ?? null,
      declaredShopTotal: next?.declared ?? null,
      shopSets: sets,
      handoverShopLogs: logs.map((l) => retag(l, 'type')),
      handoverDocumentsArray: docs.map((d) => (d.kind === 'SHOP_LIST' ? retag(d, 'shopType') : d)),
    },
  };
}

type SoContact = { name: string; phone: string; email?: string | undefined; isPrimary: boolean };
const soLine = (k: { name?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean | null }) =>
  [k.name, k.phone, k.email, k.isPrimary ? 'primary' : null].filter(Boolean).join(' · ');

/**
 * ASO: saves the whole SO contact list (validated and given one primary by soContactsBody). The list is kept apart
 * from the client's contact persons and stays on the order if the type changes later (shown for ASO only).
 */
export async function setSoContacts(id: string, contacts: SoContact[], actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  if (o.handoverType !== 'ASO') throw AppError.conflict('SO contacts are for ASO handovers. Choose ASO first.');
  await handoverRoute(o);
  const before = (o.soContacts ?? []).map(soLine);
  const after = contacts.map(soLine);
  const r = await SalesOrder.updateOne(stillOpen(o), { $set: { soContacts: contacts.map((k) => ({ ...k, email: k.email ?? null })), updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  if (before.join('\n') !== after.join('\n')) {
    await recordAudit({ actor, action: 'UPDATE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'soContacts', oldValue: before, newValue: after }], reason: `SO contacts saved (${contacts.length})` });
  }
  return getHandover(id);
}

/* ------------------------------- shop table ------------------------------- */

/** Fields of a shop row the BD can edit (same names as the project site import). */
export const SHOP_FIELDS = [
  'shopName', 'dealerName', 'location', 'district', 'address1', 'address2', 'address3', 'pincode', 'mobile', 'mobileAlt', 'gstin',
  'contactPerson', 'width', 'height', 'unit', 'boardType', 'quantity', 'remarks', 'clientSiteCode',
] as const;
type ShopField = (typeof SHOP_FIELDS)[number];
export type ShopRowInput = Partial<Record<ShopField | 'size', string>>;
const SIZE_FIELDS: readonly string[] = ['width', 'height', 'unit', 'size'];
export const MAX_ROW_IMAGES = 10;
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const AUDIO_RE = /\.(mp3|m4a|webm|ogg|wav)$/i;
/** Columns of the downloaded Excel that are not shop fields (ignored when the file is uploaded again). */
const EXPORT_ONLY = ['row id', 'images', 'status', 'issues', 'modified at', 'modified by'];

const assertShopType = (o: { handoverType?: string | null }) => {
  if (!o.handoverType || !shopTypes.includes(o.handoverType)) throw AppError.conflict('Choose Shop Details Only or Shop + Measurement first');
};

/**
 * Raw text values -> the row's fields, state and issues, with the project site import rules. Size is optional for
 * both shop types; Shop Details Only keeps no size at all.
 */
function cleanRow(values: ShopRowInput, type: string | null | undefined, opts: { nameOptional?: boolean } = {}) {
  const n = normalise(values, { scenario: 'MEASUREMENT_REQUIRED', defaultUnit: 'ft' });
  const sized = type === 'SHOP_MEASUREMENT';
  const value: Record<string, unknown> = { ...n.value };
  if (!sized) for (const f of ['width', 'height', 'unit']) delete value[f];
  // Imported sheets without a shop / dealer name column: the row is kept and only flagged.
  const soft = (e: { code: string }) => !!opts.nameOptional && e.code === 'NAME_REQUIRED';
  const errors = n.errors.filter((e) => (sized || !SIZE_FIELDS.includes(e.field)) && !soft(e));
  const warnings = [...n.warnings, ...n.errors.filter(soft)].filter((e) => sized || !SIZE_FIELDS.includes(e.field));
  return {
    fields: Object.fromEntries(SHOP_FIELDS.map((f) => [f, value[f] ?? null])) as Record<ShopField, unknown>,
    state: (errors.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID') as 'ERROR' | 'WARNING' | 'VALID',
    issues: [...errors, ...warnings].map((i) => i.message),
  };
}

type Extra = Record<string, string>;
const MAX_EXTRA = 40;
/** Extra (unmapped) columns: blank values dropped, keys safe for MongoDB (no dots, no leading $). */
function cleanExtra(e: Record<string, unknown> | null | undefined): Extra | undefined {
  const out: Extra = {};
  for (const [k, v] of Object.entries(e ?? {})) {
    const key = k.replace(/\./g, ' ').replace(/^\$+/, '').trim().slice(0, 120);
    const val = v == null ? '' : String(v).trim().slice(0, 500);
    if (key && val && Object.keys(out).length < MAX_EXTRA) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Extra columns whose value changed (history), as { header: value } before and after. */
function extraDiff(a: Extra | undefined, b: Extra | undefined) {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => (a?.[k] ?? '') !== (b?.[k] ?? ''));
  return keys.length ? { before: Object.fromEntries(keys.map((k) => [k, a?.[k] ?? null])), after: Object.fromEntries(keys.map((k) => [k, b?.[k] ?? null])) } : null;
}

/** The filled fields of a row (history before / after values), with its extra columns. */
const snapshot = (r: Record<string, unknown>) => {
  const s: Record<string, unknown> = Object.fromEntries(SHOP_FIELDS.filter((f) => r[f] !== null && r[f] !== undefined && r[f] !== '').map((f) => [f, r[f]]));
  if (r.extra && Object.keys(r.extra).length) s.extra = r.extra;
  return s;
};
/** How a row is named in the history, so it stays recognisable after it is deleted. */
const rowLabel = (r: Record<string, unknown>) => [`Row ${r.rowNumber ?? '?'}`, r.shopName || r.dealerName].filter(Boolean).join(' · ');
const newRowId = () => new Types.ObjectId().toHexString();
const shopLog = (actor: Actor, action: string, rowId: string | null, extra: { before?: unknown; after?: unknown; note?: string; label?: string; cells?: { column: string; before?: string; after?: string }[] } = {}) => ({
  _id: new Types.ObjectId(),
  rowId,
  action,
  ...extra,
  by: new Types.ObjectId(actor.id),
  role: actor.role,
  at: new Date(),
});

/** Rows from before row ids get one, once (conditional on the same list, so a parallel change is not overwritten). */
async function ensureRowIds(orderId: Types.ObjectId | string) {
  const o = await SalesOrder.findById(orderId).select('handoverShopsArray').lean();
  const rows = o?.handoverShopsArray ?? [];
  if (!rows.some((r) => !r.rowId)) return;
  await SalesOrder.updateOne(
    { _id: orderId, handoverShopsArray: { $size: rows.length }, 'handoverShopsArray.rowId': { $in: [null, undefined] } },
    { $set: { handoverShopsArray: rows.map((r) => (r.rowId ? r : { ...r, rowId: newRowId() })) } },
  );
}

/** Row counts of the table (Total Shops = every row); the last uploaded file's name stays on it. */
async function syncShopSummary(orderId: Types.ObjectId) {
  const o = await SalesOrder.findById(orderId).select('handoverShopsArray.state shopList').lean();
  const rows = o?.handoverShopsArray ?? [];
  const count = (st: string) => rows.filter((r) => r.state === st).length;
  const prev = (o?.shopList ?? {}) as Record<string, unknown>;
  const summary = rows.length
    ? { fileId: prev.fileId ?? null, fileName: prev.fileName ?? null, uploadedBy: prev.uploadedBy ?? null, uploadedAt: prev.uploadedAt ?? null, total: rows.length, valid: count('VALID'), warning: count('WARNING'), error: count('ERROR'), duplicates: 0 }
    : null;
  await SalesOrder.updateOne({ _id: orderId }, { $set: { shopList: summary, declaredShopTotal: rows.length || null } });
}

async function findRow(orderId: Types.ObjectId, rowId: string) {
  const doc = await SalesOrder.findOne({ _id: orderId, 'handoverShopsArray.rowId': rowId }, { 'handoverShopsArray.$': 1 }).lean();
  const row = doc?.handoverShopsArray?.[0];
  if (!row) throw AppError.notFound('Shop row not found. Reload the list.');
  return row as typeof row & Record<string, unknown>;
}

type ShopRowBody = ShopRowInput & { extra?: Extra | undefined; cells?: Record<string, string> | undefined };

/* ------------------------- imported columns (the sheet as uploaded) ------------------------- */

/** One column of the uploaded Excel: stable id, original header text (may be blank or repeated), and the shop field it feeds internally. */
export type ShopColumn = { id: string; header: string; field: string | null };
type Cells = Record<string, string>;
const MAX_CELL = 2000;
const MAX_COLUMNS = 150;
const MEASURE_FIELDS = ['width', 'height', 'unit'] as const;

const columnsOf = (o: { shopColumns?: unknown } | null | undefined): ShopColumn[] | null => {
  const list = (o?.shopColumns ?? null) as { id: string; header?: string | null; field?: string | null }[] | null;
  return list?.length ? list.map((c) => ({ id: c.id, header: c.header ?? '', field: c.field ?? null })) : null;
};
const hasSizeColumn = (columns: ShopColumn[]) => columns.some((c) => !!c.field && SIZED_TARGETS.includes(c.field));
/** How a column is named in the history: its header, or its position when the header is blank or repeated. */
function columnName(columns: ShopColumn[], c: ShopColumn) {
  const i = columns.indexOf(c);
  const key = c.header.trim().toLowerCase();
  if (!key) return `Column ${i + 1}`;
  return columns.filter((x) => x.header.trim().toLowerCase() === key).length > 1 ? `${c.header} (column ${i + 1})` : c.header;
}
/** Cells of the known columns as text, exactly as given (blank cells are not stored; they show empty). */
function cleanCells(cells: Record<string, unknown> | null | undefined, columns: ShopColumn[]): Cells {
  const out: Cells = {};
  for (const c of columns) {
    const v = cells?.[c.id];
    const t = v == null ? '' : String(v).slice(0, MAX_CELL);
    if (t.trim() !== '') out[c.id] = t;
  }
  return out;
}
/** Cells whose text changed, for the history (one side only for an added / deleted row). */
function cellChanges(columns: ShopColumn[], a: Cells | null, b: Cells | null) {
  return columns
    .filter((c) => (a?.[c.id] ?? '') !== (b?.[c.id] ?? ''))
    .map((c) => ({ column: columnName(columns, c), ...(a ? { before: a[c.id] ?? '' } : {}), ...(b ? { after: b[c.id] ?? '' } : {}) }));
}
/**
 * Shop fields of an imported-columns row, for the checks and everything downstream (project sites, request email,
 * duplicates). The cells are never changed by it. Shop + Measurement without a size column keeps its measurement as
 * app fields (`measure`). A sheet without a shop / dealer name column is not an error (the row is flagged only).
 */
function deriveRow(cells: Cells, columns: ShopColumn[], type: string | null | undefined, measure?: Partial<Record<(typeof MEASURE_FIELDS)[number], unknown>>) {
  const values: ShopRowInput = {};
  for (const c of columns) if (c.field && cells[c.id] && !(c.field in values)) values[c.field as keyof ShopRowInput] = cells[c.id];
  if (type === 'SHOP_MEASUREMENT' && !hasSizeColumn(columns)) for (const f of MEASURE_FIELDS) if (measure?.[f] != null && measure[f] !== '') values[f] = String(measure[f]);
  return cleanRow(values, type, { nameOptional: !columns.some((c) => !!c.field && NAME_FIELDS.includes(c.field)) });
}
/** The app measurement of a row (Shop + Measurement without a size column), for the history. */
const measureOf = (r: Record<string, unknown>) => Object.fromEntries(MEASURE_FIELDS.filter((f) => r[f] != null && r[f] !== '').map((f) => [f, r[f]]));
/** Row identity for the history: the shop / dealer name, else its first filled cell. */
const labelOf = (row: Record<string, unknown>, columns: ShopColumn[] | null) => {
  if (row.shopName || row.dealerName || !columns) return rowLabel(row);
  const first = columns.map((c) => (row.cells as Cells | undefined)?.[c.id]).find((v) => v && v.trim());
  return [`Row ${row.rowNumber ?? '?'}`, first?.slice(0, 60)].filter(Boolean).join(' · ');
};

/** Add one shop row by hand (with the imported columns when the table has them). */
export async function addShopRow(id: string, values: ShopRowBody, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  assertShopType(o);
  const columns = columnsOf(o);
  const cells = columns ? cleanCells(values.cells, columns) : undefined;
  if (columns && !Object.keys(cells!).length && !MEASURE_FIELDS.some((f) => values[f])) throw new AppError(422, 'VALIDATION_ERROR', 'Fill at least one cell', [{ path: 'cells', message: 'Fill at least one cell' }]);
  await handoverRoute(o);
  await ensureRowIds(o._id);
  const c = columns ? deriveRow(cells!, columns, o.handoverType, values) : cleanRow(values, o.handoverType);
  const last = await SalesOrder.findById(o._id).select('handoverShopsArray.rowNumber').lean();
  const rowNumber = Math.max(0, ...(last?.handoverShopsArray ?? []).map((r) => r.rowNumber ?? 0)) + 1;
  const row = { rowNumber, ...c.fields, ...(columns ? { cells } : { extra: cleanExtra(values.extra) }), state: c.state, issues: c.issues, rowId: newRowId(), updatedAt: new Date(), updatedBy: new Types.ObjectId(actor.id) };
  const log = columns
    ? shopLog(actor, 'ADD', row.rowId, { after: measureOf(row), cells: cellChanges(columns, null, cells!), label: labelOf(row, columns) })
    : shopLog(actor, 'ADD', row.rowId, { after: snapshot(row), label: rowLabel(row) });
  const r = await SalesOrder.updateOne(stillOpen(o), {
    $push: { handoverShopsArray: row, handoverShopLogs: log },
    $set: { updatedBy: actor.id },
  });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  await syncShopSummary(o._id);
  return row;
}

/** Edit a shop row: the changed cells / fields are logged with their old and new values. */
export async function updateShopRow(id: string, rowId: string, values: ShopRowBody, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  assertShopType(o);
  const before = await findRow(o._id, rowId);
  const columns = columnsOf(o);
  let c: ReturnType<typeof cleanRow>;
  let set: Record<string, unknown>;
  let log: ReturnType<typeof shopLog>;
  if (columns) {
    const oldCells = cleanCells(before.cells as Cells | undefined, columns);
    const newCells = values.cells === undefined ? oldCells : cleanCells(values.cells, columns);
    const measure = Object.fromEntries(MEASURE_FIELDS.map((f) => [f, values[f] !== undefined ? values[f] : before[f]]));
    c = deriveRow(newCells, columns, o.handoverType, measure);
    const cellsChanged = cellChanges(columns, oldCells, newCells);
    const appChanged = hasSizeColumn(columns) ? [] : MEASURE_FIELDS.filter((f) => String(before[f] ?? '') !== String(c.fields[f] ?? ''));
    if (!cellsChanged.length && !appChanged.length) return before;
    set = { 'handoverShopsArray.$.cells': newCells };
    log = shopLog(actor, 'EDIT', rowId, {
      cells: cellsChanged,
      ...(appChanged.length ? { before: Object.fromEntries(appChanged.map((f) => [f, before[f] ?? null])), after: Object.fromEntries(appChanged.map((f) => [f, c.fields[f]])) } : {}),
      label: labelOf({ ...before, ...c.fields, cells: newCells }, columns),
    });
  } else {
    c = cleanRow(values, o.handoverType);
    const changed = SHOP_FIELDS.filter((f) => String(before[f] ?? '') !== String(c.fields[f] ?? ''));
    const oldExtra = cleanExtra(before.extra as Extra | undefined);
    const newExtra = values.extra === undefined ? oldExtra : cleanExtra(values.extra);
    const extraChange = extraDiff(oldExtra, newExtra);
    if (!changed.length && !extraChange) return before;
    set = { 'handoverShopsArray.$.extra': newExtra ?? null };
    log = shopLog(actor, 'EDIT', rowId, {
      before: { ...Object.fromEntries(changed.map((f) => [f, before[f] ?? null])), ...(extraChange ? { extra: extraChange.before } : {}) },
      after: { ...Object.fromEntries(changed.map((f) => [f, c.fields[f]])), ...(extraChange ? { extra: extraChange.after } : {}) },
      label: rowLabel({ ...before, ...c.fields }),
    });
  }
  await handoverRoute(o);
  Object.assign(set, { 'handoverShopsArray.$.state': c.state, 'handoverShopsArray.$.issues': c.issues, 'handoverShopsArray.$.updatedAt': new Date(), 'handoverShopsArray.$.updatedBy': actor.id, updatedBy: actor.id });
  for (const f of SHOP_FIELDS) set[`handoverShopsArray.$.${f}`] = c.fields[f];
  const r = await SalesOrder.updateOne({ ...stillOpen(o), 'handoverShopsArray.rowId': rowId }, { $set: set, $push: { handoverShopLogs: log } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  await syncShopSummary(o._id);
  return findRow(o._id, rowId);
}

/** Delete a shop row; its images are erased and its values kept in the row history. */
export async function deleteShopRow(id: string, rowId: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  await handoverRoute(o);
  const before = await findRow(o._id, rowId);
  const columns = columnsOf(o);
  const log = columns
    ? shopLog(actor, 'DELETE', rowId, { before: measureOf(before), cells: cellChanges(columns, cleanCells(before.cells as Cells | undefined, columns), null), label: labelOf(before, columns) })
    : shopLog(actor, 'DELETE', rowId, { before: snapshot(before), label: rowLabel(before) });
  const r = await SalesOrder.updateOne(stillOpen(o), {
    $pull: { handoverShopsArray: { rowId } },
    $push: { handoverShopLogs: log },
    $set: { updatedBy: actor.id },
  });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  for (const f of (before.attachments ?? []) as StoredFile[]) await eraseStoredFile(f, actor, ownerOf(o._id));
  await syncShopSummary(o._id);
  return { rowId, deleted: true };
}

/** Changes of one row (or of the whole table), newest first. */
export async function shopHistory(id: string, rowId?: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('handoverShopLogs').populate('handoverShopLogs.by', 'name role').lean();
  if (!o) throw AppError.notFound('Order not found');
  return (o.handoverShopLogs ?? [])
    .filter((l) => !l.type && (!rowId || l.rowId === rowId))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, 300);
}

/** Files attached to shop rows (erased when the table is cleared). */
async function rowFiles(orderId: Types.ObjectId) {
  const doc = await SalesOrder.findById(orderId).select('handoverShopsArray.attachments').lean();
  return (doc?.handoverShopsArray ?? []).flatMap((x) => (x.attachments ?? []) as StoredFile[]);
}

/** Shop + Measurement: up to 10 images per shop row. Allowed before and after handover. */
export async function addShopFiles(id: string, rowId: string, files: UploadedFile[], actor: Actor) {
  if (!files.length) throw new AppError(422, 'VALIDATION_ERROR', 'Choose at least one image', [{ path: 'files', message: 'Choose at least one image' }]);
  const bad = files.find((f) => !IMAGE_RE.test(f.originalname));
  if (bad) throw AppError.badRequest(`${bad.originalname}: shop images must be JPG, PNG or WEBP`);
  const o = await liveOrder(id);
  if (o.handoverType !== 'SHOP_MEASUREMENT') throw AppError.conflict('Shop images are for Shop + Measurement handovers');
  await handoverRoute(o);
  const row = await findRow(o._id, rowId);
  const has = (row.attachments ?? []).length;
  if (has + files.length > MAX_ROW_IMAGES) throw AppError.conflict(`Up to ${MAX_ROW_IMAGES} images per shop (this one has ${has}).`);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeHandoverFile(o, f, actor));
    // Conditional on the count, so two uploads at once cannot pass the limit together.
    const r = await SalesOrder.updateOne(
      { _id: o._id, handoverShopsArray: { $elemMatch: { rowId, $or: [{ attachments: { $exists: false } }, { attachments: { $size: has } }, { attachments: null }] } } },
      {
        $push: { 'handoverShopsArray.$.attachments': { $each: stored }, handoverShopLogs: shopLog(actor, 'IMAGE_ADD', rowId, { note: stored.map((x) => x.name).join(', ') }) },
        $set: { 'handoverShopsArray.$.updatedAt': new Date(), 'handoverShopsArray.$.updatedBy': actor.id, updatedBy: actor.id },
      },
    );
    if (!r.matchedCount) throw AppError.conflict('The images of this shop changed meanwhile. Reload and try again.');
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  return findRow(o._id, rowId);
}

export async function removeShopFile(id: string, rowId: string, fileId: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  await handoverRoute(o);
  const row = await findRow(o._id, rowId);
  const file = ((row.attachments ?? []) as StoredFile[]).find((a) => String(a.fileId) === fileId);
  if (!file) throw AppError.notFound('Image not found');
  const r = await SalesOrder.updateOne(
    { ...stillOpen(o), 'handoverShopsArray.rowId': rowId },
    {
      $pull: { 'handoverShopsArray.$.attachments': { fileId: file.fileId } },
      $push: { handoverShopLogs: shopLog(actor, 'IMAGE_REMOVE', rowId, { note: file.name ?? 'image' }) },
      $set: { 'handoverShopsArray.$.updatedAt': new Date(), 'handoverShopsArray.$.updatedBy': actor.id },
    },
  );
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  await eraseStoredFile(file, actor, ownerOf(o._id));
  return findRow(o._id, rowId);
}

/** Shop rows, filtered by state and paged (the list can be thousands of rows), with who changed each row last. */
export async function listShops(id: string, q: { page: number; limit: number; state?: 'VALID' | 'WARNING' | 'ERROR' | undefined }) {
  await ensureRowIds(id);
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('handoverType handoverShopsArray shopColumns').lean();
  if (!o) throw AppError.notFound('Order not found');
  if (!isShopType(o.handoverType)) return { items: [], meta: { page: q.page, limit: q.limit, total: 0, totalPages: 1, columns: null } };
  const rows = (o.handoverShopsArray ?? []).filter((r) => !q.state || r.state === q.state);
  const page = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
  const ids = [...new Set(page.map((r) => r.updatedBy && String(r.updatedBy)).filter(Boolean))] as string[];
  const names = new Map((await User.find({ _id: { $in: ids } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const items = page.map((r) => ({ ...r, updatedByName: r.updatedBy ? (names.get(String(r.updatedBy)) ?? null) : null }));
  // columns: the imported columns in sheet order (null for tables from before them).
  return { items, meta: { page: q.page, limit: q.limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / q.limit)), columns: columnsOf(o) } };
}

/**
 * Blank shop list in the columns the project site import understands. Shop + Measurement carries Size (W x H);
 * Shop Details Only is the same list without Size.
 */
export const shopTemplate = (type: 'SHOP_DETAILS' | 'SHOP_MEASUREMENT' = 'SHOP_MEASUREMENT') =>
  buildTemplate('CLIENT_PROVIDED', type === 'SHOP_DETAILS' ? ['size'] : []);

async function storeHandoverFile(o: { _id: Types.ObjectId; orderNo: string; client: unknown }, file: UploadedFile, actor: Actor, category: 'SALES_HANDOVER_DOCUMENT' | 'SALES_HANDOVER_VOICE_NOTE' = 'SALES_HANDOVER_DOCUMENT') {
  const client = await Client.findById(o.client).select('name').lean();
  return storeEmbeddedFile({ category, clientName: client?.name ?? 'Client', folderKey: o.orderNo, file, actor, owner: ownerOf(o._id) });
}

const NAME_FIELDS: readonly string[] = ['shopName', 'dealerName'];
const HEADER_SCAN = 15;
const SIZED_TARGETS: readonly string[] = ['width', 'height', 'size', 'unit'];
/** Columns the app adds to Download Excel (ignored when that file is uploaded again, unless the sheet has them). */
const EXPORT_APP = ['size (w x h)', 'unit'];

/** Header cells made non-blank and unique ("Column 3", "Mobile (2)"): internal keys for the field mapping only. */
function headerNames(cells: string[], width: number) {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    const base = (cells[i] ?? '').replace(/\./g, ' ').replace(/^\$+/, '').replace(/\s+/g, ' ').trim().slice(0, 120) || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
}

/** The likeliest header row of a sheet: the most recognised columns, one of them a shop or dealer name. */
function detectHeader(g: SheetGrid): { index: number; score: number } | null {
  let best: { index: number; score: number } | null = null;
  g.rows.slice(0, HEADER_SCAN).forEach((r, index) => {
    const known = Object.values(autoMap(headerNames(r.cells, r.cells.length))).filter((t) => t !== 'extra' && t !== 'ignore');
    if (known.some((t) => NAME_FIELDS.includes(t)) && (!best || known.length > best.score)) best = { index, score: known.length };
  });
  return best;
}

type UploadOptions = { sheet?: string | undefined; headerRow?: number | undefined; mapping?: Record<string, string> | undefined; preview?: boolean | undefined };

/**
 * The table to import, as the sheet has it: the sheet, its header row (original header texts, blank and repeated ones
 * included, in sheet order), and the data rows with every cell as displayed (fully blank rows are skipped). `keys` /
 * `mapping` only say which column feeds which shop field internally; they never rename, merge or drop a column.
 * Several sheets with data and no single list among them: 422 SHOP_MAPPING_REQUIRED with a preview so the BD picks the
 * sheet (and, if needed, the header row).
 */
export function resolveImport(grids: SheetGrid[], opts: UploadOptions, type: string | null | undefined) {
  const filled = grids.filter((g) => g.rows.length);
  if (!filled.length) throw AppError.badRequest('The file is empty: no sheet has any rows.');
  const fields = MAPPABLE.filter((f) => type === 'SHOP_MEASUREMENT' || !SIZED_TARGETS.includes(f));
  const ask = (sheet: SheetGrid, headerIndex: number, message: string, headers: string[], mapping: Record<string, MapTarget>): never => {
    throw new AppError(422, 'SHOP_MAPPING_REQUIRED', message, {
      preview: {
        sheets: filled.map((g) => ({ name: g.name, rows: g.rows.length })),
        sheet: sheet.name,
        headerRow: sheet.rows[headerIndex]?.rowNumber ?? null,
        rows: sheet.rows.slice(0, 8).map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.slice(0, 40) })),
        headers,
        mapping,
        problems: [],
        fields,
      },
    });
  };

  let sheet: SheetGrid | undefined;
  if (opts.sheet) {
    sheet = filled.find((g) => g.name === opts.sheet);
    if (!sheet) throw new AppError(422, 'VALIDATION_ERROR', `Sheet "${opts.sheet}" was not found or is empty`, [{ path: 'sheet', message: 'Choose another sheet' }]);
  } else if (filled.length === 1) sheet = filled[0];
  else {
    // A notes / instructions sheet has no rows below a header: the one sheet that has them is the list.
    const lists = filled.filter((g) => g.rows.length > 1);
    if (lists.length === 1) sheet = lists[0];
  }
  if (!sheet) {
    const first = filled[0]!;
    const h = headerNames(first.rows[0]!.cells, first.rows[0]!.cells.length);
    return ask(first, 0, 'This workbook has several sheets with data. Choose the sheet with the shop list.', h, autoMap(h));
  }

  const headerIndex = opts.headerRow ? sheet.rows.findIndex((r) => r.rowNumber === opts.headerRow) : (detectHeader(sheet)?.index ?? 0);
  if (headerIndex < 0) throw new AppError(422, 'VALIDATION_ERROR', `Row ${opts.headerRow} is blank or outside the sheet`, [{ path: 'headerRow', message: 'Choose another header row' }]);
  const dataRows = sheet.rows.slice(headerIndex + 1);
  const headerCells = sheet.rows[headerIndex]!.cells;
  const width = Math.min(MAX_COLUMNS, Math.max(headerCells.length, ...dataRows.map((r) => r.cells.length)));
  const headers = Array.from({ length: width }, (_, i) => headerCells[i] ?? '');
  const keys = headerNames(headerCells, width);

  let mapping: Record<string, MapTarget>;
  if (opts.mapping) {
    const allowed = new Set<string>(fields);
    const used = new Set<string>();
    mapping = Object.fromEntries(
      keys.map((k) => {
        const t = opts.mapping![k] ?? '';
        const ok = allowed.has(t) && !used.has(t);
        if (ok) used.add(t);
        return [k, (ok ? t : 'extra') as MapTarget];
      }),
    );
  } else {
    mapping = autoMap(keys);
    // Shop Details Only has no size: such a column is kept as a plain column.
    for (const k of keys) if (mapping[k] !== 'extra' && !fields.includes(mapping[k] as MappableField)) mapping[k] = 'extra';
  }
  if (opts.preview) return ask(sheet, headerIndex, 'Check the sheet and header row, then import.', keys, mapping);
  if (!dataRows.length) throw new AppError(422, 'VALIDATION_ERROR', 'The sheet has a header row but no rows below it', [{ path: 'file', message: 'No data rows' }]);
  if (dataRows.length > MAX_ROWS) throw AppError.badRequest(`Too many rows (limit ${MAX_ROWS}). Split the file and upload it in parts.`);
  return {
    sheet: sheet.name,
    headers,
    keys,
    mapping,
    rows: dataRows.map((r) => ({ rowNumber: r.rowNumber, cells: Array.from({ length: width }, (_, i) => r.cells[i] ?? '') })),
  };
}

/** A row from before imported columns, as cells of the new columns (from its fields and extra columns). */
function legacyCells(r: Record<string, unknown>, columns: ShopColumn[]): Cells {
  const extra = (r.extra ?? {}) as Record<string, string>;
  const cells: Cells = {};
  for (const c of columns) {
    let v: unknown = c.field === 'size' ? (r.width && r.height ? `${r.width}x${r.height}` : null) : c.field ? r[c.field] : null;
    if (v == null || v === '') v = extra[c.header.trim()];
    if (v != null && v !== '') cells[c.id] = String(v);
  }
  return cells;
}

/**
 * Shop list Excel (.xlsx / .xls) or CSV, imported as the sheet is: its columns (original headers, order, blank and
 * repeated headers) become the table's columns, and every cell is kept as Excel displays it. Recognisable columns also
 * feed the shop fields used for the checks and downstream; nothing is renamed, merged or hidden, and a missing
 * template column never rejects the file. Rows are ADDED (columns matched by header, new ones appended); a row with a
 * "Row ID" of the downloaded Excel updates that row instead (its images stay). Every change is logged.
 */
export async function uploadShopList(id: string, file: UploadedFile | undefined, actor: Actor, opts: UploadOptions = {}) {
  if (!file) throw new AppError(422, 'VALIDATION_ERROR', 'Choose the shop list file', [{ path: 'file', message: 'Choose the shop list file' }]);
  if (!/\.(xlsx|xls|csv)$/i.test(file.originalname)) throw AppError.badRequest('Upload the shop list as an Excel (.xlsx / .xls) or .csv file');
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  assertShopType(o);
  await ensureRowIds(o._id);

  const parsed = resolveImport(await readGrids(file.buffer, file.originalname), opts, o.handoverType);
  const doc = await SalesOrder.findById(o._id).select('handoverShopsArray shopColumns shopList.fileHash').lean();
  // The same file again (e.g. a retry after a slow response) would add every row twice.
  const fileHash = createHash('sha256').update(file.buffer).digest('hex');
  if (doc?.shopList?.fileHash === fileHash) throw new AppError(409, 'SHOP_LIST_ALREADY_IMPORTED', 'This file is already imported: its rows are in the table. Edit the rows there, or upload a changed file.');
  const existing = columnsOf(doc);
  const columns: ShopColumn[] = existing ? [...existing] : [];
  let nextCol = Math.max(0, ...columns.map((c) => Number(c.id.slice(1)) || 0));
  const usedFields = new Set(columns.map((c) => c.field).filter(Boolean));
  const norm = (h: string) => h.trim().toLowerCase();
  // Download Excel carries "Row ID" and app columns (status, images...): those are not sheet columns.
  const fromExport = parsed.headers.some((h) => norm(h) === 'row id');
  let rowIdIdx = -1;
  const seenHeader = new Map<string, number>();
  const colOfIdx = parsed.headers.map((h, i) => {
    const key = norm(h);
    if (fromExport && key === 'row id' && rowIdIdx < 0) {
      rowIdIdx = i;
      return null;
    }
    const n = seenHeader.get(key) ?? 0;
    seenHeader.set(key, n + 1);
    const match = columns.filter((c) => norm(c.header) === key)[n];
    if (match) return match.id;
    if (fromExport && (EXPORT_ONLY.includes(key) || EXPORT_APP.includes(key))) return null;
    if (columns.length >= MAX_COLUMNS) throw AppError.badRequest(`The shop table can have up to ${MAX_COLUMNS} columns.`);
    const target = parsed.mapping[parsed.keys[i]!];
    const field = target && target !== 'extra' && target !== 'ignore' && !usedFields.has(target) ? target : null;
    if (field) usedFields.add(field);
    const col: ShopColumn = { id: `c${++nextCol}`, header: h, field };
    columns.push(col);
    return col.id;
  });

  // Rows from before imported columns get cells for the new columns, so the table stays one table.
  const current = (doc?.handoverShopsArray ?? []).map((r) => (existing || (r as { cells?: unknown }).cells ? r : { ...r, cells: legacyCells(r as unknown as Record<string, unknown>, columns) }));
  const byId = new Map(current.map((r) => [r.rowId!, r as typeof r & Record<string, unknown>]));
  const seen = new Map<string, string>();
  for (const r of current) {
    const k = dupKeyOf(r as never);
    if (k) seen.set(k, `row ${r.rowNumber}`);
  }
  let next = Math.max(0, ...current.map((r) => r.rowNumber ?? 0));
  const now = new Date();
  const updates = new Map<string, Record<string, unknown>>();
  const added: Record<string, unknown>[] = [];
  const logs: ReturnType<typeof shopLog>[] = [];
  /** Rows of the file that came in with problems (Excel line, table row), so the BD can fix them in the table. */
  const flagged: { line: number; row: number; state: string; issues: string[] }[] = [];
  const source = `${file.originalname} (${parsed.sheet})`;
  for (const row of parsed.rows) {
    const fileCells: Cells = {};
    const inFile = new Set<string>();
    row.cells.forEach((v, i) => {
      const cid = colOfIdx[i];
      if (!cid) return;
      inFile.add(cid);
      if (v.trim() !== '') fileCells[cid] = v.slice(0, MAX_CELL);
    });
    const rid = rowIdIdx >= 0 ? (row.cells[rowIdIdx] ?? '').trim() : '';
    const prev = rid ? byId.get(rid) : undefined;
    if (prev) {
      const oldCells = cleanCells(prev.cells as Cells | undefined, columns);
      const newCells = { ...oldCells };
      for (const cid of inFile) {
        if (fileCells[cid] !== undefined) newCells[cid] = fileCells[cid];
        else delete newCells[cid];
      }
      const changes = cellChanges(columns, oldCells, newCells);
      if (!changes.length) continue;
      const c = deriveRow(newCells, columns, o.handoverType, prev);
      updates.set(rid, { ...c.fields, cells: newCells, state: c.state, issues: c.issues, updatedAt: now, updatedBy: new Types.ObjectId(actor.id) });
      logs.push(shopLog(actor, 'EDIT', rid, { cells: changes, note: `From ${source}`, label: labelOf({ ...prev, ...c.fields, cells: newCells }, columns) }));
      if (c.state !== 'VALID') flagged.push({ line: row.rowNumber, row: prev.rowNumber ?? 0, state: c.state, issues: c.issues });
      continue;
    }
    if (!Object.keys(fileCells).length) continue;
    const c = deriveRow(fileCells, columns, o.handoverType);
    const key = dupKeyOf(c.fields as never);
    const issues = [...c.issues];
    let state = c.state;
    if (key && seen.has(key)) {
      issues.push(`Same shop as ${seen.get(key)}`);
      if (state === 'VALID') state = 'WARNING';
    }
    const rowNumber = ++next;
    if (key) seen.set(key, `row ${rowNumber}`);
    const fresh = { rowNumber, ...c.fields, cells: fileCells, state, issues, rowId: newRowId(), updatedAt: now, updatedBy: new Types.ObjectId(actor.id) };
    added.push(fresh);
    logs.push(shopLog(actor, 'ADD', fresh.rowId, { cells: cellChanges(columns, null, fileCells), note: `From ${source}`, label: labelOf(fresh, columns) }));
    if (state !== 'VALID') flagged.push({ line: row.rowNumber, row: rowNumber, state, issues });
  }
  if (!added.length && !updates.size) throw AppError.badRequest('Nothing to add: the file has no new or changed rows.');

  const merged = [...current.map((r) => (updates.has(r.rowId!) ? { ...r, ...updates.get(r.rowId!) } : r)), ...added];
  const stored = await storeHandoverFile(o, file, actor);
  // Large imports keep one summary entry instead of a log line per row.
  const history = logs.length <= 500 ? logs : [];
  history.push(shopLog(actor, 'IMPORT', null, { note: `${source}: ${added.length} added, ${updates.size} updated` }));
  const count = (st: string) => merged.filter((r) => r.state === st).length;
  // The summary is written whole: a dotted "shopList.x" path cannot be set while shopList is null (a new or cleared
  // table), which made MongoDB reject the first upload of every order.
  const shopList = { fileId: stored.fileId, fileName: file.originalname.slice(0, 200), uploadedBy: new Types.ObjectId(actor.id), uploadedAt: now, fileHash, total: merged.length, valid: count('VALID'), warning: count('WARNING'), error: count('ERROR'), duplicates: 0 };
  const r = await SalesOrder.updateOne(
    { ...stillOpen(o), handoverShopsArray: { $size: current.length } },
    {
      $set: { handoverShopsArray: merged, shopColumns: columns, shopList, declaredShopTotal: merged.length, handoverUpdatedAt: now, updatedBy: actor.id },
      $push: {
        handoverShopLogs: { $each: history },
        handoverDocumentsArray: { kind: 'SHOP_LIST', file: stored, uploadedBy: actor.id, role: actor.role, createdAt: now },
      },
    },
  ).catch(async (e: unknown) => {
    await discardStoredFiles([stored]);
    throw e;
  });
  if (!r.matchedCount) {
    await discardStoredFiles([stored]);
    throw AppError.conflict('The shop list changed meanwhile (or the order was handed over). Reload and upload again.');
  }
  await recordAudit({ actor, action: 'UPLOAD', entity: 'SalesOrder', entityId: o._id, reason: `Shop list ${source}: ${added.length} rows added, ${updates.size} updated` });
  return {
    ...(await getHandover(id)),
    imported: {
      added: added.length,
      updated: updates.size,
      sheet: parsed.sheet,
      columns: columns.length,
      flaggedCount: flagged.length,
      flagged: flagged.slice(0, 100),
    },
  };
}

/** Clears the whole shop table (before handover only); the rows stay in the history. */
export async function removeShopList(id: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  await handoverRoute(o);
  const doc = await SalesOrder.findById(o._id).select('handoverShopsArray').lean();
  const count = doc?.handoverShopsArray?.length ?? 0;
  const oldRowFiles = await rowFiles(o._id);
  const r = await SalesOrder.updateOne(stillOpen(o), {
    $set: { handoverShopsArray: [], shopColumns: null, shopList: null, declaredShopTotal: null, updatedBy: actor.id },
    $push: { handoverShopLogs: shopLog(actor, 'CLEAR', null, { note: `${count} row${count === 1 ? '' : 's'} cleared` }) },
  });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  for (const f of oldRowFiles) await eraseStoredFile(f, actor, ownerOf(o._id));
  return getHandover(id);
}

/** Neutralise spreadsheet formula injection from typed text. */
const cellSafe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const istStamp = (d?: Date | null) => (d ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(d).toUpperCase().replace(/(\d{4}),/, '$1,') : '');

/**
 * The shop table as it is now, as Excel. The "Row ID" column ties each line to its row, so the file can be edited and
 * uploaded again without losing the row's images. Shop + Measurement adds Size and Unit.
 */
export async function exportShops(id: string) {
  await ensureRowIds(id);
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('orderNo handoverType handoverShopsArray shopColumns').lean();
  if (!o) throw AppError.notFound('Order not found');
  if (!isShopType(o.handoverType)) throw AppError.conflict('This handover has no shop list (ASO).');
  const sized = o.handoverType === 'SHOP_MEASUREMENT';
  const columns = columnsOf(o);
  if (columns) return exportColumns(o, columns, sized);
  const cols: [string, (r: Record<string, any>) => unknown, number][] = [
    ['Row ID', (r) => r.rowId, 26],
    ['Shop Name', (r) => r.shopName, 26],
    ['Dealer Name', (r) => r.dealerName, 24],
    ['Location', (r) => r.location, 18],
    ['District', (r) => r.district, 16],
    ['Address 1', (r) => r.address1, 30],
    ['Address 2', (r) => r.address2, 24],
    ['Address 3', (r) => r.address3, 18],
    ['Pincode', (r) => r.pincode, 10],
    ['Mobile', (r) => [r.mobile, r.mobileAlt].filter(Boolean).join(' / '), 24],
    ['GST No', (r) => r.gstin, 18],
    ['Contact Person', (r) => r.contactPerson, 18],
    ...(sized ? ([['Size (W x H)', (r) => (r.width && r.height ? `${r.width}x${r.height}` : ''), 12], ['Unit', (r) => r.unit, 7]] as [string, (r: Record<string, any>) => unknown, number][]) : []),
    ['Board Type', (r) => r.boardType, 18],
    ['Qty', (r) => r.quantity, 7],
    ['Remarks', (r) => r.remarks, 28],
    ['Client Site Code', (r) => r.clientSiteCode, 16],
    // Extra columns of the uploaded files, in the order they first appear (uploading this file again keeps them).
    ...[...new Set((o.handoverShopsArray ?? []).flatMap((r) => Object.keys((r as { extra?: Record<string, string> }).extra ?? {})))].map(
      (k) => [k, (r: Record<string, any>) => r.extra?.[k], 18] as [string, (r: Record<string, any>) => unknown, number],
    ),
    ...(sized ? ([['Images', (r) => r.attachments?.length ?? 0, 8]] as [string, (r: Record<string, any>) => unknown, number][]) : []),
    ['Status', (r) => r.state, 10],
    ['Issues', (r) => (r.issues ?? []).join('; '), 36],
    ['Modified At', (r) => istStamp(r.updatedAt), 22],
  ];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shops');
  ws.columns = cols.map(([header, , width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of o.handoverShopsArray ?? []) ws.addRow(cols.map(([, get]) => cellSafe(get(r as Record<string, any>) ?? '')));
  return { name: `${o.orderNo.replace(/[^\w-]+/g, '_')}_shop_list.xlsx`, buffer: Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer) };
}

/** Imported-columns table as Excel: Row ID, the sheet's own columns as uploaded (text, so zeros stay), then the app columns. */
async function exportColumns(o: { orderNo: string; handoverShopsArray?: unknown[] | null }, columns: ShopColumn[], sized: boolean) {
  const appSize = sized && !hasSizeColumn(columns);
  const app: [string, (r: Record<string, any>) => unknown][] = [
    ...(appSize ? ([['Size (W x H)', (r) => (r.width && r.height ? `${r.width}x${r.height}` : '')], ['Unit', (r) => r.unit]] as [string, (r: Record<string, any>) => unknown][]) : []),
    ...(sized ? ([['Images', (r) => r.attachments?.length ?? 0]] as [string, (r: Record<string, any>) => unknown][]) : []),
    ['Status', (r) => r.state],
    ['Issues', (r) => (r.issues ?? []).join('; ')],
    ['Modified At', (r) => istStamp(r.updatedAt)],
  ];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shops');
  const headers = ['Row ID', ...columns.map((c) => c.header), ...app.map(([h]) => h)];
  ws.columns = headers.map((header, i) => ({ header, width: i === 0 ? 26 : Math.min(40, Math.max(12, header.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of (o.handoverShopsArray ?? []) as Record<string, any>[]) {
    const cells = (r.cells ?? {}) as Record<string, string>;
    ws.addRow([r.rowId, ...columns.map((c) => cellSafe(cells[c.id] ?? '')), ...app.map(([, get]) => cellSafe(get(r) ?? ''))]);
  }
  return { name: `${o.orderNo.replace(/[^w-]+/g, '_')}_shop_list.xlsx`, buffer: Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer) };
}

/* --------------------------- communication (chat) --------------------------- */

const MAX_MESSAGES = 1000;

/**
 * One chat message on the handover: text, attachments (any document / image type) or a voice note (one audio file,
 * recorded or uploaded). Allowed before and after handover; once handed over the Client Servicing person is notified.
 */
export async function addMessage(id: string, input: { text?: string | undefined; voice?: boolean | undefined; durationSec?: number | undefined }, files: UploadedFile[], actor: Actor) {
  const text = input.text?.trim() || undefined;
  if (!text && !files.length) throw new AppError(422, 'VALIDATION_ERROR', 'Write a message or attach a file', [{ path: 'text', message: 'Write a message or attach a file' }]);
  if (input.voice && (files.length !== 1 || !AUDIO_RE.test(files[0]!.originalname)))
    throw new AppError(422, 'VALIDATION_ERROR', 'A voice note is one audio file (MP3, M4A, WebM, Ogg or WAV)', [{ path: 'files', message: 'A voice note is one audio file' }]);
  const o = await liveOrder(id);
  await handoverRoute(o);
  const count = await SalesOrder.findById(o._id).select('handoverMessagesArray._id').lean();
  if ((count?.handoverMessagesArray?.length ?? 0) >= MAX_MESSAGES) throw AppError.conflict(`Up to ${MAX_MESSAGES} messages per order`);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeHandoverFile(o, f, actor, input.voice ? 'SALES_HANDOVER_VOICE_NOTE' : 'SALES_HANDOVER_DOCUMENT'));
    const afterHandover = !!(o.csAssignee || o.recce?.assignee);
    await SalesOrder.updateOne(
      { _id: o._id },
      {
        $push: {
          handoverMessagesArray: {
            text,
            attachments: input.voice ? [] : stored,
            voice: input.voice ? { file: stored[0], durationSec: input.durationSec } : null,
            by: actor.id,
            role: actor.role,
            afterHandover,
            createdAt: new Date(),
          },
        },
        $set: { updatedBy: actor.id },
      },
    );
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  // The other side hears about it: a Client Servicing reply goes to the BD (order owner and who handed it over);
  // a BD message after handover goes to the Client Servicing person.
  const recipients = (isCs(actor) ? [o.owner, o.handover?.assignedBy] : [o.csAssignee])
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map(String)
    .filter((u, i, all) => u !== actor.id && all.indexOf(u) === i);
  if (recipients.length) {
    await notify({
      recipients,
      kind: 'ORDER_ASSIGNED',
      title: isCs(actor) ? 'Client Servicing replied on a handover' : 'New handover message',
      body: `${input.voice ? 'A voice note' : stored.length ? `A message with ${stored.length} file${stored.length === 1 ? '' : 's'}` : 'A message'} was added to ${o.orderNo}.`,
      order: { _id: o._id, orderNo: o.orderNo },
      actorId: actor.id,
      dedupe: (r) => `order-msg:${o._id}:${Date.now()}:${r}`,
    });
  }
  return getHandover(id);
}

/** The author (or a Super Admin) deletes a message before handover; its files are erased. */
export async function removeMessage(id: string, messageId: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const doc = await SalesOrder.findOne({ _id: o._id, 'handoverMessagesArray._id': messageId }, { 'handoverMessagesArray.$': 1 }).lean();
  const m = doc?.handoverMessagesArray?.[0];
  if (!m) throw AppError.notFound('Message not found');
  if (String(m.by) !== actor.id && actor.role !== 'SUPER_ADMIN') throw AppError.forbidden('Only the sender can delete this message');
  const r = await SalesOrder.updateOne(stillOpen(o), { $pull: { handoverMessagesArray: { _id: m._id } }, $set: { updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  // Files that went out with a project code request email stay (the email history still shows them).
  const mailed = await SalesOrder.findById(o._id).select('salesprofile.attachments.fileId').lean();
  const keep = new Set((mailed?.salesprofile ?? []).flatMap((e) => (e.attachments ?? []).map((a) => String(a.fileId))));
  const files = [...((m.attachments ?? []) as StoredFile[]), ...(m.voice?.file ? [m.voice.file as StoredFile] : [])].filter((f) => !keep.has(String(f.fileId)));
  for (const f of files) await eraseStoredFile(f, actor, ownerOf(o._id));
  return getHandover(id);
}

/**
 * The client as it is handed over, saved with the assignment (`handoverClient`). GST certificates and custom fields
 * belong to New (Client Management) clients only; Existing (Zoho) clients carry neither.
 */
export async function clientSnapshot(o: { client: unknown; clientType?: string | null; handoverType?: string | null; soContacts?: { name?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean | null }[] | null }) {
  const c = await Client.findById(o.client).select('name clientName clientNo email phone gstin gstCertificates customFields contacts').lean();
  if (!c) return null;
  const crm = o.clientType !== 'EXISTING';
  return {
    clientType: o.clientType ?? null,
    name: c.name,
    clientName: c.clientName,
    clientNo: c.clientNo,
    email: c.email,
    phone: c.phone,
    gstin: c.gstin,
    gstCertificates: crm ? (c.gstCertificates ?? []) : undefined,
    customFields: crm ? (c.customFields ?? []).map((f) => ({ label: f.label, value: f.value })) : undefined,
    contacts: (c.contacts ?? []).map((k) => ({ name: k.name, designation: k.designation, phone: k.phone, email: k.email, isPrimary: !!k.isPrimary })),
    soContacts: o.handoverType === 'ASO' ? (o.soContacts ?? []).map((k) => ({ name: k.name, phone: k.phone, email: k.email ?? undefined, isPrimary: !!k.isPrimary })) : undefined,
    takenAt: new Date(),
  };
}

/**
 * Hands the order to a Client Servicing person (once; no reassignment). Client and contacts come from the client
 * record; shop list and documents are optional. The Client Servicing person is notified in the app (and by email).
 */
export async function assignClientServicing(id: string, input: { csUserId: string; note?: string | undefined }, actor: Actor) {
  const o = await liveOrder(id);
  if (o.csAssignee) {
    const who = await User.findById(o.csAssignee).select('name').lean();
    throw AppError.conflict(`This order is already handed over to ${who?.name ?? 'Client Servicing'}.`);
  }
  if (o.recce?.assignee) throw AppError.conflict('This project is already assigned to the Recce team.');
  if (!handoverUnlocked(o.lead)) throw AppError.conflict('Assign Client Servicing from the Project Assign stage in Lead Management.');
  if ((await routeOf(o)) === 'RECCE') throw AppError.conflict(ROUTE_LOCKED.RECCE);
  const client = await Client.findById(o.client).select('name').lean();
  const gaps = handoverGaps(o);
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', gaps[0]!, gaps.map((message) => ({ path: 'handover', message })));
  const cs = await User.findOne({ _id: input.csUserId, role: 'CLIENT_SERVICING', isActive: true, deletedAt: null }).select('name').lean();
  if (!cs) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active Client Servicing person', [{ path: 'csUserId', message: 'Choose an active Client Servicing person' }]);
  const full = isFull(o);
  const typeLabel = full ? HANDOVER_TYPE_LABELS[o.handoverType as HandoverType] : 'Client details only';
  const note = `Handed over to ${cs.name} (Client Servicing) · ${typeLabel}`;
  const now = new Date();
  // Toggle off: client details and contact persons only (no SO contacts).
  const snapshot = await clientSnapshot({ client: o.client, clientType: o.clientType, handoverType: full ? o.handoverType : null, soContacts: o.soContacts });
  // Assigning is the Project Assign step: the lead is completed in the same write.
  const lead = o.lead?.status === 'OPEN' && o.lead.stage === 'PROJECT_ASSIGN';
  // Conditional on the checked state: a list replaced, a type or the toggle changed meanwhile is not handed over unverified.
  const r = await SalesOrder.updateOne(
    {
      _id: o._id,
      csAssignee: null,
      'recce.assignee': null,
      assignRoute: { $in: [null, 'HANDOVER'] },
      ...(full
        ? // Shop types: the table checked above (row count, no error rows) is still the one handed over.
          { handoverFull: { $ne: false }, handoverType: o.handoverType, ...(o.handoverType === 'ASO' ? {} : { 'shopList.total': o.shopList?.total, 'shopList.error': { $in: [0, null] } }) }
        : { handoverFull: false }),
      ...(lead ? { 'lead.status': 'OPEN', 'lead.stage': 'PROJECT_ASSIGN' } : {}),
    },
    {
      $set: {
        csAssignee: cs._id,
        handover: { assignedBy: actor.id, assignedAt: now, note: input.note },
        handoverClient: snapshot,
        assignRoute: 'HANDOVER',
        updatedBy: actor.id,
        ...(lead ? { 'lead.status': 'COMPLETED', 'lead.completedAt': now, 'lead.completedBy': actor.id, 'lead.stageChangedAt': now } : {}),
      },
      $push: {
        salespipelineLogs: pipelineLog(actor, 'HANDOVER', o.stage, o.stage, note),
        ...(lead ? { leadLogsArray: leadLog(actor, 'COMPLETE', 'PROJECT_ASSIGN', null, `Assigned to Client Servicing (${cs.name}): lead completed`) } : {}),
      },
    },
  );
  if (!r.modifiedCount) throw AppError.conflict('This order was handed over meanwhile. Reload the page.');
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'csAssignee', oldValue: null, newValue: String(cs._id) }], reason: note });
  const bd = await User.findById(actor.id).select('name').lean();
  await notify({
    recipients: [cs._id],
    kind: 'ORDER_ASSIGNED',
    title: 'New order assigned to you',
    body: `${bd?.name ?? 'BD'} assigned order ${o.orderNo} (${client?.name ?? 'client'}, ${typeLabel}${full && isShopType(o.handoverType) && o.shopList ? `, ${o.shopList.total} shops` : ''}) to you on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.`,
    order: { _id: o._id, orderNo: o.orderNo, clientName: client?.name },
    actorId: actor.id,
    dedupe: (rid) => `order-assigned:${o._id}:${rid}`,
  });
  return getHandover(id);
}

/** The assigned Client Servicing person opened the order: clears its "New" badge. */
export async function markSeen(id: string, actor: Actor) {
  if (!isCs(actor)) return;
  await SalesOrder.updateOne({ _id: id, csAssignee: actor.id, 'handover.seenAt': null }, { $set: { 'handover.seenAt': new Date() } });
}
