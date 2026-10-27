import { AppError } from '../../common/errors';
import { nextSeq, peekSeq } from '../../common/counter.model';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { SalesOrder } from '../sales/sales.model';
import { normKey } from '../sites/site.fields';
import { purgeClientData } from './client.cascade';
import { Client } from './client.model';
import type { z } from 'zod';
import type { clientBody, clientListQuery, clientPatch, clientRegistration } from './client.validators';

/** Rejects a client whose name (ignoring case, spacing and punctuation), GSTIN or company email already belongs to another active client. */
async function assertUnique(input: { name?: string | undefined; gstin?: string | undefined; email?: string | undefined }, exceptId?: string) {
  const notSelf = exceptId ? { _id: { $ne: exceptId } } : {};
  if (input.name) {
    const key = normKey(input.name);
    const others = await Client.find({ deletedAt: null, ...notSelf }).select('name code clientNo').lean();
    const clash = others.find((c) => normKey(c.name) === key);
    if (clash) throw AppError.conflict(`A client named "${clash.name}" already exists (${clash.clientNo ?? `code ${clash.code}`}). Use Existing Client to create a new order for it.`);
  }
  if (input.gstin) {
    const clash = await Client.findOne({ deletedAt: null, gstin: input.gstin, ...notSelf }).select('name').lean();
    if (clash) throw AppError.conflict(`GSTIN ${input.gstin} already belongs to client "${clash.name}"`);
  }
  if (input.email) {
    const clash = await Client.findOne({ deletedAt: null, email: input.email.toLowerCase(), ...notSelf }).select('name').lean();
    if (clash) throw AppError.conflict(`Company email ${input.email} already belongs to client "${clash.name}"`);
  }
}

const FIELDS = ['name', 'email', 'industry', 'contacts', 'address', 'city', 'district', 'state', 'pincode', 'gstin', 'notes', 'status'];

const nextClientNo = async () => `CLI-${String(await nextSeq('clientNo')).padStart(4, '0')}`;

/** Clients created before the BD CRM get a Client ID the first time the list is read (oldest first, so IDs follow creation order). */
let numbered = false;
async function ensureClientNumbers() {
  if (numbered) return;
  const missing = await Client.find({ clientNo: null }).sort({ createdAt: 1 }).select('_id').lean();
  for (const c of missing) await Client.updateOne({ _id: c._id, clientNo: null }, { clientNo: await nextClientNo() });
  numbered = true;
}

/** Short unique code (used inside project IDs) derived from the company name, e.g. "Acme Retail" -> ACMERETA, ACMERE2. */
async function generateCode(name: string) {
  const base = (name.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'CLIENT').slice(0, 8).padEnd(2, 'X');
  if (!(await Client.exists({ code: base }))) return base;
  for (let i = 2; i < 1000; i++) {
    const code = `${base.slice(0, 8 - String(i).length)}${i}`;
    if (!(await Client.exists({ code }))) return code;
  }
  throw AppError.conflict('Could not generate a unique client code');
}

/** Exactly one primary contact: the one marked, else the first. */
const withPrimary = <T extends { isPrimary?: boolean }>(contacts: T[]) => {
  const idx = Math.max(0, contacts.findIndex((c) => c.isPrimary));
  return contacts.map((c, i) => ({ ...c, isPrimary: i === idx }));
};

export async function listClients(q: z.infer<typeof clientListQuery>) {
  await ensureClientNumbers();
  const filter: Record<string, unknown> = { deletedAt: null };
  if (q.status) filter.status = q.status;
  if (q.clientType === 'NEW') filter.clientType = 'NEW';
  if (q.clientType === 'EXISTING') filter.clientType = { $ne: 'NEW' };
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: re }, { code: re }, { clientNo: re }, { city: re }, { email: re }, { 'contacts.name': re }, { 'contacts.phone': re }, { 'contacts.email': re }];
  }
  const [items, total] = await Promise.all([
    Client.find(filter).sort(parseSort(q.sort, ['name', 'code', 'clientNo', 'createdAt'], 'name')).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Client.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

/** Client list summary cards; counted from live records. */
export async function clientSummary() {
  const [newClientOrders, existingClientOrders, totalClients] = await Promise.all([
    SalesOrder.countDocuments({ deletedAt: null, clientType: 'NEW' }),
    SalesOrder.countDocuments({ deletedAt: null, clientType: 'EXISTING' }),
    Client.countDocuments({ deletedAt: null }),
  ]);
  return { newClientOrders, existingClientOrders, totalClients };
}

export async function getClient(id: string) {
  const c = await Client.findOne({ _id: id, deletedAt: null }).lean();
  if (!c) throw AppError.notFound('Client not found');
  return c;
}

/** Client with who created / last updated it and how many orders it has (View Client Details). */
export async function getClientDetails(id: string) {
  await ensureClientNumbers();
  const c = await Client.findOne({ _id: id, deletedAt: null }).populate('createdBy', 'name role').populate('updatedBy', 'name role').lean();
  if (!c) throw AppError.notFound('Client not found');
  const orderCount = await SalesOrder.countDocuments({ client: id, deletedAt: null });
  return { ...c, clientType: c.clientType ?? 'EXISTING', orderCount };
}

export async function createClient(input: z.infer<typeof clientBody>, actor: Actor) {
  if (await Client.exists({ code: input.code })) throw AppError.conflict(`Client code ${input.code} already exists`);
  await assertUnique(input);
  const c = await Client.create({ ...input, clientNo: await nextClientNo(), createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id });
  return c.toObject();
}

/** BD "New Client": company + all contact persons in one record, with a generated code and Client ID. */
export async function registerCompany(input: z.infer<typeof clientRegistration>, actor: Actor) {
  await assertUnique(input);
  const c = await Client.create({
    ...input,
    contacts: withPrimary(input.contacts),
    code: await generateCode(input.name),
    clientNo: await nextClientNo(),
    clientType: 'NEW',
    status: 'ACTIVE',
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id, reason: 'Registered as a new client (BD)' });
  return c;
}

/** Client Code for a Zoho customer: its Zoho customer number when free, otherwise a code made from the name. */
const codeForZoho = async (name: string, zohoCustomerNo?: string) => (zohoCustomerNo && !(await Client.exists({ code: zohoCustomerNo })) ? zohoCustomerNo : generateCode(name));

/** An existing client, not yet tied to a Zoho contact, with the same name or GSTIN. */
const findUnlinkedMatch = async (name: string, gstin?: string) => {
  const key = normKey(name);
  return (await Client.find({ deletedAt: null, zohoContactId: null }).select('name gstin code clientNo').lean()).find((c) => normKey(c.name) === key || (!!gstin && c.gstin === gstin));
};

/** The Client ID and code a Zoho customer will have after import, shown before the admin clicks OK. */
export async function previewZohoIdentity(zohoContactId: string, name: string, gstin?: string, zohoCustomerNo?: string) {
  const synced = await Client.findOne({ zohoContactId, deletedAt: null }).select('code clientNo').lean();
  if (synced) return { mode: 'IMPORTED' as const, clientNo: synced.clientNo, code: synced.code };
  const match = await findUnlinkedMatch(name, gstin);
  if (match) return { mode: 'LINK' as const, clientNo: match.clientNo, code: match.code };
  return { mode: 'NEW' as const, clientNo: `CLI-${String(await peekSeq('clientNo')).padStart(4, '0')}`, code: await codeForZoho(name, zohoCustomerNo) };
}

type ZohoFields = Omit<z.infer<typeof clientBody>, 'code' | 'contacts'> & { contacts: z.infer<typeof clientBody>['contacts'] };

/**
 * Zoho Books import into the client master. Matches an already-imported client by Zoho contact id, then an
 * existing client by name or GSTIN (linked, only blank fields are filled so nothing typed by BD is overwritten);
 * otherwise a new EXISTING client is created. Re-importing the same contact never makes a duplicate.
 */
export async function importZohoClient(zohoContactId: string, f: ZohoFields, actor: Actor, zohoCustomerNo?: string) {
  const now = new Date();
  const synced = await Client.findOne({ zohoContactId, deletedAt: null });
  if (synced) {
    const before = synced.toObject();
    synced.set({ ...f, zohoSyncedAt: now, updatedBy: actor.id });
    await synced.save();
    await recordAudit({ actor, action: 'UPDATE', entity: 'Client', entityId: synced._id, changes: diff(before as never, f as never, FIELDS), reason: 'Refreshed from Zoho Books' });
    return { client: synced.toObject(), outcome: 'UPDATED' as const };
  }
  const known = await findUnlinkedMatch(f.name, f.gstin);
  if (known) {
    const doc = await Client.findById(known._id);
    if (doc) {
      const blank = Object.fromEntries(Object.entries(f).filter(([k, v]) => k !== 'contacts' && k !== 'status' && v && !(doc.get(k) as unknown)));
      if (!doc.contacts.length && f.contacts.length) blank.contacts = f.contacts;
      doc.set({ ...blank, zohoContactId, zohoSyncedAt: now, updatedBy: actor.id });
      await doc.save();
      await recordAudit({ actor, action: 'UPDATE', entity: 'Client', entityId: doc._id, reason: 'Linked to Zoho Books contact' });
      return { client: doc.toObject(), outcome: 'LINKED' as const };
    }
  }
  await assertUnique({ email: f.email });
  const c = await Client.create({ ...f, contacts: withPrimary(f.contacts), code: await codeForZoho(f.name, zohoCustomerNo), clientNo: await nextClientNo(), clientType: 'EXISTING', zohoContactId, zohoSyncedAt: now, createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id, reason: 'Imported from Zoho Books' });
  return { client: c.toObject(), outcome: 'CREATED' as const };
}

export async function updateClient(id: string, patch: z.infer<typeof clientPatch>, actor: Actor) {
  const before = await getClient(id);
  await assertUnique(patch, id);
  const set = patch.contacts?.length ? { ...patch, contacts: withPrimary(patch.contacts) } : patch;
  const c = await Client.findByIdAndUpdate(id, { ...set, updatedBy: actor.id }, { returnDocument: 'after' }).lean();
  await recordAudit({ actor, action: 'UPDATE', entity: 'Client', entityId: id, changes: diff(before as never, set as never, FIELDS) });
  return c;
}

export async function deleteClient(id: string, actor: Actor) {
  await getClient(id);
  // No projects: the client and everything it owns (orders, files) is erased. With projects: hidden only, they still need it.
  const { purged, removed } = await purgeClientData(id);
  if (!purged) await Client.updateOne({ _id: id }, { deletedAt: new Date(), status: 'INACTIVE', updatedBy: actor.id });
  await recordAudit({ actor, action: 'DELETE', entity: 'Client', entityId: id, reason: purged ? 'Erased with its sales orders and files' : 'Hidden: it still has projects' });
  return { id, purged, removed };
}
