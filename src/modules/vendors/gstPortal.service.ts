import { env } from '../../config/env';

/** What the GST lookup returns for one GST number (the names the CRM uses, not the provider's). */
export interface GstDetails {
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  /** "Active", "Cancelled", "Suspended"... as the provider reports it. */
  status: string | null;
  constitution: string | null;
  taxpayerType: string | null;
  registrationDate: string | null;
  state: string | null;
  pan: string | null;
  address: string | null;
  district: string | null;
  pincode: string | null;
  natureOfBusiness: string[];
}
export type GstLookup =
  | { available: false; reason: 'NOT_CONFIGURED' }
  | { available: true; details: GstDetails; error: null }
  | { available: true; details: null; error: string };

const TIMEOUT_MS = 10_000;
/** A number is asked once a day at most: every lookup costs a credit, and the form checks the number again as it is edited. */
const CACHE_MS = 24 * 3600_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; details: GstDetails }>();
export const clearGstCache = () => cache.clear();

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** True when GST_VERIFY_KEY is set, so the lookup can be used. */
export const gstLookupConfigured = () => !!env.GST_VERIFY_KEY;

function normalise(gstin: string, d: Record<string, unknown>): GstDetails {
  return {
    gstin,
    legalName: text(d.legal_name),
    tradeName: text(d.trade_name),
    status: text(d.status),
    constitution: text(d.constitution),
    taxpayerType: text(d.taxpayer_type),
    registrationDate: text(d.registration_date),
    state: text(d.state),
    pan: text(d.pan),
    address: text(d.address),
    district: text(d.district),
    pincode: text(d.pincode),
    natureOfBusiness: Array.isArray(d.nature_of_business) ? d.nature_of_business.filter((x): x is string => typeof x === 'string') : [],
  };
}

/**
 * The legal name, trade name, status, address and PAN of a GST number, from a paid GST lookup service (GST_VERIFY_URL,
 * GST_VERIFY_KEY). The key stays on the server. Never throws: a failure comes back as a readable message so the form still works
 * with the number-only checks. Without a key the lookup is simply off.
 */
export async function lookupGst(gstin: string): Promise<GstLookup> {
  const key = env.GST_VERIFY_KEY;
  if (!key) return { available: false, reason: 'NOT_CONFIGURED' };
  const hit = cache.get(gstin);
  if (hit && Date.now() - hit.at < CACHE_MS) return { available: true, details: hit.details, error: null };
  const fail = (error: string): GstLookup => ({ available: true, details: null, error });
  let res: Response;
  try {
    res = await fetch(`${env.GST_VERIFY_URL.replace(/\/+$/, '')}/${encodeURIComponent(gstin)}`, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return fail('The GST lookup service did not answer. Try again, or type the details yourself.');
  }
  if (res.status === 401 || res.status === 403) return fail('The GST lookup key was refused. Ask the administrator to check GST_VERIFY_KEY.');
  if (res.status === 402 || res.status === 429) return fail('The GST lookup credits or rate limit are used up. Type the details yourself for now.');
  if (res.status === 404) return fail('This GST number was not found on the GST portal.');
  type Reply = { success?: boolean; message?: string; error?: string; data?: Record<string, unknown> };
  const body: Reply | null = await res.json().then((j) => j as Reply, () => null);
  if (!res.ok || !body?.success || !body.data) return fail(text(body?.message) ?? text(body?.error) ?? `The GST lookup failed (HTTP ${res.status}).`);
  const details = normalise(gstin, body.data);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(gstin, { at: Date.now(), details });
  return { available: true, details, error: null };
}
