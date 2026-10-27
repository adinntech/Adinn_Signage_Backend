import { AppError } from '../../common/errors';
import { Client } from '../clients/client.model';
import { getHandover, listShops } from '../sales/handover.service';
import { orderFileUrl } from '../sales/order.service';
import { SalesOrder } from '../sales/sales.model';
import { Project } from './project.model';

/**
 * BD handover of a project created from Lead Management > Assign to Recce Team: the sales order's codes, client,
 * handover type, notes, voice notes, documents and shop list, read-only for the assigned Recce / Operations person.
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
  const o = await SalesOrder.findOne({ _id: orderId, deletedAt: null }).select('orderNo client recce').populate('recce.assignedBy', 'name').lean();
  if (!o) return null;
  const [h, client] = await Promise.all([getHandover(orderId), Client.findById(o.client).select('name clientName clientNo email phone gstin contacts').lean()]);
  return {
    orderNo: o.orderNo,
    projectCode: o.recce?.projectCode ?? null,
    estimationCode: o.recce?.estimationCode ?? null,
    assignedAt: o.recce?.assignedAt ?? null,
    assignedBy: (o.recce?.assignedBy as unknown as { name?: string } | null)?.name ?? null,
    note: o.recce?.note ?? null,
    client,
    type: h.type,
    notes: h.notes,
    voiceNotes: h.voiceNotes,
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

export async function projectHandoverFileUrl(projectId: string, fileId: string) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('File not found');
  return orderFileUrl(orderId, fileId);
}
