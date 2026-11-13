import { z } from 'zod';
import { AppError } from '../../common/errors';

export const pincodeParam = z.object({ pin: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit pincode') });

const TIMEOUT_MS = 5000;
const POSTAL = 'https://api.postalpincode.in/pincode/';
const ZIPPO = 'https://api.zippopotam.us/in/';

export interface PincodeResult { pincode: string; state: string; district: string; areas: string[]; /** true: only the state is known (from the first digits); the person types the city. */ partial?: boolean }

/** First 2 digits of an Indian pincode -> state, only where one state owns the whole range (used when no online list answers). */
const STATE_BY_PREFIX: [number, number, string][] = [
  [11, 11, 'Delhi'], [12, 13, 'Haryana'], [14, 15, 'Punjab'], [17, 17, 'Himachal Pradesh'], [30, 34, 'Rajasthan'], [36, 39, 'Gujarat'],
  [40, 44, 'Maharashtra'], [45, 48, 'Madhya Pradesh'], [49, 49, 'Chhattisgarh'], [50, 50, 'Telangana'], [56, 59, 'Karnataka'],
  [60, 64, 'Tamil Nadu'], [67, 69, 'Kerala'], [70, 74, 'West Bengal'], [75, 77, 'Odisha'], [78, 78, 'Assam'], [80, 82, 'Bihar'], [83, 85, 'Jharkhand'],
];
export const stateOfPrefix = (pin: string) => { const p = Number(pin.slice(0, 2)); return STATE_BY_PREFIX.find(([a, b]) => p >= a && p <= b)?.[2]; };

const cache = new Map<string, PincodeResult>();

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** India Post list (tried twice: the public service often fails once). null: reachable but the pincode is not in it. Throws when unreachable. */
async function fromPostal(pin: string): Promise<PincodeResult | null> {
  let body: unknown;
  try { body = await getJson(POSTAL + pin); } catch { body = await getJson(POSTAL + pin); }
  const first = (Array.isArray(body) ? body[0] : null) as { Status?: string; PostOffice?: { Name?: string; District?: string; State?: string }[] | null } | null;
  const offices = first?.Status === 'Success' ? (first.PostOffice ?? []) : [];
  const head = offices.find((o) => o.State && o.District);
  if (!head) return null;
  return { pincode: pin, state: String(head.State), district: String(head.District), areas: [...new Set(offices.map((o) => o.Name).filter((n): n is string => !!n))].slice(0, 20) };
}

/** Second public list; it has the state and place name only. */
async function fromZippo(pin: string): Promise<PincodeResult | null> {
  const body = (await getJson(ZIPPO + pin)) as { places?: { 'place name'?: string; state?: string }[] };
  const p = body.places?.find((x) => x.state);
  return p ? { pincode: pin, state: String(p.state), district: String(p['place name'] ?? ''), areas: [], partial: true } : null;
}

/**
 * State and district of an Indian pincode. The web app never calls a pincode service itself: it asks this endpoint, which tries
 * the India Post list, then a second list, and last the state from the first digits (the person then types the city). Answers
 * are kept in memory, so a pincode is looked up once. Only when nothing at all is known does it fail, and the person types both.
 */
export async function lookupPincode(pin: string): Promise<PincodeResult> {
  const hit = cache.get(pin);
  if (hit) return hit;
  let found: PincodeResult | null = null;
  let notInOfficialList = false; // India Post answered and does not know this pincode
  for (const source of [fromPostal, fromZippo]) {
    try { found = await source(pin); } catch { found = null; continue; }
    if (found) break;
    if (source === fromPostal) notInOfficialList = true;
  }
  if (!found && notInOfficialList) throw AppError.notFound(`Pincode ${pin} was not found`);
  if (!found) {
    const state = stateOfPrefix(pin);
    if (!state) throw new AppError(502, 'LOOKUP_FAILED', 'Could not look up the pincode now. Choose the state and type the city yourself.');
    return { pincode: pin, state, district: '', areas: [], partial: true }; // not cached: the real lists may answer next time
  }
  cache.set(pin, found);
  return found;
}
