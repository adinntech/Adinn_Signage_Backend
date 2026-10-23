import { z } from 'zod';
import { listQuery } from '../../common/query';
import { mobileRule, optionalEmail, rejectDuplicateContacts } from '../../common/validators/contact';
import { CLIENT_TYPES } from './client.model';

const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Invalid GSTIN');
const optStr = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const pincode = z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits').optional().or(z.literal('').transform(() => undefined));

// Client contact persons: names/designations are letters and spaces; mobiles are typed as exactly 10 digits.
const LETTERS = /^[A-Za-z ]+$/;
const LETTERS_MSG = 'Use letters and spaces only';
const strictMobile = z.string().trim().regex(/^\d{10}$/, 'Mobile number must be exactly 10 digits').pipe(mobileRule);
const optionalStrictMobile = z.union([z.literal('').transform(() => undefined), strictMobile]).optional();

const contact = z.object({
  name: z.string().trim().min(1, 'Enter the contact name').max(120).regex(LETTERS, LETTERS_MSG),
  designation: z.string().trim().max(120).regex(LETTERS, LETTERS_MSG).optional().or(z.literal('').transform(() => undefined)),
  phone: optionalStrictMobile,
  alternatePhone: optionalStrictMobile,
  email: optionalEmail,
  alternateEmail: optionalEmail,
  isPrimary: z.boolean().default(false),
});

export const contactList = z
  .array(contact)
  .max(20)
  .default([])
  .superRefine((list, ctx) => rejectDuplicateContacts(list, ctx, []));

export const clientBody = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2-8 letters/digits'),
  contacts: contactList,
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  gstin: gstin.optional().or(z.literal('').transform(() => undefined)),
  notes: z.string().trim().max(2000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  // BD CRM company fields; optional here so the original client API keeps working unchanged.
  email: optionalEmail,
  industry: optStr(120),
  district: optStr(80),
  pincode,
});
export const clientPatch = clientBody.partial().omit({ code: true });
export const clientListQuery = listQuery.extend({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  clientType: z.enum(CLIENT_TYPES).optional(),
});

/** BD "New Client" registration: company email and at least one contact with a mobile number are mandatory. */
export const clientRegistration = z.object({
  name: z.string().trim().min(2, 'Enter the company name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid company email'),
  industry: optStr(120),
  address: optStr(500),
  city: optStr(80),
  district: optStr(80),
  state: optStr(80),
  pincode,
  gstin: gstin.optional().or(z.literal('').transform(() => undefined)),
  contacts: z
    .array(contact.extend({ phone: strictMobile }))
    .min(1, 'Add at least one contact person')
    .max(20)
    .superRefine((list, ctx) => rejectDuplicateContacts(list, ctx, [])),
});
