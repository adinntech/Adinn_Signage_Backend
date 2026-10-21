import { z } from 'zod';

/**
 * Indian mobile numbers: exactly 10 digits, starting 6-9. Common ways people type one are accepted and
 * normalised first (+91 98765 43210, 0-98765-43210, 91 98765 43210) so the stored value is always 10 digits.
 * Same rule the site importer already applies (site.fields.normalisePhone).
 */
export function normalizeMobile(raw: string): string {
  let d = String(raw ?? '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

export const MOBILE_MESSAGE = 'Mobile number must be exactly 10 digits (starting with 6-9)';

export const mobileRule = z
  .string()
  .trim()
  .transform(normalizeMobile)
  .pipe(z.string().regex(/^[6-9]\d{9}$/, MOBILE_MESSAGE));

/** Optional mobile: blank is treated as "not provided", anything else must be a valid 10-digit number. */
export const optionalMobile = z.union([z.literal('').transform(() => undefined), mobileRule]).optional();

export const optionalEmail = z.union([z.literal('').transform(() => undefined), z.string().trim().toLowerCase().email('Enter a valid email address')]).optional();

/** Adds an issue for every contact whose phone or email repeats an earlier contact in the same list. */
export function rejectDuplicateContacts(
  list: { phone?: string | undefined; email?: string | undefined }[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  const phones = new Map<string, number>();
  const emails = new Map<string, number>();
  list.forEach((c, i) => {
    if (c.phone) {
      if (phones.has(c.phone)) ctx.addIssue({ code: 'custom', path: [...path, i, 'phone'], message: `Same mobile number as contact ${phones.get(c.phone)! + 1}` });
      else phones.set(c.phone, i);
    }
    if (c.email) {
      const e = c.email.toLowerCase();
      if (emails.has(e)) ctx.addIssue({ code: 'custom', path: [...path, i, 'email'], message: `Same email as contact ${emails.get(e)! + 1}` });
      else emails.set(e, i);
    }
  });
}
