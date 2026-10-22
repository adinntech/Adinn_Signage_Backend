import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { nextSeq } from '../../common/counter.model';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { normKey } from '../sites/site.fields';
import { RATE_ITEM_SEED, RateItem } from './ratecard.model';
import type { rateItemBody, rateItemListQuery, rateItemPatch } from './ratecard.validators';

const FIELDS = ['particulars', 'specifications', 'unit', 'rate'];

/** Seeds the reference rates exactly once (a counter marks it done, so deleting every item never re-seeds). */
async function ensureSeeded() {
  if (await RateItem.exists({})) return;
  if ((await nextSeq('seed:rateItems')) !== 1) return;
  await RateItem.insertMany(RATE_ITEM_SEED.map((r) => ({ ...r })));
}

/** Same particulars + specifications (ignoring case and punctuation) cannot appear twice among live items. */
async function assertUnique(input: { particulars?: string | undefined; specifications?: string | undefined }, exceptId?: string) {
  if (!input.particulars) return;
  const key = normKey(`${input.particulars}|${input.specifications ?? ''}`);
  const rows = await RateItem.find({ deletedAt: null, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('particulars specifications').lean();
  const clash = rows.find((r) => normKey(`${r.particulars}|${r.specifications ?? ''}`) === key);
  if (clash) throw AppError.conflict(`"${clash.particulars}" with these specifications already exists in the master rate card`);
}

export async function listRateItems(q: z.infer<typeof rateItemListQuery>) {
  await ensureSeeded();
  const filter: Record<string, unknown> = { deletedAt: null };
  if (q.unit) filter.unit = q.unit;
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ particulars: re }, { specifications: re }];
  }
  const [items, total] = await Promise.all([
    RateItem.find(filter)
      .sort(parseSort(q.sort, ['particulars', 'rate', 'unit', 'createdAt', 'updatedAt'], 'createdAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    RateItem.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

async function getLive(id: string) {
  const r = await RateItem.findOne({ _id: id, deletedAt: null }).lean();
  if (!r) throw AppError.notFound('Rate item not found');
  return r;
}

export async function createRateItem(input: z.infer<typeof rateItemBody>, actor: Actor) {
  await assertUnique(input);
  const r = await RateItem.create({ ...input, createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'RateItem', entityId: r._id });
  return r.toObject();
}

export async function updateRateItem(id: string, patch: z.infer<typeof rateItemPatch>, actor: Actor) {
  const before = await getLive(id);
  await assertUnique({ particulars: patch.particulars ?? before.particulars, specifications: patch.specifications ?? before.specifications ?? undefined }, id);
  const changes = diff(before as never, patch as never, FIELDS);
  if (!changes.length) return before;
  const r = await RateItem.findByIdAndUpdate(id, { ...patch, updatedBy: actor.id }, { returnDocument: 'after' }).lean();
  await recordAudit({ actor, action: 'UPDATE', entity: 'RateItem', entityId: id, changes });
  return r;
}

/** Archive, never erase: saved quotations hold their own copy of every line. */
export async function deleteRateItem(id: string, actor: Actor) {
  await getLive(id);
  await RateItem.updateOne({ _id: id }, { deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'DELETE', entity: 'RateItem', entityId: id, reason: 'Archived (quotation snapshots are kept)' });
  return { id, archived: true };
}

/** Current live master rates by id (for Copy From Master and Compare Rates). */
export async function masterRatesById(ids: string[]) {
  const rows = await RateItem.find({ _id: { $in: ids } }).lean();
  return new Map(rows.map((r) => [String(r._id), r]));
}
