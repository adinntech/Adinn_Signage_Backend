import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { importZohoClient, previewZohoIdentity } from '../clients/client.service';
import { Client } from '../clients/client.model';
import { Vendor } from '../vendors/vendor.model';
import { zohoGet } from './zoho.client';
import { customerNoOf, toClientFields, toVendorFields, type ZohoContact } from './zoho.mapper';

export interface ZohoPayment {
  payment_id: string;
  payment_number?: string;
  date?: string;
  amount?: number;
  payment_mode?: string;
  reference_number?: string;
  invoice_numbers?: string;
}

/** Zoho's task payload is not documented publicly; these are the field names seen so far, all optional. */
interface ZohoTask {
  task_id?: string | number;
  id?: string | number;
  title?: string;
  subject?: string;
  task_name?: string;
  status?: string;
  due_date?: string;
  assigned_to_name?: string;
  owner_name?: string;
}

/** One page of active Zoho customers (optionally filtered by name); each row says whether it is already in the client master. */
export async function searchZohoClients(q: { q?: string | undefined; page: number; perPage: number }) {
  const r = await zohoGet<{ contacts: ZohoContact[]; page_context?: { has_more_page?: boolean } }>('/contacts', {
    // search_text keeps working together with filter_by; contact_name_contains is ignored by Zoho when filter_by is present.
    search_text: q.q,
    contact_type: 'customer',
    filter_by: 'Status.Active',
    page: q.page,
    per_page: q.perPage,
    sort_column: 'contact_name',
    sort_order: 'A',
  });
  const ids = r.contacts.map((c) => c.contact_id);
  const imported = await Client.find({ zohoContactId: { $in: ids }, deletedAt: null }).select('zohoContactId clientNo').lean();
  const byZoho = new Map(imported.map((c) => [c.zohoContactId, c.clientNo]));
  const items = r.contacts.map((c) => ({
    contactId: c.contact_id,
    name: c.company_name || c.contact_name || '',
    email: c.email,
    phone: c.mobile || c.phone,
    gstin: c.gst_no,
    imported: byZoho.has(c.contact_id),
    clientNo: byZoho.get(c.contact_id),
  }));
  return { items, meta: { page: q.page, perPage: q.perPage, hasMore: !!r.page_context?.has_more_page } };
}

/** Everything that would be stored for this Zoho customer, plus its latest payments (display only, not stored). */
export async function previewZohoClient(contactId: string) {
  const [detail, pay, tasks] = await Promise.all([
    zohoGet<{ contact: ZohoContact }>(`/contacts/${encodeURIComponent(contactId)}`),
    zohoGet<{ customerpayments?: ZohoPayment[] }>('/customerpayments', { customer_id: contactId, page: 1, per_page: 20, sort_column: 'date', sort_order: 'D' }),
    // Tasks are a newer Zoho module; if the token lacks its scope or the API is not open, the rest of the preview still loads.
    zohoGet<{ tasks?: ZohoTask[] }>('/tasks', { contact_id: contactId, per_page: 20 }, 'v4').then(
      (r) => ({ available: true, items: r.tasks ?? [] }),
      () => ({ available: false, items: [] as ZohoTask[] }),
    ),
  ]);
  const client = toClientFields(detail.contact);
  const existing = await Client.findOne({ zohoContactId: contactId, deletedAt: null }).select('clientNo').lean();
  return {
    contactId,
    /** Zoho's own customer number, the digits before " - " in the contact name (e.g. 30196). */
    zohoCustomerNo: customerNoOf(detail.contact.contact_name),
    identity: await previewZohoIdentity(contactId, client.name, client.gstin, customerNoOf(detail.contact.contact_name)),
    client,
    payments: (pay.customerpayments ?? []).map((p) => ({ id: p.payment_id, number: p.payment_number, date: p.date, amount: p.amount, mode: p.payment_mode, reference: p.reference_number, invoices: p.invoice_numbers })),
    tasks: {
      available: tasks.available,
      items: tasks.items.map((t) => ({ id: String(t.task_id ?? t.id ?? ''), title: t.title ?? t.subject ?? t.task_name, status: t.status, dueDate: t.due_date, assignee: t.assigned_to_name ?? t.owner_name })),
    },
    imported: !!existing,
    clientNo: existing?.clientNo,
  };
}

/**
 * Vendor lookup by Zoho vendor number (the digits before " - " in the contact name, e.g. 12543). Returns the details
 * for the registration form and, if that vendor is already in the vendor master, who it is. Nothing is saved here.
 */
export async function lookupZohoVendor(vendorNo: string) {
  // contact_name_contains, not search_text: with contact_type=vendor Zoho ignores search_text and returns every vendor.
  const list = await zohoGet<{ contacts?: ZohoContact[] }>('/contacts', { contact_name_contains: vendorNo, contact_type: 'vendor', per_page: 25 });
  const hit = (list.contacts ?? []).find((c) => customerNoOf(c.contact_name) === vendorNo);
  if (!hit) throw AppError.notFound(`No Zoho vendor with number ${vendorNo}`);
  return zohoVendorDetails(hit.contact_id);
}

/** Registration-form fields of one Zoho vendor (full detail call: address and contact persons), plus who already holds it. */
export async function zohoVendorDetails(contactId: string) {
  const detail = await zohoGet<{ contact: ZohoContact }>(`/contacts/${encodeURIComponent(contactId)}`);
  const existing = await Vendor.findOne({ zohoContactId: contactId, deletedAt: null }).select('code name status').lean();
  return {
    contactId,
    vendorNo: customerNoOf(detail.contact.contact_name),
    vendor: toVendorFields(detail.contact),
    existing: existing ? { id: String(existing._id), code: existing.code, name: existing.name, status: existing.status } : null,
  };
}

/** Re-reads the contact from Zoho (the browser never supplies the data) and stores it in the clients collection. */
export async function importZohoContact(contactId: string, actor: Actor) {
  const detail = await zohoGet<{ contact: ZohoContact }>(`/contacts/${encodeURIComponent(contactId)}`);
  return importZohoClient(contactId, toClientFields(detail.contact), actor, customerNoOf(detail.contact.contact_name));
}
