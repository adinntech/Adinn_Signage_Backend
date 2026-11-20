import type { Request } from 'express';
import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().regex(/^-?[a-zA-Z.]+$/).optional(),
});

/* Created At / Last Updated At filters of a list: India dates (YYYY-MM-DD), both ends included. */
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional().or(z.literal('').transform(() => undefined));
export const dateRangeFields = { createdFrom: ymd, createdTo: ymd, updatedFrom: ymd, updatedTo: ymd };
type DateRanges = { createdFrom?: string; createdTo?: string; updatedFrom?: string; updatedTo?: string };
/** From must not be after To (each range on its own). */
export const checkDateRanges = (v: DateRanges, ctx: z.RefinementCtx) => {
  if (v.createdFrom && v.createdTo && v.createdFrom > v.createdTo) ctx.addIssue({ code: 'custom', path: ['createdTo'], message: 'Created At: To date must be on or after the From date' });
  if (v.updatedFrom && v.updatedTo && v.updatedFrom > v.updatedTo) ctx.addIssue({ code: 'custom', path: ['updatedTo'], message: 'Last Updated At: To date must be on or after the From date' });
};
/** India days from..to as a Mongo range (whole days, India time), or undefined when neither is set. */
const istRange = (from?: string, to?: string) => {
  const r: Record<string, Date> = {};
  if (from) r.$gte = new Date(`${from}T00:00:00+05:30`);
  if (to) r.$lt = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000);
  return from || to ? r : undefined;
};
/** createdAt / updatedAt conditions for the given ranges (merged into a list filter). */
export function dateRangeFilter(v: DateRanges) {
  const f: Record<string, unknown> = {};
  const created = istRange(v.createdFrom, v.createdTo);
  const updated = istRange(v.updatedFrom, v.updatedTo);
  if (created) f.createdAt = created;
  if (updated) f.updatedAt = updated;
  return f;
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
export const pageMeta = (page: number, limit: number, total: number): PageMeta => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only allow sorting by whitelisted fields. */
export function parseSort(sort: string | undefined, allowed: string[], fallback: string) {
  const s = sort ?? fallback;
  const field = s.replace(/^-/, '');
  const use = allowed.includes(field) ? s : fallback;
  return { [use.replace(/^-/, '')]: use.startsWith('-') ? -1 : 1 } as Record<string, 1 | -1>;
}

export interface Actor {
  id: string;
  role: string;
}
export const actorOf = (req: Request): Actor => ({ id: req.auth!.sub, role: req.auth!.role });
