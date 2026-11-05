import { z } from 'zod';
import { AppError } from '../../common/errors';

export const pincodeParam = z.object({ pin: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit pincode') });

const TIMEOUT_MS = 6000;
const URL_BASE = 'https://api.postalpincode.in/pincode/';

/**
 * State and district of an Indian pincode, from the public India Post pincode list. The web app never calls it directly:
 * it asks this endpoint. When the service is down the person picks the state and types the city themselves.
 */
export async function lookupPincode(pin: string) {
  let body: unknown;
  try {
    const res = await fetch(URL_BASE + pin, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch {
    throw new AppError(502, 'LOOKUP_FAILED', 'Could not look up the pincode now. Choose the state and type the city yourself.');
  }
  const first = (Array.isArray(body) ? body[0] : null) as { Status?: string; PostOffice?: { Name?: string; District?: string; State?: string }[] | null } | null;
  const offices = first?.Status === 'Success' ? (first.PostOffice ?? []) : [];
  const head = offices.find((o) => o.State && o.District);
  if (!head) throw AppError.notFound(`Pincode ${pin} was not found`);
  return {
    pincode: pin,
    state: String(head.State),
    district: String(head.District),
    areas: [...new Set(offices.map((o) => o.Name).filter((n): n is string => !!n))].slice(0, 20),
  };
}
