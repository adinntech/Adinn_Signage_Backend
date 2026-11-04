import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { mobileRule, optionalEmail } from '../../common/validators/contact';
import { RATE_UNITS } from './ratecard.model';

const optStr = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const money = (label: string) =>
  z.coerce.number({ message: `Enter the ${label}` }).min(0, `${label[0]!.toUpperCase()}${label.slice(1)} cannot be negative`).max(100000000, `${label} is too large`)
    .transform((n) => Math.round(n * 100) / 100);

export const rateItemBody = z.object({
  particulars: z.string().trim().min(2, 'Enter the signage particulars').max(150),
  specifications: optStr(300),
  unit: z.enum(RATE_UNITS, { message: 'Choose a rate unit' }),
  rate: money('rate amount').refine((n) => n > 0, 'Rate amount must be greater than 0'),
});
export const rateItemPatch = rateItemBody.partial();
export const rateItemListQuery = listQuery.extend({ limit: z.coerce.number().int().min(1).max(500).default(25), unit: z.enum(RATE_UNITS).optional() });

const line = z
  .object({
    masterItemId: objectId.optional().or(z.literal('').transform(() => undefined)).nullable(),
    particulars: z.string().trim().min(1, 'Enter the signage particulars').max(150),
    specifications: optStr(300),
    unit: z.enum(RATE_UNITS, { message: 'Choose a rate unit' }),
    masterRate: money('master rate').nullable().optional(),
    quotedRate: money('quoted rate').refine((n) => n > 0, 'Quoted rate must be greater than 0'),
    overrideReason: optStr(300),
  })
  .superRefine((l, ctx) => {
    // Business rule: any quoted rate that differs from the copied master rate needs a reason.
    if (l.masterRate != null && l.quotedRate !== l.masterRate && !l.overrideReason)
      ctx.addIssue({ code: 'custom', path: ['overrideReason'], message: 'Enter a reason: quoted rate differs from the master rate' });
  });

export const quotationBody = z.object({
  clientAddress: optStr(500),
  contact: z.object({
    name: z.string().trim().min(1, 'Select the contact person').max(120),
    designation: optStr(120),
    phone: optStr(20),
    email: optionalEmail,
  }),
  quotationDate: z.coerce.date({ message: 'Enter the quotation date' }),
  // No Subject input in the rate card editors any more: a version keeps the previous one (or the default).
  subject: optStr(250),
  items: z.array(line).min(1, 'Add at least one signage item').max(100),
  terms: z.string().trim().max(20000).default(''),
  regards: z.object({
    name: z.string().trim().min(1, 'Enter the name').max(120),
    // Not printed on the ADINN rate card (Client Service shows name, email and phone); kept for older revisions.
    designation: optStr(120),
    mobile: mobileRule,
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  }),
});

/** Rate Card Creation: the quotation plus the selected Zoho client (Client Company (Zoho)). */
/**
 * Client Servicing rate cards (Create Project > Rate Card, Rate Card Creation): the contact person is optional (typed;
 * the PDF leaves out "Kind Attn" when it is blank).
 */
export const csQuotationBody = quotationBody.extend({ contact: quotationBody.shape.contact.extend({ name: z.string().trim().max(120).default('') }) });

export const rateCardCreationBody = csQuotationBody.extend({
  zohoId: z.string({ message: 'Select the client company' }).trim().min(1, 'Select the client company').max(64),
  requestKey: z.string().trim().max(100).optional(),
});
export const rateCardCreationListQuery = listQuery;
