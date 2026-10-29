import { AppError } from '../../common/errors';
import { Client } from '../clients/client.model';
import { exportShops, getHandover, listShops } from '../sales/handover.service';
import { orderFileUrl } from '../sales/order.service';
import { SalesOrder } from '../sales/sales.model';
import { Project } from './project.model';

/**
 * BD handover of a project created from Lead Management > Assign to Recce Team: the sales order's codes, client,
 * handover type, communication (messages, files, voice notes) and shop list, read-only for the assigned Recce / Operations person.
 * The route is project-scoped, so only people who may open the project reach it.
 */
async function sourceOrderId(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('salesOrder').lean();
  if (!p) throw AppError.notFound('Project not found');
  return p.salesOrder ? String(p.salesOrder) : null;
}

export async function projectHandover(projectId: string) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) return null;
  const o = await SalesOrder.findOne({ _id: orderId, deletedAt: null }).select('orderNo client clientType recce handoverClient').populate('recce.assignedBy', 'name').lean();
  if (!o) return null;
  // The client as handed over; projects assigned before the snapshot existed show the client as it is now.
  const [h, live] = await Promise.all([
    getHandover(orderId),
    o.handoverClient ? null : Client.findById(o.client).select('name clientName clientNo email phone gstin gstCertificates customFields contacts').lean(),
  ]);
  const crm = o.clientType !== 'EXISTING';
  const client = o.handoverClient ?? (live && { ...live, gstCertificates: crm ? live.gstCertificates : undefined, customFields: crm ? live.customFields : undefined });
  return {
    orderNo: o.orderNo,
    projectCode: o.recce?.projectCode ?? null,
    estimationCode: o.recce?.estimationCode ?? null,
    /** Client ID in Zoho (typed for a New client at Project Code, from Zoho for an Existing one). */
    clientId: o.recce?.clientId ?? null,
    assignedAt: o.recce?.assignedAt ?? null,
    assignedBy: (o.recce?.assignedBy as unknown as { name?: string } | null)?.name ?? null,
    note: o.recce?.note ?? null,
    client,
    type: h.type,
    /** Communication & attachments (chat) from the BD. */
    messages: h.messages,
    documents: h.documents,
    shopList: h.shopList,
    declaredShopTotal: h.declaredShopTotal,
    shopFiles: h.shopFiles,
  };
}

export async function projectHandoverShops(projectId: string, q: Parameters<typeof listShops>[1]) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('This project has no BD handover');
  return listShops(orderId, q);
}

/** The BD's shop table as it is now, as Excel (same file as the BD's Download Excel). */
export async function projectHandoverShopsExport(projectId: string) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('This project has no BD handover');
  return exportShops(orderId);
}

export async function projectHandoverFileUrl(projectId: string, fileId: string) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('File not found');
  return orderFileUrl(orderId, fileId);
}
