import { AppError } from '../../common/errors';
import { Client } from '../clients/client.model';
import { pointOfContact } from '../clients/clientDetails';
import { exportShops, exportShopsPdf, getHandover, listShops } from '../sales/handover.service';
import { readStoredFile } from '../files/file.service';
import { orderFileUrl, orderStoredFile } from '../sales/order.service';
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
  const o = await SalesOrder.findOne({ _id: orderId, deletedAt: null })
    .select('orderNo client clientType recce handoverClient rateCardArray.pdf.fileId salesprofile.kind salesprofile.status salesprofile.sentAt salesprofile.attachments salesprofile.shopListFile')
    .populate('recce.assignedBy', 'name')
    .lean();
  if (!o) return null;
  // The client as handed over; projects assigned before the snapshot existed show the client as it is now.
  const [h, live] = await Promise.all([
    getHandover(orderId),
    o.handoverClient ? null : Client.findById(o.client).select('name clientName clientNo zohoCustomerNo email phone gstin gstCertificates customFields contacts').lean(),
  ]);
  const crm = o.clientType !== 'EXISTING';
  const client = o.handoverClient ?? (live && { ...live, clientType: o.clientType, gstCertificates: crm ? live.gstCertificates : undefined, customFields: crm ? live.customFields : undefined });

  // Every file shared in the Client Servicing / BD workflow, once each (by file id), with where it came from: the
  // uploaded shop Excel, the files of the latest project code request email that went (rate card PDF if included, the
  // shop Excel as sent, added files, GST certificates), the SO Additional Documents and the chat files. Failed sends
  // are left out; nothing is copied (the stored file records are listed as they are).
  type F = { fileId?: unknown; name?: string | null; size?: number | null; mimeType?: string | null };
  const ids = (list: (F | null | undefined)[]) => new Set(list.filter((f) => f?.fileId).map((f) => String(f!.fileId)));
  const rateCards = ids((o.rateCardArray ?? []).map((r) => r.pdf as F | null));
  const soIds = ids((h.soDocuments ?? []) as F[]);
  const chatIds = ids((h.messages ?? []).flatMap((m) => (m.attachments ?? []) as F[]));
  const gstIds = ids(((client as { gstCertificates?: F[] } | null)?.gstCertificates ?? []) as F[]);
  const request = [...(o.salesprofile ?? [])]
    .filter((e) => e.kind === 'PROJECT_CODE_REQUEST' && e.status !== 'FAILED')
    .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0];
  const sentShop = (request as { shopListFile?: string | null } | undefined)?.shopListFile ?? null;
  const sourceOf = (f: F, fallback: string) => {
    const id = String(f.fileId);
    if (rateCards.has(id)) return 'Rate Card';
    if (soIds.has(id)) return 'Additional Document';
    if (chatIds.has(id)) return 'Communication';
    if (gstIds.has(id)) return 'GST Certificate';
    if (id === sentShop || /_shop_list\.xlsx$/i.test(f.name ?? '')) return 'Shop list (sent with the request email)';
    return fallback;
  };
  const files: { fileId: string; name: string | null; size: number | null; mimeType: string | null; source: string }[] = [];
  const add = (list: (F | null | undefined)[], fallback: string) => {
    for (const f of list) {
      if (!f?.fileId || files.some((x) => x.fileId === String(f.fileId))) continue;
      files.push({ fileId: String(f.fileId), name: f.name ?? null, size: f.size ?? null, mimeType: f.mimeType ?? null, source: sourceOf(f, fallback) });
    }
  };
  // One shop Excel only: the one sent with the request email (the shop table as it went); the uploaded file is listed
  // only when no shop Excel went with the email (e.g. no request sent yet).
  const sentShopFile = ((request?.attachments ?? []) as F[]).some((f) => f?.fileId && (String(f.fileId) === sentShop || /_shop_list\.xlsx$/i.test(f.name ?? '')));
  add((request?.attachments ?? []) as F[], 'Project Code Request Email');
  if (!sentShopFile) add((h.documents ?? []).map((d) => d.file as F | null), 'Shop list (uploaded Excel)');
  add((h.soDocuments ?? []) as F[], 'Additional Document');
  add((h.messages ?? []).flatMap((m) => (m.attachments ?? []) as F[]), 'Communication');
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
    /** POC contacts as handed over (or as they are now, for projects from before the snapshot kept them). */
    soContacts: o.handoverClient?.soContacts ?? h.soContacts ?? [],
    /** SO: the Additional Documents (empty for the other types). */
    soDocuments: h.soDocuments,
    /** Communication & attachments (chat) from the BD. */
    messages: h.messages,
    documents: h.documents,
    /** All handover files, once each, with their source section. */
    files,
    /**
     * Operations POC: the primary POC contact (assign type chosen), else the primary client contact, as handed over.
     * Email is optional here (the project's own contacts keep only those with a mobile and an email).
     */
    primaryContact: pointOfContact(client as Parameters<typeof pointOfContact>[0], { handoverType: h.type, soContacts: (o.handoverClient?.soContacts ?? h.soContacts ?? []) as Parameters<typeof pointOfContact>[1]['soContacts'] }),
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

/** The BD's shop table as it is now, as Excel (same file as the BD's Download Excel), or as PDF. */
export async function projectHandoverShopsExport(projectId: string, pdf = false) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('This project has no BD handover');
  return pdf ? exportShopsPdf(orderId) : exportShops(orderId);
}

export async function projectHandoverFileUrl(projectId: string, fileId: string) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('File not found');
  return orderFileUrl(orderId, fileId);
}

/** The bytes of a handover file (same lookup as the read link), for the in-app Excel / CSV preview and Extract shops. */
export async function projectHandoverFileContent(projectId: string, fileId: string) {
  const orderId = await sourceOrderId(projectId);
  if (!orderId) throw AppError.notFound('File not found');
  const file = await orderStoredFile(orderId, fileId);
  // A record without a storage location (legacy / not migrated) has no bytes to show.
  if (!file.key || !file.storage) throw AppError.notFound(`${file.name ?? 'This file'} is not available in storage (legacy record). Ask Client Servicing to upload it again.`);
  return readStoredFile(file);
}
