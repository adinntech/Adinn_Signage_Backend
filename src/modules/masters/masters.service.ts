import mongoose from 'mongoose';
import { AppError } from '../../common/errors';
import { escapeRegex, type Actor } from '../../common/query';
import { Client } from '../clients/client.model';
import { Industry, nameKey } from './industry.model';

/** The options the client form used to ship as a static list (constants/industries.json in the web app). */
export const DEFAULT_INDUSTRIES = [
  'Retail & FMCG',
  'Automobile',
  'Banking & Finance',
  'Telecom',
  'Real Estate',
  'Healthcare',
  'Education',
  'Hospitality',
  'Petroleum & Energy',
  'Consumer Electronics',
  'Government',
 
];

const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * Upserts the default industries plus every industry already saved on a client, keyed case-insensitively, so it
 * never duplicates or renames an existing row. Safe to run repeatedly (and concurrently).
 */
export async function seedIndustries() {
  await Industry.init();
  const used = (await Client.distinct('industry')).filter((v): v is string => typeof v === 'string' && !!v.trim());
  const names = [...DEFAULT_INDUSTRIES, ...used].map(tidy);
  const res = await Industry.bulkWrite(
    names.map((name) => ({ updateOne: { filter: { key: nameKey(name) }, update: { $setOnInsert: { name, key: nameKey(name) } }, upsert: true } })),
    { ordered: false },
  );
  return res.upsertedCount;
}

let seeded: Promise<unknown> | null = null;
/** First read in a process makes sure the master is populated (no separate migration step needed). */
const ensureSeeded = () => (seeded ??= seedIndustries().catch((e) => ((seeded = null), Promise.reject(e))));

export async function listIndustries() {
  await ensureSeeded();
  const rows = await Industry.find({}, { name: 1 }).collation({ locale: 'en' }).sort({ name: 1 }).lean();
  // "Other" stays last, as in the original list.
  return [...rows.filter((r) => r.name !== 'Other'), ...rows.filter((r) => r.name === 'Other')].map((r) => ({ _id: String(r._id), name: r.name }));
}

export async function createIndustry(input: { name: string }, actor: Actor) {
  await ensureSeeded();
  const name = tidy(input.name);
  const key = nameKey(name);
  const exists = await Industry.findOne({ key }, { name: 1 }).lean();
  if (exists) throw AppError.conflict(`${exists.name} already exists.`);
  try {
    const row = await Industry.create({ name, key, createdBy: actor.id });
    return { _id: String(row._id), name: row.name };
  } catch (e) {
    // A concurrent request saved the same name between the check and the insert: the unique index rejects this one.
    if ((e as { code?: number }).code === 11000) throw AppError.conflict(`${name} already exists.`);
    throw e;
  }
}

/**
 * States and cities live in the shared `locations` collection as ONE document: { "Tamil Nadu": ["Chennai", ...], ... }.
 * Its structure is kept as is; cities are only appended to an existing state's array.
 */
const locations = () => mongoose.connection.collection('locations');
const isStateKey = (k: string) => k !== '_id' && !k.startsWith('$') && !k.includes('.');
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

async function locationDoc() {
  const doc = await locations().findOne({}, { sort: { _id: 1 } });
  if (!doc) throw AppError.notFound('Location master is empty');
  return doc;
}

export async function listStates() {
  const doc = await locationDoc();
  return Object.keys(doc).filter((k) => isStateKey(k) && Array.isArray(doc[k])).sort(byName);
}

function citiesOf(doc: Record<string, unknown>, state: string) {
  const list = isStateKey(state) && Object.hasOwn(doc, state) ? doc[state] : undefined;
  if (!Array.isArray(list)) throw AppError.notFound(`State "${state}" was not found`);
  return list.filter((c): c is string => typeof c === 'string' && !!c.trim()).map(tidy);
}

export async function listCities(state: string) {
  const seen = new Set<string>();
  return citiesOf(await locationDoc(), state)
    .filter((c) => !seen.has(nameKey(c)) && seen.add(nameKey(c)))
    .sort(byName);
}

export async function addCity(input: { state: string; name: string }) {
  const doc = await locationDoc();
  const name = tidy(input.name);
  const existing = citiesOf(doc, input.state).find((c) => nameKey(c) === nameKey(name));
  if (existing) throw AppError.conflict(`${existing} already exists.`);
  // Atomic guard: push only if no element of this state's array matches the name (ignoring case and surrounding spaces),
  // so two simultaneous saves of the same city cannot both land.
  const same = new RegExp(`^\\s*${name.split(' ').map(escapeRegex).join('\\s+')}\\s*$`, 'i');
  const push: Record<string, string> = { [input.state]: name }; // the state is a dynamic field name
  const res = await locations().updateOne({ _id: doc._id, [input.state]: { $type: 'array', $not: same } }, { $push: push as never });
  if (res.matchedCount === 0) throw AppError.conflict(`${name} already exists.`);
  return { state: input.state, name };
}
