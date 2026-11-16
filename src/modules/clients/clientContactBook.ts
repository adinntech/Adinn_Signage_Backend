import { Schema, Types, model } from 'mongoose';
import { latestClient, type ClientDetails } from './clientDetails';

/**
 * Client-wise contacts (collection `clientcontactbooks`): the contact persons and POC contacts saved in Assign Type &
 * Details for any order of the client. A new order of the same client starts with a copy of them. A save adds new
 * contacts, updates edited ones and sets the primary; a contact deleted in an order is removed from that order only
 * (it stays here). Each order keeps its own copy, so a change in one order never changes another.
 */
const contactSchema = new Schema({ name: String, designation: String, phone: String, email: String, isPrimary: Boolean, ref: String }, { _id: false });

const clientContactBookSchema = new Schema(
  {
    /** "zoho:<Zoho contact id>": Client Servicing Create Project orders (the Zoho customer kept on the order). */
    key: { type: String, required: true, unique: true },
    zohoId: String,
    clientName: String,
    zohoCustomerNo: String,
    /** Contact persons (only used while the client itself has none in Zoho / Client Management). */
    contactPersons: { type: [contactSchema], default: undefined },
    /** POC contacts; `ref` = the contact person picked with "Same as Contact Person". */
    pocContacts: { type: [contactSchema], default: undefined },
    /** The order whose save wrote this last. */
    lastOrder: { type: Schema.Types.ObjectId, ref: 'SalesOrder' },
    lastOrderNo: String,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const ClientContactBook = model('ClientContactBook', clientContactBookSchema);

type Contact = { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean | null; ref?: string | null };
type OrderLike = { _id: Types.ObjectId | string; orderNo?: string | null; client?: unknown; clientDetails?: unknown };

const idOf = (c: unknown) => (c && typeof c === 'object' && '_id' in c ? (c as { _id: unknown })._id : c);

/**
 * The book key of an order's client: Create Project (Client Servicing) orders only, which keep the Zoho customer on
 * the order. An order linked to a clients-collection record (BD flow) has no book (null).
 */
export function contactBookKey(o: { client?: unknown; clientDetails?: unknown }) {
  if (idOf(o.client)) return null;
  const d = latestClient(o.clientDetails as ClientDetails[] | null | undefined);
  return d?.zohoId ? `zoho:${d.zohoId}` : null;
}

/** Only complete rows (name and phone), as plain values; one primary (the marked one, else the first). */
function clean(list: Contact[]) {
  const kept = list.filter((k) => k.name?.trim() && k.phone?.trim());
  const p = Math.max(0, kept.findIndex((k) => k.isPrimary));
  return kept.map((k, i) => ({
    name: k.name!.trim(),
    designation: k.designation?.trim() || null,
    phone: k.phone!.trim(),
    email: k.email?.trim() || null,
    isPrimary: i === p,
    ...(k.ref ? { ref: k.ref } : {}),
  }));
}

const nameKey = (k: Contact) => (k.name ?? '').trim().toLowerCase();
const phoneKey = (k: Contact) => (k.phone ?? '').replace(/\D/g, '').slice(-10);

/**
 * The book's list after an order's save: added contacts are appended, edited ones (same name, or same phone) are
 * updated, and the order's primary becomes the book's primary. A contact deleted in the order stays in the book
 * (it is only removed from that order).
 */
function merge(stored: Contact[], incoming: Contact[]) {
  const next = clean(incoming);
  const out: Contact[] = stored.map((k) => ({ ...k, isPrimary: next.length ? false : !!k.isPrimary }));
  for (const k of next) {
    const i = out.findIndex((s) => nameKey(s) === nameKey(k) || (!!phoneKey(k) && phoneKey(s) === phoneKey(k)));
    if (i >= 0) out[i] = k;
    else out.push(k);
  }
  return clean(out);
}

/**
 * Saves the order's lists to its client's book (merged, see `merge`; a list left out is kept).
 * Never fails the order's own save: the book is a convenience for the next order.
 */
export async function saveContactBook(o: OrderLike, lists: { contactPersons?: Contact[]; pocContacts?: Contact[] }, actorId: string) {
  const key = contactBookKey(o);
  if (!key) return;
  const d = latestClient(o.clientDetails as ClientDetails[] | null | undefined);
  const stored = await ClientContactBook.findOne({ key }).select('contactPersons pocContacts').lean().catch(() => null);
  await ClientContactBook.updateOne(
    { key },
    {
      $set: {
        ...(lists.contactPersons ? { contactPersons: merge(stored?.contactPersons ?? [], lists.contactPersons) } : {}),
        ...(lists.pocContacts ? { pocContacts: merge(stored?.pocContacts ?? [], lists.pocContacts) } : {}),
        ...(d ? { zohoId: d.zohoId, clientName: d.name, zohoCustomerNo: d.zohoCustomerNo ?? null } : {}),
        lastOrder: new Types.ObjectId(String(o._id)),
        lastOrderNo: o.orderNo ?? null,
        updatedBy: new Types.ObjectId(actorId),
      },
    },
    { upsert: true },
  ).catch(() => undefined);
}

/** The client's saved contacts for a new order (null when nothing is saved). */
export async function contactBookFor(o: { client?: unknown; clientDetails?: unknown }) {
  const key = contactBookKey(o);
  if (!key) return null;
  const b = await ClientContactBook.findOne({ key }).lean().catch(() => null);
  if (!b || (!b.contactPersons?.length && !b.pocContacts?.length)) return null;
  return { contactPersons: b.contactPersons ?? [], pocContacts: b.pocContacts ?? [], orderNo: b.lastOrderNo ?? null };
}
