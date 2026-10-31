import { Schema, Types } from 'mongoose';
import type { ZohoClient } from '../zoho/zoho.customers';
import { Client } from './client.model';

/**
 * Client details kept on the record itself (orders, operations projects) instead of the clients collection: the Zoho
 * customer as it was read when the order was created. An array, so a later read can be added without losing the
 * earlier one; the last entry is the current client.
 */
export interface ClientDetails {
  zohoId: string;
  name: string;
  clientName?: string | null | undefined;
  /** Zoho's customer number: the Client ID. */
  zohoCustomerNo?: string | null | undefined;
  gstin?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
  industry?: string | null | undefined;
  contacts?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean | null }[] | null | undefined;
  savedAt?: Date | null | undefined;
  savedBy?: Types.ObjectId | string | null | undefined;
}

const contactSchema = new Schema({ name: String, designation: String, phone: String, email: String, isPrimary: Boolean }, { _id: false });
export const clientDetailsSchema = new Schema(
  {
    zohoId: { type: String, required: true },
    name: { type: String, required: true },
    clientName: String,
    zohoCustomerNo: String,
    gstin: String,
    email: String,
    phone: String,
    address: String,
    city: String,
    state: String,
    pincode: String,
    industry: String,
    contacts: { type: [contactSchema], default: [] },
    savedAt: { type: Date, default: Date.now },
    savedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

/** One entry from a Zoho customer (read with its contact persons). */
export function clientDetailsFromZoho(z: ZohoClient, actorId: string): ClientDetails {
  const contacts = z.contacts ?? [];
  // One primary: Zoho's, else the first contact.
  const primary = Math.max(0, contacts.findIndex((k) => k.isPrimary));
  return {
    zohoId: z.zohoId,
    name: z.name,
    clientName: z.clientName ?? null,
    zohoCustomerNo: z.zohoCustomerNo ?? null,
    gstin: z.gstin ?? null,
    email: z.email ?? null,
    phone: z.phone ?? null,
    address: z.address ?? null,
    city: z.city ?? null,
    state: z.state ?? null,
    pincode: z.pincode ?? null,
    industry: z.industry ?? null,
    contacts: contacts.map((k, i) => ({ name: k.name, designation: k.designation ?? null, phone: k.phone ?? null, email: k.email ?? null, isPrimary: i === primary })),
    savedAt: new Date(),
    savedBy: new Types.ObjectId(actorId),
  };
}

export const latestClient = (list: ClientDetails[] | null | undefined): ClientDetails | null => list?.at(-1) ?? null;

/** What the screens and services read of a client (a Client record, or the client array's latest entry). */
export interface ClientLike {
  _id: Types.ObjectId | null;
  name: string;
  clientName?: string | null | undefined;
  clientNo?: string | null | undefined;
  code?: string | null | undefined;
  zohoCustomerNo?: string | null | undefined;
  zohoId?: string | null | undefined;
  zohoContactId?: string | null | undefined;
  source?: string | null | undefined;
  clientType?: string | null | undefined;
  status?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  gstin?: string | null | undefined;
  address?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
  industry?: string | null | undefined;
  contacts?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean | null }[] | null | undefined;
  gstCertificates?: unknown[] | null | undefined;
  customFields?: { label?: string | null; value?: string | null }[] | null | undefined;
}

/** The latest entry in the shape of a Client record (no _id: it is not in the clients collection). Zoho clients only. */
export function clientView(d: ClientDetails | null | undefined): ClientLike | null {
  if (!d) return null;
  return {
    _id: null,
    name: d.name,
    clientName: d.clientName ?? null,
    clientNo: null,
    code: d.zohoCustomerNo ?? null,
    zohoCustomerNo: d.zohoCustomerNo ?? null,
    zohoId: d.zohoId,
    source: 'ZOHO',
    clientType: 'EXISTING',
    status: 'ACTIVE',
    email: d.email ?? null,
    phone: d.phone ?? null,
    gstin: d.gstin ?? null,
    address: d.address ?? null,
    city: d.city ?? null,
    state: d.state ?? null,
    pincode: d.pincode ?? null,
    industry: d.industry ?? null,
    contacts: d.contacts ?? [],
    gstCertificates: [],
    customFields: [],
  };
}

type WithClient = { client?: unknown; clientDetails?: unknown };
const idOf = (c: unknown) => (c && typeof c === 'object' && '_id' in c ? (c as { _id: unknown })._id : c);

/**
 * The client of an order or project: its Client record when it has one (older records), otherwise the client array's
 * latest entry. The record must have `clientDetails` loaded for the second case.
 */
export async function clientOf(x: WithClient): Promise<ClientLike | null> {
  const id = idOf(x.client);
  if (id) {
    const c = await Client.findById(id).lean();
    if (c) return c as unknown as ClientLike;
  }
  return clientView(latestClient(x.clientDetails as ClientDetails[] | null | undefined));
}

/** The latest entry as plain data (a hydrated document's subdocument included), to copy onto another record. */
export function latestDetails(x: { clientDetails?: unknown }): ClientDetails | null {
  const d = latestClient(x.clientDetails as ClientDetails[] | null | undefined) as (ClientDetails & { toObject?: () => ClientDetails }) | null;
  return d ? (d.toObject?.() ?? { ...d }) : null;
}

/** The client's name only (notifications, file folders). */
export const clientNameOf = async (x: WithClient) => (await clientOf(x))?.name ?? null;

/**
 * Query hook: where `client` was populated but the record has no Client (a client array instead), `client` reads as
 * the array's latest entry, so lists and details keep their `client.name` / `client.code` shape. Lean results only.
 */
export function fillClientFromDetails(schema: Schema) {
  schema.post(['find', 'findOne'], function (res: unknown) {
    const populated = (this as unknown as { _mongooseOptions?: { populate?: Record<string, unknown> } })._mongooseOptions?.populate?.client;
    if (!populated || !res) return;
    for (const r of Array.isArray(res) ? res : [res]) {
      // Hydrated documents keep `client` an ObjectId path; only plain (lean) rows are filled.
      if (!r || typeof r !== 'object' || '$__' in r) continue;
      const row = r as { client?: unknown; clientDetails?: ClientDetails[] | null };
      if (!row.client && row.clientDetails?.length) row.client = clientView(latestClient(row.clientDetails));
    }
  });
}
