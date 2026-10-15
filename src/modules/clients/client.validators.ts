import { z } from 'zod';
import { listQuery } from '../../common/query';

const phone = z.string().trim().regex(/^[+\d][\d\s-]{6,15}$/, 'Invalid phone number');
const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Invalid GSTIN');

const contact = z.object({
  name: z.string().trim().min(1),
  designation: z.string().trim().optional(),
  phone: phone.optional().or(z.literal('').transform(() => undefined)),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
  isPrimary: z.boolean().default(false),
});

export const clientBody = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2-8 letters/digits'),
  contacts: z.array(contact).max(20).default([]),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  gstin: gstin.optional().or(z.literal('').transform(() => undefined)),
  notes: z.string().trim().max(2000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
export const clientPatch = clientBody.partial().omit({ code: true });
export const clientListQuery = listQuery.extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
