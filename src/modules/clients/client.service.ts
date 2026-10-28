import { Types } from 'mongoose';
import { AppError } from '../../common/errors';
import { nextSeq, peekSeq } from '../../common/counter.model';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { SalesOrder } from '../sales/sales.model';
import { normKey } from '../sites/site.fields';
import { discardStoredFiles, eraseStoredFile, storedFileUrl, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { purgeClientData } from './client.cascade';
import { Client } from './client.model';
import type { ZohoClient } from '../zoho/zoho.customers';
import type { z } from 'zod';
import type { clientBody, clientDraft, clientListQuery, clientPatch, clientRegistration } from './client.validators';

/** Rejects a client whose name (ignoring case, spacing and punctuation), GSTIN or company email already belongs to another active client. */
async function assertUnique(input: { name?: string | undefined; gstin?: string | undefined; email?: string | undefined }, exceptId?: string) {
  // Drafts are not clients yet: they never block a name, GSTIN or email.
  const notSelf: Record<string, unknown> = { status: { $ne: 'DRAFT' }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) };
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

const FIELDS = ['name', 'clientName', 'email', 'phone', 'customFields', 'industry', 'contacts', 'address', 'city', 'district', 'state', 'pincode', 'gstin', 'notes', 'status'];

const nextClientNo = async () => `CLI-${String(await nextSeq('clientNo')).padStart(4, '0')}`;

/** Clients created before the BD CRM get a Client ID the first time the list is read (oldest first, so IDs follow creation order). */
let numbered = false;
async function ensureClientNumbers() {
  if (numbered) return;
  // Drafts get their Client ID when they are saved as a client.
  const missing = await Client.find({ clientNo: null, status: { $ne: 'DRAFT' } }).sort({ createdAt: 1 }).select('_id').lean();
  for (const c of missing) await Client.updateOne({ _id: c._id, clientNo: null, status: { $ne: 'DRAFT' } }, { clientNo: await nextClientNo() });
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
  // Drafts are listed only when asked for (status=DRAFT).
  const filter: Record<string, unknown> = { deletedAt: null, status: q.status ?? { $ne: 'DRAFT' } };
  if (q.clientType === 'NEW') filter.clientType = 'NEW';
  if (q.clientType === 'EXISTING') filter.clientType = { $ne: 'NEW' };
  // CRM = registered in Client Management (the New Client list); ZOHO = brought in from Zoho.
  if (q.source === 'CRM') filter.source = { $ne: 'ZOHO' };
  if (q.source === 'ZOHO') filter.source = 'ZOHO';
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: re }, { clientName: re }, { code: re }, { clientNo: re }, { city: re }, { email: re }, { phone: re }, { gstin: re }, { 'contacts.name': re }, { 'contacts.phone': re }, { 'contacts.email': re }];
  }
  const [items, total] = await Promise.all([
    Client.find(filter).sort(parseSort(q.sort, ['name', 'code', 'clientNo', 'createdAt'], 'name')).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Client.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

/** Client list summary cards; counted from live records. */
export async function clientSummary() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const live: Record<string, unknown> = { deletedAt: null, status: { $ne: 'DRAFT' } };
  const [newClientOrders, existingClientOrders, totalClients, activeClients, clientsThisMonth, draftClients] = await Promise.all([
    SalesOrder.countDocuments({ deletedAt: null, clientType: 'NEW' }),
    SalesOrder.countDocuments({ deletedAt: null, clientType: 'EXISTING' }),
    Client.countDocuments(live),
    Client.countDocuments({ deletedAt: null, status: 'ACTIVE' }),
    Client.countDocuments({ ...live, createdAt: { $gte: monthStart } }),
    Client.countDocuments({ deletedAt: null, status: 'DRAFT' }),
  ]);
  return { newClientOrders, existingClientOrders, totalClients, activeClients, clientsThisMonth, draftClients };
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

/* ---------------------------------- drafts ---------------------------------- */

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

/** Draft values as stored: blanks cleared, so a resumed form shows exactly what was typed. */
const draftSet = (d: z.infer<typeof clientDraft>) => ({
  name: d.name || null,
  clientName: d.clientName || null,
  email: d.email.toLowerCase() || null,
  phone: d.phone || null,
  gstin: d.gstin.toUpperCase() || null,
  customFields: d.customFields,
});

/** Add Client "Save Draft" (first save): no checks, no Client ID; a placeholder code until it becomes a client. */
export async function createDraft(d: z.infer<typeof clientDraft>, actor: Actor) {
  // `new` + save: a draft may have no name yet (the typed create() expects one).
  const c = new Client({
    ...draftSet(d),
    code: `DRAFT-${new Types.ObjectId().toHexString().slice(-12)}`,
    status: 'DRAFT',
    clientType: 'NEW',
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  await c.save();
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id, reason: 'Saved as a draft (Add Client)' });
  return c.toObject();
}

/** Later "Save Draft" on the same draft (never a second record). */
export async function updateDraft(id: string, d: z.infer<typeof clientDraft>, actor: Actor) {
  const c = await Client.findOneAndUpdate({ _id: id, deletedAt: null, status: 'DRAFT' }, { $set: { ...draftSet(d), updatedBy: actor.id } }, { returnDocument: 'after' }).lean();
  if (!c) throw AppError.conflict('This draft was already saved as a client or deleted. Reload the client list.');
  return c;
}

/**
 * "Save Client" on a draft: the full Add Client checks, then the same record becomes an active client with its code
 * and Client ID. Conditional on DRAFT, so a double click or a second tab cannot create it twice.
 */
export async function finalizeDraft(id: string, input: z.infer<typeof clientRegistration>, actor: Actor) {
  const draft = await Client.findOne({ _id: id, deletedAt: null }).select('status').lean();
  if (!draft) throw AppError.notFound('Draft not found');
  if (draft.status !== 'DRAFT') throw AppError.conflict('This draft was already saved as a client.');
  await assertUnique(input, id);
  const c = await Client.findOneAndUpdate(
    { _id: id, status: 'DRAFT', deletedAt: null },
    {
      $set: {
        ...input,
        contacts: withPrimary(input.contacts),
        code: await generateCode(input.name),
        clientNo: await nextClientNo(),
        clientType: 'NEW',
        status: 'ACTIVE',
        updatedBy: actor.id,
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!c) throw AppError.conflict('This draft was already saved as a client.');
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id, reason: 'Registered as a new client from a draft (BD)' });
  return c;
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

const MAX_GST_FILES = 5;
const clientOwner = (id: unknown) => ({ entity: 'Client' as const, id: String(id) });

/** GST certificate scans / PDFs. Up to five files per client. */
export async function addGstCertificates(id: string, files: UploadedFile[], actor: Actor) {
  if (!files.length) throw AppError.badRequest('Choose the GST certificate file');
  const c = await getClient(id);
  if ((c.gstCertificates?.length ?? 0) + files.length > MAX_GST_FILES) throw AppError.badRequest(`Up to ${MAX_GST_FILES} GST certificate files per client`);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) {
      stored.push(await storeEmbeddedFile({ category: 'CLIENT_GST_CERTIFICATE', clientName: c.name, folderKey: c.clientNo ?? c.code, file: f, actor, owner: clientOwner(c._id) }));
    }
    await Client.updateOne({ _id: c._id }, { $push: { gstCertificates: { $each: stored } }, $set: { updatedBy: actor.id } });
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  return getClientDetails(id);
}

export async function removeGstCertificate(id: string, fileId: string, actor: Actor) {
  const c = await getClient(id);
  const file = c.gstCertificates?.find((f) => String(f.fileId) === fileId);
  if (!file) throw AppError.notFound('File not found');
  await Client.updateOne({ _id: c._id }, { $pull: { gstCertificates: { fileId: file.fileId } }, $set: { updatedBy: actor.id } });
  // A certificate already handed over with an order (Lead Management) stays in storage for that handover.
  const handedOver = await SalesOrder.exists({ 'handoverClient.gstCertificates.fileId': file.fileId });
  if (!handedOver) await eraseStoredFile(file as StoredFile, actor, clientOwner(c._id));
  return getClientDetails(id);
}

/** Short-lived link to one of the client's files. */
export async function clientFileUrl(id: string, fileId: string) {
  const c = await getClient(id);
  const file = c.gstCertificates?.find((f) => String(f.fileId) === fileId);
  if (!file) throw AppError.notFound('File not found');
  return storedFileUrl(file as StoredFile);
}

/**
 * The local client for a Zoho customer (existing client), so orders and leads point at a normal client record.
 * Already linked: refreshed from Zoho. Same company already in Client Management (GSTIN, email or name): linked to
 * it. Otherwise created as an EXISTING client from Zoho.
 */
export async function linkZohoCustomer(z: ZohoClient, actor: Actor) {
  const fromZoho = { name: z.name, clientName: z.clientName, email: z.email, phone: z.phone, gstin: z.gstin, city: z.city, state: z.state };
  const linked = await Client.findOne({ zohoId: z.zohoId, deletedAt: null });
  if (linked) {
    // Only what Zoho actually has overwrites; a blank in Zoho keeps the CRM value.
    const set = Object.fromEntries(Object.entries(fromZoho).filter(([, v]) => v));
    await Client.updateOne({ _id: linked._id }, { $set: { ...set, updatedBy: actor.id } });
    return (await Client.findById(linked._id).lean())!;
  }
  const or: Record<string, unknown>[] = [];
  if (z.gstin) or.push({ gstin: z.gstin });
  if (z.email) or.push({ email: z.email });
  // A draft is not a client yet, so a Zoho customer never links to one.
  const live: Record<string, unknown> = { deletedAt: null, zohoId: null, status: { $ne: 'DRAFT' } };
  let same = or.length ? await Client.findOne({ ...live, $or: or }).lean() : null;
  if (!same) {
    const key = normKey(z.name);
    const unlinked = await Client.find(live).select('name').lean();
    const hit = unlinked.find((c) => c.name && normKey(c.name) === key);
    same = hit ? await Client.findById(hit._id).lean() : null;
  }
  if (same) {
    await Client.updateOne({ _id: same._id }, { $set: { zohoId: z.zohoId, updatedBy: actor.id } });
    await recordAudit({ actor, action: 'UPDATE', entity: 'Client', entityId: same._id, changes: [{ field: 'zohoId', oldValue: null, newValue: z.zohoId }], reason: 'Linked to the Zoho customer' });
    return (await Client.findById(same._id).lean())!;
  }
  const c = await Client.create({
    ...fromZoho,
    code: await generateCode(z.name),
    clientNo: await nextClientNo(),
    clientType: 'EXISTING',
    source: 'ZOHO',
    zohoId: z.zohoId,
    status: 'ACTIVE',
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id, reason: 'Added from the Zoho customer list (existing client)' });
  return c.toObject();
}

/** Local clients already linked to these Zoho ids: zohoId -> client id. */
export async function linkedZohoClients(zohoIds: string[]) {
  const rows = await Client.find({ deletedAt: null, zohoId: { $in: zohoIds } }).select('zohoId clientNo').lean();
  return new Map(rows.map((r) => [r.zohoId!, { clientId: String(r._id), clientNo: r.clientNo ?? null }]));
}
