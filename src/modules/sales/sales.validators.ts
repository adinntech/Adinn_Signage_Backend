import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { CLIENT_TYPES, ORGANISATION_TYPES } from '../clients/client.model';
import { clientRegistration } from '../clients/client.validators';
import { APPROVAL_DOC_TYPES, EMAIL_KINDS, HANDOVER_TYPES, LEAD_STAGES, ORDER_STAGES } from './sales.model';

/** Generated once per form session by the web app; resubmitting the same key returns the first result. */
const requestKey = z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid request key').optional();

export const registerBody = clientRegistration.extend({ requestKey });
/** Order Management: BD picks the client and flags the order New / Existing client (suggested from the client's order count). */
export const createOrderBody = z.object({
  clientId: objectId,
  clientType: z.enum(CLIENT_TYPES, { message: 'Choose New Client or Existing Client' }).optional(),
  requestKey,
});

const optDate = z.coerce.date().optional().or(z.literal('').transform(() => undefined));
export const orderListQuery = listQuery.extend({
  ownerId: objectId.optional().or(z.literal('').transform(() => undefined)),
  clientId: objectId.optional().or(z.literal('').transform(() => undefined)),
  clientType: z.enum(CLIENT_TYPES).optional().or(z.literal('').transform(() => undefined)),
  /** BD view: handed over to Client Servicing or not yet. */
  handover: z.enum(['ASSIGNED', 'PENDING']).optional().or(z.literal('').transform(() => undefined)),
});

export const handoverTypeBody = z.object({ type: z.enum(HANDOVER_TYPES, { message: 'Choose ASO, Shop Details Only or Shop + Measurement' }) });
export const shopTotalBody = z.object({ total: z.coerce.number({ message: 'Enter the total number of shops' }).int('Enter a whole number').min(1, 'Enter at least 1 shop').max(100000) });
export const assignCsBody = z.object({
  csUserId: objectId,
  note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)),
});
export const shopRowsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  state: z.enum(['VALID', 'WARNING', 'ERROR']).optional().or(z.literal('').transform(() => undefined)),
});
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

/* ----------------------------- Lead Management ----------------------------- */

const notesText = z.string().trim().max(4000).optional().or(z.literal('').transform(() => undefined));
export const leadListQuery = listQuery.extend({
  stage: z.enum(LEAD_STAGES).optional().or(z.literal('').transform(() => undefined)),
  status: z.enum(['OPEN', 'CLOSED', 'COMPLETED']).optional().or(z.literal('').transform(() => undefined)),
  clientType: z.enum(CLIENT_TYPES).optional().or(z.literal('').transform(() => undefined)),
});
export const leadCandidatesQuery = z.object({ q: z.string().trim().max(100).optional() });
export const startLeadBody = z.object({ orderId: objectId, initialNotes: notesText });
/** `stage` is the stage the person is looking at, so a stale screen cannot move the lead twice. */
export const leadMoveBody = z.object({ stage: z.enum(LEAD_STAGES), note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)) });
export const leadNotesBody = z.object({ initialNotes: z.string().trim().max(4000) });
const opt = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const optMobile = z.string().trim().regex(/^\d{10}$/, 'Mobile number must be exactly 10 digits').optional().or(z.literal('').transform(() => undefined));
const optMail = z.string().trim().toLowerCase().email('Enter a valid email address').optional().or(z.literal('').transform(() => undefined));
const person = z.object({ name: opt(120), designation: opt(120), mobile: optMobile, email: optMail });
const team = z.object({ primary: person.nullish(), escalation: person.nullish() });
/** Customer Onboarding Form (all optional except what the form itself needs to make sense). */
export const onboardingBody = z
  .object({
    organisationType: z.enum(ORGANISATION_TYPES).optional().or(z.literal('').transform(() => undefined)),
    organisationOther: opt(120),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN (e.g. ABCDE1234F)').optional().or(z.literal('').transform(() => undefined)),
    msmeApplicable: z.boolean().optional(),
    msmeNumber: opt(40),
    primaryPhone: z.string().trim().regex(/^[\d+\-\s()]{6,20}$/, 'Enter a valid phone number').optional().or(z.literal('').transform(() => undefined)),
    registered: z
      .object({
        floorNo: opt(60),
        buildingNo: opt(120),
        premises: opt(200),
        road: opt(300),
        locality: opt(200),
        city: opt(80),
        district: opt(80),
        state: opt(80),
        pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits').optional().or(z.literal('').transform(() => undefined)),
      })
      .nullish(),
    branchAddress: opt(500),
    keyManagement: z.array(person).max(10).default([]),
    accounts: team.nullish(),
    finance: team.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.msmeApplicable && !v.msmeNumber) ctx.addIssue({ code: 'custom', path: ['msmeNumber'], message: 'Enter the MSME number' });
    if (v.organisationType === 'OTHERS' && !v.organisationOther) ctx.addIssue({ code: 'custom', path: ['organisationOther'], message: 'Enter the type of organisation' });
  });

export const closeLeadBody =z.object({ reason: z.string().trim().min(3, 'Enter why the lead is closed').max(1000) });
