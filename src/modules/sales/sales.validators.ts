import { z } from 'zod';
import { objectId } from '../../common/query';
import { CLIENT_TYPES } from '../clients/client.model';
import { clientRegistration } from '../clients/client.validators';
import { APPROVAL_DOC_TYPES, EMAIL_KINDS, ORDER_STAGES } from './sales.model';

/** Generated once per form session by the web app; resubmitting the same key returns the first result. */
const requestKey = z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid request key').optional();

export const registerBody = clientRegistration.extend({ requestKey });
export const createOrderBody = z.object({ clientId: objectId, requestKey });

const optDate = z.coerce.date().optional().or(z.literal('').transform(() => undefined));
export const boardQuery = z.object({
  q: z.string().trim().max(100).optional(),
  ownerId: objectId.optional().or(z.literal('').transform(() => undefined)),
  clientType: z.enum(CLIENT_TYPES).optional().or(z.literal('').transform(() => undefined)),
  from: optDate,
  to: optDate,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const moveBody = z.object({ stage: z.enum(ORDER_STAGES) });
export const ownerBody = z.object({ ownerId: objectId });
export const commentBody = z.object({ body: z.string().trim().max(4000).optional().default('') });

const emailList = z
  .array(z.string().trim().toLowerCase().email('Enter a valid email address'))
  .max(20)
  .transform((l) => [...new Set(l)]);
export const sendEmailBody = z.object({
  to: emailList.refine((l) => l.length > 0, 'Enter at least one recipient'),
  cc: emailList.default([]),
  subject: z.string().trim().min(1, 'Enter the email subject').max(250),
  body: z.string().trim().min(1, 'Enter the email content').max(20000),
  requestKey,
});
export const emailListQuery = z.object({ kind: z.enum(EMAIL_KINDS).optional() });

const optText = z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined));
export const approvalUploadBody = z.object({
  docType: z.enum(APPROVAL_DOC_TYPES, { message: 'Choose the approval document type' }),
  approvalDate: optDate,
  remarks: optText,
  replacesId: objectId.optional().or(z.literal('').transform(() => undefined)),
});
export const approvalPatchBody = z.object({ approvalDate: optDate.nullable(), remarks: optText.nullable() }).partial();
