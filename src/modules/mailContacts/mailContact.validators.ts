import { z } from 'zod';

const email = z.string().trim().toLowerCase().max(200).email('Enter a valid email address');
const text = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);

export const contactBody = z.object({ email, name: text(120), group: text(60), active: z.boolean().default(true) });
export const contactPatch = contactBody.partial();

export const suggestQuery = z.object({ q: z.string().trim().max(100).default(''), limit: z.coerce.number().int().min(1).max(15).default(8) });
const filterFields = {
  q: z.string().trim().max(100).default(''),
  status: z.enum(['active', 'inactive']).optional(),
  /** An exact group, or "none" for the contacts that have no group. */
  group: z.string().trim().max(60).optional(),
};
export const contactListQuery = z.object({
  ...filterFields,
  sort: z.enum(['name', 'email', 'group', 'status']).default('email'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Bulk change: the ticked contacts (ids), or every contact matching the filter. */
export const bulkBody = z
  .object({
    action: z.enum(['activate', 'deactivate', 'delete', 'group']),
    ids: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).min(1).max(2000).optional(),
    filter: z.object(filterFields).optional(),
    /** For action "group": the new group; empty clears it. */
    group: z.string().trim().max(60).optional(),
  })
  .refine((b) => !!b.ids !== !!b.filter, 'Choose contacts by ids or by filter, not both');
