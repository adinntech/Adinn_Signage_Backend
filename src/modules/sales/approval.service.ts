import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import { latestRevision } from '../ratecards/quotation.service';
import { revisionLabel } from '../ratecards/ratecard.model';
import { SalesOrder } from './sales.model';
import { getOrder, liveOrder, orderArray, pipelineLog } from './order.service';
import type { approvalPatchBody, approvalUploadBody } from './sales.validators';

/** What is still missing before approval can be marked complete (empty = ready). */
export function approvalGaps(clientType: string, activeTypes: string[]): string[] {
  if (clientType === 'NEW') return activeTypes.includes('PURCHASE_ORDER') ? [] : ['A Purchase Order is mandatory for a new client'];
  return activeTypes.length ? [] : ['Upload at least one written approval (PO, email, WhatsApp or other written approval)'];
}

async function editableOrder(orderId: string) {
  const o = await liveOrder(orderId);
  if (o.stage !== 'CLIENT_APPROVAL') throw AppError.conflict('Move the order to Client Approval Proof before uploading approval documents');
  if (o.approvalStatus === 'COMPLETED') throw AppError.conflict('Client approval is already complete');
  return o;
}

/** approvalDocumentsArray with uploader names, newest first. */
async function approvalDocs(orderId: string) {
  const o = await orderArray(orderId, 'approvalDocumentsArray', ['uploadedBy', 'updatedBy']);
  return [...(o.approvalDocumentsArray ?? [])].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || (String(b._id) > String(a._id) ? 1 : -1));
}

export async function approvalOverview(orderId: string) {
  const order = await getOrder(orderId);
  const docs = await approvalDocs(orderId);
  const latest = await latestRevision(orderId);
  const active = docs.filter((d) => !d.supersededAt);
  return {
    order,
    latestRevision: latest ? { revision: latest.revision, label: revisionLabel(latest.revision), pdf: latest.pdf, createdAt: latest.createdAt } : null,
    documents: active,
    history: docs,
    missing: approvalGaps(order.clientType, active.map((d) => d.docType)),
  };
}

const docById = async (orderId: string, docId: string) => (await approvalDocs(orderId)).find((d) => String(d._id) === docId) ?? null;

/** Upload (or replace) one approval document. A replaced document is kept as superseded history with its file. */
export async function uploadApprovalDoc(orderId: string, input: z.infer<typeof approvalUploadBody>, file: UploadedFile | undefined, actor: Actor) {
  const o = await editableOrder(orderId);
  if (!file) throw new AppError(422, 'VALIDATION_ERROR', 'Choose a document to upload', [{ path: 'file', message: 'Choose a document to upload' }]);
  const old = input.replacesId ? await docById(orderId, input.replacesId) : null;
  if (input.replacesId && (!old || old.supersededAt)) throw AppError.notFound('The document to replace was not found');
  const client = await Client.findById(o.client).select('name').lean();
  const stored = await storeEmbeddedFile({ category: 'SALES_APPROVAL_PROOF', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file, actor, owner: { entity: 'SalesOrder', id: o._id } });
  const docId = new Types.ObjectId();
  const now = new Date();
  try {
    await SalesOrder.updateOne(
      { _id: o._id },
      {
        $push: {
          approvalDocumentsArray: {
            _id: docId,
            docType: input.docType,
            file: stored,
            approvalDate: input.approvalDate,
            remarks: input.remarks,
            replaces: old?._id,
            uploadedBy: actor.id,
            createdAt: now,
          },
        },
        $set: { updatedBy: actor.id },
      },
    );
  } catch (e) {
    await discardStoredFiles([stored]);
    throw e;
  }
  if (old) {
    await SalesOrder.updateOne(
      { _id: o._id },
      { $set: { 'approvalDocumentsArray.$[d].supersededAt': now, 'approvalDocumentsArray.$[d].supersededBy': docId } },
      { arrayFilters: [{ 'd._id': old._id }] },
    );
  }
  await recordAudit({ actor, action: old ? 'APPROVAL_DOC_REPLACED' : 'APPROVAL_DOC_UPLOADED', entity: 'SalesOrder', entityId: o._id, reason: `${input.docType} ${stored.name}` });
  return docById(orderId, String(docId));
}

/** Save Details: approval date / remarks of a current document. */
export async function updateApprovalDoc(docId: string, patch: z.infer<typeof approvalPatchBody>, actor: Actor) {
  const owner = await SalesOrder.findOne({ 'approvalDocumentsArray._id': docId, deletedAt: null }).select('_id').lean();
  if (!owner) throw AppError.notFound('Document not found');
  const orderId = String(owner._id);
  const current = await docById(orderId, docId);
  if (!current || current.supersededAt) throw AppError.notFound('Document not found');
  await editableOrder(orderId);
  const set: Record<string, unknown> = { 'approvalDocumentsArray.$[d].updatedBy': actor.id, 'approvalDocumentsArray.$[d].updatedAt': new Date() };
  const unset: Record<string, ''> = {};
  for (const k of ['approvalDate', 'remarks'] as const) {
    if (patch[k] === undefined) continue;
    if (patch[k] === null) unset[`approvalDocumentsArray.$[d].${k}`] = '';
    else set[`approvalDocumentsArray.$[d].${k}`] = patch[k];
  }
  await SalesOrder.updateOne({ _id: owner._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { arrayFilters: [{ 'd._id': new Types.ObjectId(docId) }] });
  return docById(orderId, docId);
}

/**
 * Deletes an approval document (e.g. uploaded by mistake) and erases its file from storage. Allowed only until
 * approval is complete; after that the proof is locked. Deleting a replacement brings back the document it replaced.
 */
export async function deleteApprovalDoc(docId: string, actor: Actor) {
  const owner = await SalesOrder.findOne({ 'approvalDocumentsArray._id': docId, deletedAt: null }).select('_id').lean();
  if (!owner) throw AppError.notFound('Document not found');
  const orderId = String(owner._id);
  await editableOrder(orderId);
  const doc = await docById(orderId, docId);
  if (!doc) throw AppError.notFound('Document not found');
  const r = await SalesOrder.updateOne(
    { _id: owner._id, approvalStatus: { $ne: 'COMPLETED' } },
    { $pull: { approvalDocumentsArray: { _id: doc._id } }, $set: { updatedBy: actor.id } },
  );
  if (!r.modifiedCount) throw AppError.conflict('Client approval is already complete');
  if (doc.replaces && !doc.supersededAt) {
    await SalesOrder.updateOne(
      { _id: owner._id },
      { $unset: { 'approvalDocumentsArray.$[d].supersededAt': '', 'approvalDocumentsArray.$[d].supersededBy': '' } },
      { arrayFilters: [{ 'd._id': doc.replaces, 'd.supersededBy': doc._id }] },
    );
  }
  await eraseStoredFile(doc.file, actor, { entity: 'SalesOrder', id: owner._id });
  await recordAudit({ actor, action: 'APPROVAL_DOC_DELETED', entity: 'SalesOrder', entityId: owner._id, reason: `${doc.docType} ${doc.file?.name ?? ''}`.trim() });
  return approvalOverview(orderId);
}

/** Mark Client Approval Complete: only once the required proof is present. */
export async function completeApproval(orderId: string, actor: Actor) {
  const o = await editableOrder(orderId);
  const active = (await approvalDocs(orderId)).filter((d) => !d.supersededAt);
  const missing = approvalGaps(o.clientType, active.map((d) => d.docType));
  if (missing.length) throw new AppError(422, 'APPROVAL_INCOMPLETE', missing[0]!, missing.map((m) => ({ path: 'documents', message: m })));
  await SalesOrder.updateOne(
    { _id: o._id, approvalStatus: { $ne: 'COMPLETED' } },
    {
      $set: { approvalStatus: 'COMPLETED', approvalCompletedAt: new Date(), approvalCompletedBy: actor.id, updatedBy: actor.id },
      $push: { salespipelineLogs: pipelineLog(actor, 'APPROVAL_COMPLETE', o.stage, o.stage, 'Client approval marked complete') },
    },
  );
  await recordAudit({ actor, action: 'APPROVAL_COMPLETE', entity: 'SalesOrder', entityId: o._id, reason: 'Client approval marked complete' });
  return approvalOverview(orderId);
}
