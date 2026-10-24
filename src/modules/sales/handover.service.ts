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
import { liveOrder, pipelineLog } from './order.service';
import { SalesOrder } from './sales.model';

/** Client Servicing only sees orders handed to them; everyone else with sales access sees all. */
export const isCs = (actor: Actor) => actor.role === 'CLIENT_SERVICING';

/** 404 (not 403) for an order that is not this Client Servicing person's, so other orders are not disclosed. */
export async function assertOrderAccess(id: string, actor: Actor) {
  if (!isCs(actor)) return;
  if (!(await SalesOrder.exists({ _id: id, deletedAt: null, csAssignee: actor.id }))) throw AppError.notFound('Order not found');
}

/** Before handover the BD may change everything; afterwards only add documents. */
const assertNotHandedOver = (o: { csAssignee?: unknown }) => {
  if (o.csAssignee) throw AppError.conflict('This order is already handed over to Client Servicing. You can only add documents now.');
};

const ownerOf = (id: Types.ObjectId) => ({ entity: 'SalesOrder' as const, id });

/** Active Client Servicing people the BD can hand an order to. */
export const csUsers = () => User.find({ role: 'CLIENT_SERVICING', isActive: true, deletedAt: null }).select('name email phone').sort({ name: 1 }).lean();

/** Handover tab: who it went to, the documents, and the shop list summary (rows come from listShops). */
export async function getHandover(id: string) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select('orderNo client csAssignee handover shopList handoverDocumentsArray')
    .populate('csAssignee', 'name email phone')
    .populate('handover.assignedBy', 'name role')
    .populate('handoverDocumentsArray.uploadedBy', 'name role')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  const documents = [...(o.handoverDocumentsArray ?? [])].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return { orderId: String(o._id), orderNo: o.orderNo, assignee: o.csAssignee ?? null, handover: o.handover ?? null, shopList: o.shopList ?? null, documents };
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

  const parsed = await parseWorkbook(file.buffer, file.originalname);
  const mapping = autoMap(parsed.headers);
  // Measurements are optional at handover: the requirement type is chosen later, when the project is created.
  const problems = validateMapping(mapping, 'MEASUREMENT_REQUIRED');
  if (problems.length) throw new AppError(422, 'VALIDATION_ERROR', `${problems.join('. ')}. Use the shop list template columns.`, problems.map((message) => ({ path: 'file', message })));

  const seen = new Map<string, number>();
  const summary = { total: 0, valid: 0, warning: 0, error: 0 };
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
    const n = normalise(values, { scenario: 'MEASUREMENT_REQUIRED', defaultUnit: 'ft' });
    const issues = [...n.errors, ...n.warnings].map((i) => i.message);
    const key = dupKeyOf(n.value);
    if (key && seen.has(key)) issues.push(`Duplicate of row ${seen.get(key)} in this file`);
    else if (key) seen.set(key, row.rowNumber);
    const state = n.errors.length ? 'ERROR' : issues.length ? 'WARNING' : 'VALID';
    summary.total++;
    summary[state === 'ERROR' ? 'error' : state === 'WARNING' ? 'warning' : 'valid']++;
    return { rowNumber: row.rowNumber, ...n.value, extra: Object.keys(extra).length ? extra : undefined, state, issues };
  });

  const stored = await storeHandoverFile(o, file, actor);
  const previous = await SalesOrder.findById(o._id).select('handoverDocumentsArray').lean();
  const oldLists = (previous?.handoverDocumentsArray ?? []).filter((d) => d.kind === 'SHOP_LIST');
  const r = await SalesOrder.updateOne(
    { _id: o._id, csAssignee: null },
    {
      $set: {
        handoverShopsArray: shops,
        shopList: { fileId: stored.fileId, fileName: file.originalname.slice(0, 200), ...summary, uploadedBy: actor.id, uploadedAt: new Date() },
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
  await recordAudit({ actor, action: 'UPLOAD', entity: 'SalesOrder', entityId: o._id, reason: `Shop list ${file.originalname}: ${summary.total} rows (${summary.error} with errors)` });
  return getHandover(id);
}

/** Removes the shop list (before handover only). */
export async function removeShopList(id: string, actor: Actor) {
  const o = await liveOrder(id);
  assertNotHandedOver(o);
  const doc = await SalesOrder.findById(o._id).select('handoverDocumentsArray').lean();
  const lists = (doc?.handoverDocumentsArray ?? []).filter((d) => d.kind === 'SHOP_LIST');
  const r = await SalesOrder.updateOne(
    { _id: o._id, csAssignee: null },
    { $set: { handoverShopsArray: [], shopList: null, updatedBy: actor.id }, $pull: { handoverDocumentsArray: { kind: 'SHOP_LIST' } } },
  );
  if (!r.matchedCount) assertNotHandedOver({ csAssignee: true });
  for (const d of lists) await eraseStoredFile(d.file as StoredFile, actor, ownerOf(o._id));
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
  const cs = await User.findOne({ _id: input.csUserId, role: 'CLIENT_SERVICING', isActive: true, deletedAt: null }).select('name').lean();
  if (!cs) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active Client Servicing person', [{ path: 'csUserId', message: 'Choose an active Client Servicing person' }]);
  const client = await Client.findById(o.client).select('name').lean();
  const note = `Handed over to ${cs.name} (Client Servicing)`;
  const r = await SalesOrder.updateOne(
    { _id: o._id, csAssignee: null },
    {
      $set: { csAssignee: cs._id, handover: { assignedBy: actor.id, assignedAt: new Date(), note: input.note }, updatedBy: actor.id },
      $push: { salespipelineLogs: pipelineLog(actor, 'HANDOVER', o.stage, o.stage, note) },
    },
  );
  if (!r.modifiedCount) throw AppError.conflict('This order was handed over meanwhile. Reload the page.');
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'csAssignee', oldValue: null, newValue: String(cs._id) }], reason: note });
  const bd = await User.findById(actor.id).select('name').lean();
  await notify({
    recipients: [cs._id],
    kind: 'ORDER_ASSIGNED',
    title: 'New order assigned to you',
    body: `${bd?.name ?? 'BD'} assigned order ${o.orderNo} (${client?.name ?? 'client'}) to you on ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.`,
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
