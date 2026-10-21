import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { normKey } from '../sites/site.fields';
import { Client } from './client.model';
import type { z } from 'zod';
import type { clientBody, clientListQuery, clientPatch } from './client.validators';

/** Rejects a client whose name (ignoring case, spacing and punctuation) or GSTIN already belongs to another active client. */
async function assertUnique(input: { name?: string | undefined; gstin?: string | undefined }, exceptId?: string) {
  const notSelf = exceptId ? { _id: { $ne: exceptId } } : {};
  if (input.name) {
    const key = normKey(input.name);
    const others = await Client.find({ deletedAt: null, ...notSelf }).select('name code').lean();
    const clash = others.find((c) => normKey(c.name) === key);
    if (clash) throw AppError.conflict(`A client named "${clash.name}" already exists (code ${clash.code})`);
  }
  if (input.gstin) {
    const clash = await Client.findOne({ deletedAt: null, gstin: input.gstin, ...notSelf }).select('name').lean();
    if (clash) throw AppError.conflict(`GSTIN ${input.gstin} already belongs to client "${clash.name}"`);
  }
}

const FIELDS = ['name', 'contacts', 'address', 'city', 'state', 'gstin', 'notes', 'status'];

export async function listClients(q: z.infer<typeof clientListQuery>) {
  const filter: Record<string, unknown> = { deletedAt: null };
  if (q.status) filter.status = q.status;
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: re }, { code: re }, { city: re }];
  }
  const [items, total] = await Promise.all([
    Client.find(filter).sort(parseSort(q.sort, ['name', 'code', 'createdAt'], 'name')).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Client.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

export async function getClient(id: string) {
  const c = await Client.findOne({ _id: id, deletedAt: null }).lean();
  if (!c) throw AppError.notFound('Client not found');
  return c;
}

export async function createClient(input: z.infer<typeof clientBody>, actor: Actor) {
  if (await Client.exists({ code: input.code })) throw AppError.conflict(`Client code ${input.code} already exists`);
  await assertUnique(input);
  const c = await Client.create({ ...input, createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'Client', entityId: c._id });
  return c.toObject();
}

export async function updateClient(id: string, patch: z.infer<typeof clientPatch>, actor: Actor) {
  const before = await getClient(id);
  await assertUnique(patch, id);
  const c = await Client.findByIdAndUpdate(id, { ...patch, updatedBy: actor.id }, { returnDocument: 'after' }).lean();
  await recordAudit({ actor, action: 'UPDATE', entity: 'Client', entityId: id, changes: diff(before as never, patch as never, FIELDS) });
  return c;
}

export async function deleteClient(id: string, actor: Actor) {
  await getClient(id);
  await Client.updateOne({ _id: id }, { deletedAt: new Date(), status: 'INACTIVE', updatedBy: actor.id });
  await recordAudit({ actor, action: 'DELETE', entity: 'Client', entityId: id });
}

