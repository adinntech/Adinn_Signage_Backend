import { z } from 'zod';
import { listQuery } from '../../common/query';
import { mobileRule, optionalEmail, rejectDuplicateContacts } from '../../common/validators/contact';
import { CLIENT_SOURCES, CLIENT_TYPES } from './client.model';

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

const contactArray = z
  .array(contact)
  .max(20)
  .superRefine((list, ctx) => rejectDuplicateContacts(list, ctx, []));
export const contactList = contactArray.default([]);

/** Company phone: mobile or landline with STD code, digits only. */
const companyPhone = z.string().trim().regex(/^\d{10,12}$/, 'Phone number must be 10-12 digits');
/** Add / Edit Client (BD CRM): exactly 10 digits. The original client API keeps accepting 10-12. */
const companyPhone10 = z.string().trim().regex(/^\d{10}$/, 'Phone number must be exactly 10 digits');
const customFieldArray = z
  .array(z.object({ label: z.string().trim().min(1, 'Enter the field label').max(60), value: z.string().trim().min(1, 'Enter the value').max(500) }))
  .max(30)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((f, i) => {
      const k = f.label.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [i, 'label'], message: `"${f.label}" is already added` });
      seen.add(k);
    });
  });

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
  clientName: optStr(120),
  industry: optStr(120),
  district: optStr(80),
  pincode,
  phone: companyPhone.optional().or(z.literal('').transform(() => undefined)),
  customFields: customFieldArray.optional(),
});
// No defaults on a patch: a patch without contacts / status must keep the saved ones.
// Edit Client sends the company phone: a changed phone must be 10 digits. GSTIN stays optional on a patch (a contact
// edit sends only contacts); the form itself requires it.
export const clientPatch = clientBody
  .partial()
  .omit({ code: true })
  .extend({ contacts: contactArray.optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(), phone: companyPhone10.optional().or(z.literal('').transform(() => undefined)) });
export const clientListQuery = listQuery.extend({
  // Without a status the list leaves drafts out; DRAFT lists only the drafts.
  status: z.enum(['ACTIVE', 'INACTIVE', 'DRAFT']).optional(),
  clientType: z.enum(CLIENT_TYPES).optional(),
  source: z.enum(CLIENT_SOURCES).optional(),
});

/**
 * Add Client "Save Draft": whatever has been typed so far, nothing mandatory and no format checks (they run when the
 * draft is saved as a client). Lengths are still capped.
 */
const draftStr = (max: number) => z.string().trim().max(max).optional().default('');
export const clientDraft = z.object({
  name: draftStr(120),
  clientName: draftStr(120),
  email: draftStr(200),
  phone: draftStr(20),
  gstin: draftStr(20),
  customFields: z
    .array(z.object({ label: draftStr(60), value: draftStr(500) }))
    .max(30)
    .default([])
    // Rows left completely empty are not kept.
    .transform((list) => list.filter((f) => f.label || f.value)),
});

/**
 * BD "New Client" registration: company name, email and phone are mandatory. Contact persons are optional here
 * (they are added later, e.g. at handover); a contact that is sent must have a mobile number.
 */
export const clientRegistration = z.object({
  name: z.string().trim().min(2, 'Enter the company name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid company email'),
  phone: companyPhone10,
  customFields: customFieldArray.default([]),
  clientName: optStr(120),
  industry: optStr(120),
  address: optStr(500),
  city: optStr(80),
  district: optStr(80),
  state: optStr(80),
  pincode,
  // Mandatory for a new client (Add Client / a draft saved as a client).
  gstin: z.string({ error: 'Enter the GST number' }).trim().min(1, 'Enter the GST number').pipe(gstin),
  contacts: z
    .array(contact.extend({ phone: strictMobile }))
    .max(20)
    .superRefine((list, ctx) => rejectDuplicateContacts(list, ctx, []))
    .default([]),
});
