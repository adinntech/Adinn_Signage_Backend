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
import { SalesOrder, type HandoverType } from './sales.model';
import type { Scenario } from '../sites/site.fields';

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
/** Shop + Measurement lists must carry sizes (the client measured); Shop Details lists may leave them for the recce. */
const scenarioOf = (type: string | null | undefined): Scenario => (type === 'SHOP_MEASUREMENT' ? 'CLIENT_PROVIDED' : 'MEASUREMENT_REQUIRED');

type GapInput = {
  handoverFull?: boolean | null;
  handoverType?: string | null;
  shopList?: { total?: number | null } | null;
  declaredShopTotal?: number | null;
  shopsVerifiedAt?: Date | null;
};
/** Toggle off = client details and contact persons only. Orders from before the toggle count as full. */
const isFull = (o: { handoverFull?: boolean | null }) => o.handoverFull !== false;

/** What is still missing before the order can be handed over (empty = ready). */
export function handoverGaps(o: GapInput, contactCount: number): string[] {
  if (!isFull(o)) return contactCount ? [] : ['Add at least one contact person'];
  if (!o.handoverType) return ['Choose the handover type: ASO, Shop Details Only or Shop + Measurement'];
  if (o.handoverType === 'ASO') {
    const g: string[] = [];
    if (!contactCount) g.push('Add at least one contact person');
    if (o.shopList) g.push('Remove the shop list: an ASO handover goes without one');
    return g;
  }
  if (!o.shopList) return ['Upload the shop list (Excel)'];
  if (!o.declaredShopTotal) return ['Enter the Total Shops'];
  if (o.declaredShopTotal !== o.shopList.total) return [`Total Shops (${o.declaredShopTotal}) does not match the shops in the Excel (${o.shopList.total})`];
  if (!o.shopsVerifiedAt) return ['Verify the shop list'];
  return [];
}

/** Handover tab: type, who it went to, the documents, the shop list summary and what is still missing (rows come from listShops). */
export async function getHandover(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select(
      'orderNo client csAssignee handover handoverFull handoverNotes handoverType declaredShopTotal shopsVerifiedAt shopsVerifiedBy shopList handoverDocumentsArray handoverVoiceNotesArray handoverShopsArray.attachments.fileId',
    )
    .populate('csAssignee', 'name email phone')
    .populate('handover.assignedBy', 'name role')
    .populate('shopsVerifiedBy', 'name')
    .populate('handoverDocumentsArray.uploadedBy', 'name role')
    .populate('handoverVoiceNotesArray.uploadedBy', 'name role')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  const client = await Client.findById(o.client).select('contacts').lean();
  const newest = (a: { createdAt?: Date | null }, b: { createdAt?: Date | null }) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  const documents = [...(o.handoverDocumentsArray ?? [])].sort(newest);
  const shops = o.handoverShopsArray ?? [];
  return {
    orderId: String(o._id),
    orderNo: o.orderNo,
    assignee: o.csAssignee ?? null,
    handover: o.handover ?? null,
    /** Toggle: full handover (true) or client details and contacts only (false). */
    full: isFull(o),
    notes: o.handoverNotes ?? '',
    voiceNotes: [...(o.handoverVoiceNotesArray ?? [])].sort(newest),
    type: (o.handoverType ?? null) as HandoverType | null,
    shopList: o.shopList ?? null,
    declaredShopTotal: o.declaredShopTotal ?? null,
    verified: o.shopsVerifiedAt ? { at: o.shopsVerifiedAt, by: (o.shopsVerifiedBy as unknown as { name?: string } | null)?.name ?? null } : null,
    shopsWithFiles: shops.filter((s) => s.attachments?.length).length,
    shopFiles: shops.reduce((n, s) => n + (s.attachments?.length ?? 0), 0),
    documents,
    missing: o.csAssignee ? [] : handoverGaps(o, client?.contacts?.length ?? 0),
  };
}

/** Changes are only made while nobody has handed the order over; a parallel handover makes them no-ops (409). */
const stillOpen = (o: { _id: Types.ObjectId }) => ({ _id: o._id, csAssignee: null, 'recce.assignee': null });

/** Assign to Client Servicing toggle. Switching it off keeps what was entered (type, list, notes); it is just not required. */
export async function setHandoverScope(id: string, full: boolean, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const r = await SalesOrder.updateOne(stillOpen(o), { $set: { handoverFull: full, updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  return getHandover(id);
}

/** Additional notes for Client Servicing (before handover). */
export async function setHandoverNotes(id: string, notes: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const r = await SalesOrder.updateOne(stillOpen(o), { $set: { handoverNotes: notes || null, updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  return getHandover(id);
}

const MAX_VOICE_NOTES = 20;

/** A voice note (recorded in the browser or uploaded). Like documents, it can still be added after handover. */
export async function addVoiceNote(id: string, file: UploadedFile | undefined, durationSec: number | undefined, actor: Actor) {
  if (!file) throw new AppError(422, 'VALIDATION_ERROR', 'Record or choose a voice note', [{ path: 'file', message: 'Record or choose a voice note' }]);
  const o = await liveOrder(id);
  const count = await SalesOrder.findById(o._id).select('handoverVoiceNotesArray._id').lean();
  if ((count?.handoverVoiceNotesArray?.length ?? 0) >= MAX_VOICE_NOTES) throw AppError.conflict(`Up to ${MAX_VOICE_NOTES} voice notes per order`);
  const client = await Client.findById(o.client).select('name').lean();
  const stored = await storeEmbeddedFile({ category: 'SALES_HANDOVER_VOICE_NOTE', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file, actor, owner: ownerOf(o._id) });
  try {
    await SalesOrder.updateOne(
      { _id: o._id },
      { $push: { handoverVoiceNotesArray: { file: stored, durationSec, uploadedBy: actor.id, role: actor.role, createdAt: new Date() } }, $set: { updatedBy: actor.id } },
    );
  } catch (e) {
    await discardStoredFiles([stored]);
    throw e;
  }
  if (o.csAssignee) {
    await notify({
      recipients: [o.csAssignee],
      kind: 'ORDER_ASSIGNED',
      title: 'Voice note added to a handed-over order',
      body: `A voice note was added to ${o.orderNo}.`,
      order: { _id: o._id, orderNo: o.orderNo },
      actorId: actor.id,
      dedupe: (r) => `order-voice:${o._id}:${stored.fileId}:${r}`,
    });
  }
  return getHandover(id);
}

/** Deletes a voice note (before handover only); the audio is erased from storage. */
export async function removeVoiceNote(id: string, noteId: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const doc = await SalesOrder.findOne({ _id: o._id, 'handoverVoiceNotesArray._id': noteId }, { 'handoverVoiceNotesArray.$': 1 }).lean();
  const v = doc?.handoverVoiceNotesArray?.[0];
  if (!v) throw AppError.notFound('Voice note not found');
  const r = await SalesOrder.updateOne({ _id: o._id, csAssignee: null }, { $pull: { handoverVoiceNotesArray: { _id: v._id } }, $set: { updatedBy: actor.id } });
  if (!r.modifiedCount) assertNotHandedOver({ csAssignee: true });
  await eraseStoredFile(v.file as StoredFile, actor, ownerOf(o._id));
  return getHandover(id);
}

export async function setHandoverType(id: string, type: HandoverType, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  if (o.handoverType === type) return getHandover(id);
  // A list uploaded before handover types existed (type still empty) may get its first type; it must be verified again.
  if (o.shopList && o.handoverType) throw AppError.conflict('Remove the shop list before changing the handover type (the list is checked by the type).');
  const r = await SalesOrder.updateOne(stillOpen(o), { $set: { handoverType: type, shopsVerifiedAt: null, shopsVerifiedBy: null, updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  return getHandover(id);
}

/** Total Shops typed by the BD (checked against the uploaded list). Clears an earlier verification. */
export async function setShopTotal(id: string, total: number, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const r = await SalesOrder.updateOne(stillOpen(o), { $set: { declaredShopTotal: total, shopsVerifiedAt: null, shopsVerifiedBy: null, updatedBy: actor.id } });
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  return getHandover(id);
}

/** Verify: the Excel has exactly the Total Shops the BD entered. */
export async function verifyShops(id: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  if (!o.handoverType || !shopTypes.includes(o.handoverType)) throw AppError.conflict('Only shop handovers have a shop list to verify');
  if (!o.shopList) throw AppError.conflict('Upload the shop list first');
  if (!o.declaredShopTotal) throw new AppError(422, 'VALIDATION_ERROR', 'Enter the Total Shops first', [{ path: 'total', message: 'Enter the Total Shops first' }]);
  if (o.declaredShopTotal !== o.shopList.total)
    throw AppError.conflict(`Total Shops (${o.declaredShopTotal}) does not match the shops in the Excel (${o.shopList.total}). Correct the count or the file.`);
  // Conditional on the same list and count, so a replaced file in between is not marked verified.
  const r = await SalesOrder.updateOne(
    { ...stillOpen(o), 'shopList.fileId': o.shopList.fileId, declaredShopTotal: o.declaredShopTotal },
    { $set: { shopsVerifiedAt: new Date(), shopsVerifiedBy: actor.id, updatedBy: actor.id } },
  );
  if (!r.matchedCount) throw AppError.conflict('The shop list changed meanwhile. Reload and verify again.');
  await recordAudit({ actor, action: 'UPDATE', entity: 'SalesOrder', entityId: o._id, reason: `Shop list verified: ${o.shopList.total} shops` });
  return getHandover(id);
}

/** Files attached to shop rows (erased when the list is replaced or removed). */
async function rowFiles(orderId: Types.ObjectId) {
  const doc = await SalesOrder.findById(orderId).select('handoverShopsArray.attachments').lean();
  return (doc?.handoverShopsArray ?? []).flatMap((s) => (s.attachments ?? []) as StoredFile[]);
}

/** Shop + Measurement: photos / documents for one shop row. Allowed before and after handover. */
export async function addShopFiles(id: string, rowNumber: number, files: UploadedFile[], actor: Actor) {
  if (!files.length) throw new AppError(422, 'VALIDATION_ERROR', 'Choose at least one file', [{ path: 'files', message: 'Choose at least one file' }]);
  const o = await liveOrder(id);
  if (o.handoverType !== 'SHOP_MEASUREMENT') throw AppError.conflict('Shop photos and documents are for Shop + Measurement handovers');
  if (!(await SalesOrder.exists({ _id: o._id, 'handoverShopsArray.rowNumber': rowNumber }))) throw AppError.notFound(`Shop row ${rowNumber} not found`);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeHandoverFile(o, f, actor));
    await SalesOrder.updateOne(
      { _id: o._id },
      { $push: { 'handoverShopsArray.$[r].attachments': { $each: stored } }, $set: { updatedBy: actor.id } },
      { arrayFilters: [{ 'r.rowNumber': rowNumber }] },
    );
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  return { rowNumber, added: stored.length };
}

export async function removeShopFile(id: string, rowNumber: number, fileId: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const doc = await SalesOrder.findOne({ _id: o._id, 'handoverShopsArray.rowNumber': rowNumber }, { 'handoverShopsArray.$': 1 }).lean();
  const file = (doc?.handoverShopsArray?.[0]?.attachments ?? []).find((a) => String(a.fileId) === fileId) as StoredFile | undefined;
  if (!file) throw AppError.notFound('File not found');
  const r = await SalesOrder.updateOne(
    stillOpen(o),
    { $pull: { 'handoverShopsArray.$[r].attachments': { fileId: file.fileId } } },
    { arrayFilters: [{ 'r.rowNumber': rowNumber }] },
  );
  if (!r.modifiedCount) assertNotHandedOver({ csAssignee: true });
  await eraseStoredFile(file, actor, ownerOf(o._id));
  return { rowNumber, removed: true };
}

/** Shop rows of the current shop list, filtered by state and paged (the list can be thousands of rows). */
export async function listShops(id: string, q: { page: number; limit: number; state?: 'VALID' | 'WARNING' | 'ERROR' | undefined }) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('handoverShopsArray').lean();
  if (!o) throw AppError.notFound('Order not found');
  const rows = (o.handoverShopsArray ?? []).filter((r) => !q.state || r.state === q.state);
  const items = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
  return { items, meta: { page: q.page, limit: q.limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / q.limit)) } };
}

/** Blank shop list in the same columns the project site import understands. */
export const shopTemplate = () => buildTemplate('CLIENT_PROVIDED');

async function storeHandoverFile(o: { _id: Types.ObjectId; orderNo: string; client: unknown }, file: UploadedFile, actor: Actor) {
  const client = await Client.findById(o.client).select('name').lean();
  return storeEmbeddedFile({ category: 'SALES_HANDOVER_DOCUMENT', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file, actor, owner: ownerOf(o._id) });
}

/**
 * Shop list (optional): parses the Excel / CSV with the project site import rules (header auto-mapping, phone / GST /
 * size checks, duplicate rows). Replaces the previous shop list. Rows with errors are kept and flagged for Client Servicing.
 */
export async function uploadShopList(id: string, file: UploadedFile | undefined, actor: Actor) {
  if (!file) throw new AppError(422, 'VALIDATION_ERROR', 'Choose the shop list file', [{ path: 'file', message: 'Choose the shop list file' }]);
  if (!/\.(xlsx|csv)$/i.test(file.originalname)) throw AppError.badRequest('Upload the shop list as an .xlsx or .csv file');
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  if (!o.handoverType || !shopTypes.includes(o.handoverType)) throw AppError.conflict('Choose Shop Details Only or Shop + Measurement before uploading a shop list');
  const scenario = scenarioOf(o.handoverType);

  const parsed = await parseWorkbook(file.buffer, file.originalname);
  const mapping = autoMap(parsed.headers);
  // Shop Details Only: sizes are optional (measured later). Shop + Measurement: the client's sizes are required.
  const problems = validateMapping(mapping, scenario);
  if (problems.length) throw new AppError(422, 'VALIDATION_ERROR', `${problems.join('. ')}. Use the shop list template columns.`, problems.map((message) => ({ path: 'file', message })));

  const seen = new Map<string, number>();
  const summary = { total: 0, valid: 0, warning: 0, error: 0, duplicates: 0 };
  const shops = parsed.rows.map((row) => {
    const values: Partial<Record<MappableField, string>> = {};
    const extra: Record<string, string> = {};
    for (const [header, target] of Object.entries(mapping) as [string, MapTarget][]) {
      const v = row.raw[header] ?? '';
      if (target === 'ignore') continue;
      if (target === 'extra') {
        if (v) extra[header] = v;
      } else values[target] = v;
    }
    const n = normalise(values, { scenario, defaultUnit: 'ft' });
    const issues = [...n.errors, ...n.warnings].map((i) => i.message);
    const key = dupKeyOf(n.value);
    if (key && seen.has(key)) {
      issues.push(`Duplicate of row ${seen.get(key)} in this file`);
      summary.duplicates++;
    } else if (key) seen.set(key, row.rowNumber);
    const state = n.errors.length ? 'ERROR' : issues.length ? 'WARNING' : 'VALID';
    summary.total++;
    summary[state === 'ERROR' ? 'error' : state === 'WARNING' ? 'warning' : 'valid']++;
    return { rowNumber: row.rowNumber, ...n.value, extra: Object.keys(extra).length ? extra : undefined, state, issues };
  });

  const stored = await storeHandoverFile(o, file, actor);
  const previous = await SalesOrder.findById(o._id).select('handoverDocumentsArray').lean();
  const oldLists = (previous?.handoverDocumentsArray ?? []).filter((d) => d.kind === 'SHOP_LIST');
  const oldRowFiles = await rowFiles(o._id);
  const r = await SalesOrder.updateOne(
    { _id: o._id, csAssignee: null },
    {
      $set: {
        handoverShopsArray: shops,
        shopList: { fileId: stored.fileId, fileName: file.originalname.slice(0, 200), ...summary, uploadedBy: actor.id, uploadedAt: new Date() },
        // A new file has to be verified again.
        shopsVerifiedAt: null,
        shopsVerifiedBy: null,
        updatedBy: actor.id,
      },
      $pull: { handoverDocumentsArray: { kind: 'SHOP_LIST' } },
    },
  ).catch(async (e: unknown) => {
    await discardStoredFiles([stored]);
    throw e;
  });
  if (!r.modifiedCount) {
    await discardStoredFiles([stored]);
    throw AppError.conflict('This order was handed over to Client Servicing meanwhile. Reload the page.');
  }
  await SalesOrder.updateOne({ _id: o._id }, { $push: { handoverDocumentsArray: { kind: 'SHOP_LIST', file: stored, uploadedBy: actor.id, role: actor.role, createdAt: new Date() } } });
  for (const d of oldLists) await eraseStoredFile(d.file as StoredFile, actor, ownerOf(o._id));
  for (const f of oldRowFiles) await eraseStoredFile(f, actor, ownerOf(o._id));
  await recordAudit({ actor, action: 'UPLOAD', entity: 'SalesOrder', entityId: o._id, reason: `Shop list ${file.originalname}: ${summary.total} rows (${summary.error} with errors, ${summary.duplicates} duplicates)` });
  return getHandover(id);
}

/** Removes the shop list (before handover only). */
export async function removeShopList(id: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const doc = await SalesOrder.findById(o._id).select('handoverDocumentsArray').lean();
  const lists = (doc?.handoverDocumentsArray ?? []).filter((d) => d.kind === 'SHOP_LIST');
  const oldRowFiles = await rowFiles(o._id);
  const r = await SalesOrder.updateOne(
    { _id: o._id, csAssignee: null },
    {
      $set: { handoverShopsArray: [], shopList: null, shopsVerifiedAt: null, shopsVerifiedBy: null, updatedBy: actor.id },
      $pull: { handoverDocumentsArray: { kind: 'SHOP_LIST' } },
    },
  );
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  for (const d of lists) await eraseStoredFile(d.file as StoredFile, actor, ownerOf(o._id));
  for (const f of oldRowFiles) await eraseStoredFile(f, actor, ownerOf(o._id));
  return getHandover(id);
}

/** Client documents for Client Servicing. Allowed before and after handover (add only once handed over). */
export async function addDocuments(id: string, files: UploadedFile[], actor: Actor) {
  if (!files.length) throw new AppError(422, 'VALIDATION_ERROR', 'Choose at least one file', [{ path: 'files', message: 'Choose at least one file' }]);
  const o = await liveOrder(id);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeHandoverFile(o, f, actor));
    const afterHandover = !!o.csAssignee;
    await SalesOrder.updateOne(
      { _id: o._id },
      {
        $push: { handoverDocumentsArray: { $each: stored.map((file) => ({ kind: 'DOCUMENT', file, afterHandover, uploadedBy: actor.id, role: actor.role, createdAt: new Date() })) } },
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
      title: 'Documents added to a handed-over order',
      body: `${files.length} document${files.length === 1 ? '' : 's'} added to ${o.orderNo}.`,
      order: { _id: o._id, orderNo: o.orderNo },
      actorId: actor.id,
      dedupe: (r) => `order-docs:${o._id}:${stored.map((s) => s.fileId).join(',')}:${r}`,
    });
  }
  return getHandover(id);
}

/** Deletes a client document (before handover only); the file is erased from storage. */
export async function removeDocument(id: string, docId: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const doc = await SalesOrder.findOne({ _id: o._id, 'handoverDocumentsArray._id': docId }, { 'handoverDocumentsArray.$': 1 }).lean();
  const d = doc?.handoverDocumentsArray?.[0];
  if (!d || d.kind !== 'DOCUMENT') throw AppError.notFound('Document not found');
  const r = await SalesOrder.updateOne({ _id: o._id, csAssignee: null }, { $pull: { handoverDocumentsArray: { _id: d._id } }, $set: { updatedBy: actor.id } });
  if (!r.modifiedCount) assertNotHandedOver({ csAssignee: true });
  await eraseStoredFile(d.file as StoredFile, actor, ownerOf(o._id));
  return getHandover(id);
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
  const client = await Client.findById(o.client).select('name contacts').lean();
  const gaps = handoverGaps(o, client?.contacts?.length ?? 0);
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', gaps[0]!, gaps.map((message) => ({ path: 'handover', message })));
  const cs = await User.findOne({ _id: input.csUserId, role: 'CLIENT_SERVICING', isActive: true, deletedAt: null }).select('name').lean();
  if (!cs) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active Client Servicing person', [{ path: 'csUserId', message: 'Choose an active Client Servicing person' }]);
  const full = isFull(o);
  const typeLabel = full ? HANDOVER_TYPE_LABELS[o.handoverType as HandoverType] : 'Client details only';
  const note = `Handed over to ${cs.name} (Client Servicing) · ${typeLabel}`;
  const now = new Date();
  // Assigning is the Project Assign step: the lead is completed in the same write.
  const lead = o.lead?.status === 'OPEN' && o.lead.stage === 'PROJECT_ASSIGN';
  // Conditional on the checked state: a list replaced, a type or the toggle changed meanwhile is not handed over unverified.
  const r = await SalesOrder.updateOne(
    {
      _id: o._id,
      csAssignee: null,
      'recce.assignee': null,
      ...(full
        ? { handoverFull: { $ne: false }, handoverType: o.handoverType, ...(o.handoverType === 'ASO' ? {} : { 'shopList.fileId': o.shopList?.fileId, shopsVerifiedAt: { $ne: null } }) }
        : { handoverFull: false }),
      ...(lead ? { 'lead.status': 'OPEN', 'lead.stage': 'PROJECT_ASSIGN' } : {}),
    },
    {
      $set: {
        csAssignee: cs._id,
        handover: { assignedBy: actor.id, assignedAt: now, note: input.note },
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
