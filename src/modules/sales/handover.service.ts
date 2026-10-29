import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { AppError } from '../../common/errors';
import { type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { notify } from '../notifications/notification.service';
import { buildTemplate, parseWorkbook } from '../sites/excel.service';
import { autoMap, dupKeyOf, normalise, validateMapping, type MapTarget, type MappableField } from '../sites/site.fields';
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

type GapInput = {
  handoverFull?: boolean | null;
  handoverType?: string | null;
  shopList?: { total?: number | null; error?: number | null } | null;
};
/** Toggle off = client details and contact persons only. Orders from before the toggle count as full. */
const isFull = (o: { handoverFull?: boolean | null }) => o.handoverFull !== false;

/**
 * What is still missing before the order can be handed over (empty = ready). ASO: contact persons, no shop list.
 * Shop types: at least one shop row and no row with errors (Total Shops = the rows in the table).
 */
export function handoverGaps(o: GapInput, contactCount: number): string[] {
  if (!isFull(o)) return contactCount ? [] : ['Add at least one contact person'];
  if (!o.handoverType) return ['Choose the handover type: ASO, Shop Details Only or Shop + Measurement'];
  if (o.handoverType === 'ASO') {
    const g: string[] = [];
    if (!contactCount) g.push('Add at least one contact person');
    if (o.shopList?.total) g.push('Clear the shop list: an ASO handover goes without one');
    return g;
  }
  if (!o.shopList?.total) return ['Add the shop list: upload the Excel or add the shops'];
  const bad = o.shopList.error ?? 0;
  if (bad) return [`${bad} shop row${bad === 1 ? ' has' : 's have'} errors: edit or delete ${bad === 1 ? 'it' : 'them'}`];
  return [];
}

/** Handover: type, who it went to, the shop list summary, the communication and what is still missing (rows come from listShops). */
export async function getHandover(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select('orderNo client csAssignee handover handoverFull handoverType declaredShopTotal shopList handoverDocumentsArray handoverMessagesArray handoverShopsArray.attachments.fileId')
    .populate('csAssignee', 'name email phone')
    .populate('handover.assignedBy', 'name role')
    .populate('handoverMessagesArray.by', 'name role')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  const client = await Client.findById(o.client).select('contacts').lean();
  const shops = o.handoverShopsArray ?? [];
  return {
    orderId: String(o._id),
    orderNo: o.orderNo,
    assignee: o.csAssignee ?? null,
    handover: o.handover ?? null,
    /** Toggle: full handover (true) or client details and contacts only (false). */
    full: isFull(o),
    type: (o.handoverType ?? null) as HandoverType | null,
    /** Row counts of the shop table (total = Total Shops) and the last uploaded Excel. */
    shopList: o.shopList ?? null,
    declaredShopTotal: o.declaredShopTotal ?? null,
    shopsWithFiles: shops.filter((x) => x.attachments?.length).length,
    shopFiles: shops.reduce((n, x) => n + (x.attachments?.length ?? 0), 0),
    /** Uploaded shop list files (Excel / CSV), newest first. */
    documents: [...(o.handoverDocumentsArray ?? [])].filter((d) => d.kind === 'SHOP_LIST').sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)),
    /** Communication & attachments, oldest first (chat order). */
    messages: o.handoverMessagesArray ?? [],
    missing: o.csAssignee ? [] : handoverGaps(o, client?.contacts?.length ?? 0),
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
  // Shop rows stay when switching between the shop types (sizes / images only show for Shop + Measurement); ASO asks to clear them.
  const r = await SalesOrder.updateOne(stillOpen(o), {
    $set: { handoverType: type, updatedBy: actor.id },
    $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, `Handover type set to ${HANDOVER_TYPE_LABELS[type]}`, { step: 'handover-type', oldValue: o.handoverType ?? null, newValue: type }) },
  });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
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
function cleanRow(values: ShopRowInput, type: string | null | undefined) {
  const n = normalise(values, { scenario: 'MEASUREMENT_REQUIRED', defaultUnit: 'ft' });
  const sized = type === 'SHOP_MEASUREMENT';
  const value: Record<string, unknown> = { ...n.value };
  if (!sized) for (const f of ['width', 'height', 'unit']) delete value[f];
  const errors = n.errors.filter((e) => sized || !SIZE_FIELDS.includes(e.field));
  const warnings = n.warnings.filter((e) => sized || !SIZE_FIELDS.includes(e.field));
  return {
    fields: Object.fromEntries(SHOP_FIELDS.map((f) => [f, value[f] ?? null])) as Record<ShopField, unknown>,
    state: (errors.length ? 'ERROR' : warnings.length ? 'WARNING' : 'VALID') as 'ERROR' | 'WARNING' | 'VALID',
    issues: [...errors, ...warnings].map((i) => i.message),
  };
}

/** The filled fields of a row (history before / after values). */
const snapshot = (r: Record<string, unknown>) => Object.fromEntries(SHOP_FIELDS.filter((f) => r[f] !== null && r[f] !== undefined && r[f] !== '').map((f) => [f, r[f]]));
const newRowId = () => new Types.ObjectId().toHexString();
const shopLog = (actor: Actor, action: string, rowId: string | null, extra: { before?: unknown; after?: unknown; note?: string } = {}) => ({
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

/** Add one shop row by hand. */
export async function addShopRow(id: string, values: ShopRowInput, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  assertShopType(o);
  await handoverRoute(o);
  await ensureRowIds(o._id);
  const c = cleanRow(values, o.handoverType);
  const last = await SalesOrder.findById(o._id).select('handoverShopsArray.rowNumber').lean();
  const rowNumber = Math.max(0, ...(last?.handoverShopsArray ?? []).map((r) => r.rowNumber ?? 0)) + 1;
  const row = { rowNumber, ...c.fields, state: c.state, issues: c.issues, rowId: newRowId(), updatedAt: new Date(), updatedBy: new Types.ObjectId(actor.id) };
  const r = await SalesOrder.updateOne(stillOpen(o), {
    $push: { handoverShopsArray: row, handoverShopLogs: shopLog(actor, 'ADD', row.rowId, { after: snapshot(row) }) },
    $set: { updatedBy: actor.id },
  });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  await syncShopSummary(o._id);
  return row;
}

/** Edit a shop row: the changed fields are logged with their old and new values. */
export async function updateShopRow(id: string, rowId: string, values: ShopRowInput, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  assertShopType(o);
  await handoverRoute(o);
  const before = await findRow(o._id, rowId);
  const c = cleanRow(values, o.handoverType);
  const changed = SHOP_FIELDS.filter((f) => String(before[f] ?? '') !== String(c.fields[f] ?? ''));
  if (!changed.length) return before;
  const set: Record<string, unknown> = { 'handoverShopsArray.$.state': c.state, 'handoverShopsArray.$.issues': c.issues, 'handoverShopsArray.$.updatedAt': new Date(), 'handoverShopsArray.$.updatedBy': actor.id, updatedBy: actor.id };
  for (const f of SHOP_FIELDS) set[`handoverShopsArray.$.${f}`] = c.fields[f];
  const r = await SalesOrder.updateOne(
    { ...stillOpen(o), 'handoverShopsArray.rowId': rowId },
    {
      $set: set,
      $push: {
        handoverShopLogs: shopLog(actor, 'EDIT', rowId, {
          before: Object.fromEntries(changed.map((f) => [f, before[f] ?? null])),
          after: Object.fromEntries(changed.map((f) => [f, c.fields[f]])),
        }),
      },
    },
  );
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
  const r = await SalesOrder.updateOne(stillOpen(o), {
    $pull: { handoverShopsArray: { rowId } },
    $push: { handoverShopLogs: shopLog(actor, 'DELETE', rowId, { before: snapshot(before) }) },
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
    .filter((l) => !rowId || l.rowId === rowId)
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
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('handoverShopsArray').lean();
  if (!o) throw AppError.notFound('Order not found');
  const rows = (o.handoverShopsArray ?? []).filter((r) => !q.state || r.state === q.state);
  const page = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
  const ids = [...new Set(page.map((r) => r.updatedBy && String(r.updatedBy)).filter(Boolean))] as string[];
  const names = new Map((await User.find({ _id: { $in: ids } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const items = page.map((r) => ({ ...r, updatedByName: r.updatedBy ? (names.get(String(r.updatedBy)) ?? null) : null }));
  return { items, meta: { page: q.page, limit: q.limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / q.limit)) } };
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

/**
 * Shop list Excel / CSV, read with the project site import rules (header auto-mapping, phone / GST / size checks).
 * Rows are ADDED to the table; a row carrying a "Row ID" of the downloaded Excel updates that row instead (its images
 * stay with it). Every change is logged.
 */
export async function uploadShopList(id: string, file: UploadedFile | undefined, actor: Actor) {
  if (!file) throw new AppError(422, 'VALIDATION_ERROR', 'Choose the shop list file', [{ path: 'file', message: 'Choose the shop list file' }]);
  if (!/\.(xlsx|csv)$/i.test(file.originalname)) throw AppError.badRequest('Upload the shop list as an .xlsx or .csv file');
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  assertShopType(o);
  await handoverRoute(o);
  await ensureRowIds(o._id);

  const parsed = await parseWorkbook(file.buffer, file.originalname);
  const mapping = autoMap(parsed.headers);
  const rowIdHeader = parsed.headers.find((h) => h.trim().toLowerCase() === 'row id');
  for (const h of parsed.headers) if (EXPORT_ONLY.includes(h.trim().toLowerCase())) mapping[h] = 'ignore';
  const problems = validateMapping(mapping, 'MEASUREMENT_REQUIRED');
  if (problems.length) throw new AppError(422, 'VALIDATION_ERROR', `${problems.join('. ')}. Use the shop list template columns.`, problems.map((message) => ({ path: 'file', message })));

  const current = (await SalesOrder.findById(o._id).select('handoverShopsArray').lean())?.handoverShopsArray ?? [];
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
  for (const row of parsed.rows) {
    const values: Record<string, string> = {};
    for (const [header, target] of Object.entries(mapping) as [string, MapTarget][]) {
      const v = row.raw[header] ?? '';
      if (target !== 'ignore' && target !== 'extra' && v) values[target as MappableField] = v;
    }
    const c = cleanRow(values, o.handoverType);
    const rid = rowIdHeader ? (row.raw[rowIdHeader] ?? '').trim() : '';
    const existing = rid ? byId.get(rid) : undefined;
    if (existing) {
      const changed = SHOP_FIELDS.filter((f) => String(existing[f] ?? '') !== String(c.fields[f] ?? ''));
      if (!changed.length) continue;
      updates.set(rid, { ...c.fields, state: c.state, issues: c.issues, updatedAt: now, updatedBy: new Types.ObjectId(actor.id) });
      logs.push(shopLog(actor, 'EDIT', rid, { before: Object.fromEntries(changed.map((f) => [f, existing[f] ?? null])), after: Object.fromEntries(changed.map((f) => [f, c.fields[f]])), note: `From ${file.originalname}` }));
      continue;
    }
    const key = dupKeyOf(c.fields as never);
    const issues = [...c.issues];
    let state = c.state;
    if (key && seen.has(key)) {
      issues.push(`Same shop as ${seen.get(key)}`);
      if (state === 'VALID') state = 'WARNING';
    }
    const rowNumber = ++next;
    if (key) seen.set(key, `row ${rowNumber}`);
    const fresh = { rowNumber, ...c.fields, state, issues, rowId: newRowId(), updatedAt: now, updatedBy: new Types.ObjectId(actor.id) };
    added.push(fresh);
    logs.push(shopLog(actor, 'ADD', fresh.rowId, { after: snapshot(fresh), note: `From ${file.originalname}` }));
  }
  if (!added.length && !updates.size) throw AppError.badRequest('Nothing to add: the file has no new or changed shop rows.');

  const merged = [...current.map((r) => (updates.has(r.rowId!) ? { ...r, ...updates.get(r.rowId!) } : r)), ...added];
  const stored = await storeHandoverFile(o, file, actor);
  // Large imports keep one summary entry instead of a log line per row.
  const history = logs.length <= 500 ? logs : [];
  history.push(shopLog(actor, 'IMPORT', null, { note: `${file.originalname}: ${added.length} added, ${updates.size} updated` }));
  const r = await SalesOrder.updateOne(
    { ...stillOpen(o), handoverShopsArray: { $size: current.length } },
    {
      $set: { handoverShopsArray: merged, 'shopList.fileId': stored.fileId, 'shopList.fileName': file.originalname.slice(0, 200), 'shopList.uploadedBy': actor.id, 'shopList.uploadedAt': now, updatedBy: actor.id },
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
  await syncShopSummary(o._id);
  await recordAudit({ actor, action: 'UPLOAD', entity: 'SalesOrder', entityId: o._id, reason: `Shop list ${file.originalname}: ${added.length} rows added, ${updates.size} updated` });
  return { ...(await getHandover(id)), imported: { added: added.length, updated: updates.size } };
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
    $set: { handoverShopsArray: [], shopList: null, declaredShopTotal: null, updatedBy: actor.id },
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
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('orderNo handoverType handoverShopsArray').lean();
  if (!o) throw AppError.notFound('Order not found');
  const sized = o.handoverType === 'SHOP_MEASUREMENT';
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
  if (o.csAssignee) {
    await notify({
      recipients: [o.csAssignee],
      kind: 'ORDER_ASSIGNED',
      title: 'New handover message',
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
export async function clientSnapshot(o: { client: unknown; clientType?: string | null }) {
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
  const client = await Client.findById(o.client).select('name contacts').lean();
  const gaps = handoverGaps(o, client?.contacts?.length ?? 0);
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', gaps[0]!, gaps.map((message) => ({ path: 'handover', message })));
  const cs = await User.findOne({ _id: input.csUserId, role: 'CLIENT_SERVICING', isActive: true, deletedAt: null }).select('name').lean();
  if (!cs) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active Client Servicing person', [{ path: 'csUserId', message: 'Choose an active Client Servicing person' }]);
  const full = isFull(o);
  const typeLabel = full ? HANDOVER_TYPE_LABELS[o.handoverType as HandoverType] : 'Client details only';
  const note = `Handed over to ${cs.name} (Client Servicing) · ${typeLabel}`;
  const now = new Date();
  const snapshot = await clientSnapshot(o);
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
        ? { handoverFull: { $ne: false }, handoverType: o.handoverType, ...(o.handoverType === 'ASO' ? {} : { 'shopList.fileId': o.shopList?.fileId, shopsVerifiedAt: { $ne: null } }) }
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
    body: `${bd?.name ?? 'BD'} assigned order ${o.orderNo} (${client?.name ?? 'client'}, ${typeLabel}${full && o.shopList ? `, ${o.shopList.total} shops` : ''}) to you on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.`,
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
