import { z } from 'zod';
import { CODE_KINDS } from './codeRequest.model';

const emailList = z
  .array(z.string().trim().toLowerCase().email('Enter a valid email address'))
  .max(20)
  .transform((l) => [...new Set(l)]);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const requestKey = z.string().trim().regex(/^[A-Za-z0-9-]{8,48}$/, 'Invalid request key');

/** One email: the code kinds it carries (both = combined email) and its own recipients and text. */
export const mailBody = z.object({
  kinds: z.array(z.enum(CODE_KINDS)).min(1).max(2),
  to: emailList.refine((l) => l.length > 0, 'Enter at least one recipient'),
  cc: emailList.default([]),
  bcc: emailList.default([]),
  from: z.string().trim().max(200).optional(),
  subject: z.string().trim().min(1, 'Enter the email subject').max(250),
  body: z.string().trim().min(1, 'Enter the email content').max(20000),
});

export const sendBody = z
  .object({
    mails: z.array(mailBody).min(1).max(2),
    /** Client GST certificates (file ids) to attach next to the uploaded files. */
    includeClientDocs: z.array(objectId).max(10).default([]),
    requestKey,
  })
  .superRefine((v, ctx) => {
    const all = v.mails.flatMap((m) => m.kinds);
    if (new Set(all).size !== all.length) ctx.addIssue({ code: 'custom', path: ['mails'], message: 'A code can be requested in one email only' });
  });

export const draftBody = z.object({ mails: z.array(mailBody.partial({ to: true, subject: true, body: true })).min(1).max(2) });

/** Client code and project code formats. A project code is the 8-digit number used on the operations project. */
export const CODE_RULES = {
  CLIENT_CODE: { regex: /^[A-Z0-9][A-Z0-9-]{2,19}$/, message: 'Client code must be 3 to 20 letters, digits or dashes' },
  PROJECT_CODE: { regex: /^\d{8}$/, message: 'Project code must be exactly 8 digits' },
} as const;

export const alreadySentBody = z.object({ kinds: z.array(z.enum(CODE_KINDS)).min(1).max(2), note: z.string().trim().min(3, 'Say where and when it was sent').max(500) }).refine((v) => new Set(v.kinds).size === v.kinds.length, 'Each code once');

export const confirmBody = z.object({
  kind: z.enum(CODE_KINDS),
  code: z.string().trim().toUpperCase().min(1, 'Enter the code received').max(20),
  evidenceNote: z.string().trim().max(500).optional(),
});
export const rejectBody = z.object({ kind: z.enum(CODE_KINDS), reason: z.string().trim().min(3, 'Enter the reason').max(500) });
export const retryBody = z.object({ mailBatchId: z.string().trim().min(8).max(64) });

export const codeListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: z.enum(['DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'FAILED']).optional(),
  kind: z.enum(CODE_KINDS).optional(),
  q: z.string().trim().max(60).optional(),
});
