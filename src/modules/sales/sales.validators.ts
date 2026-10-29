import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { mobileRule, optionalEmail, rejectDuplicateContacts } from '../../common/validators/contact';
import { CLIENT_TYPES, ORGANISATION_TYPES } from '../clients/client.model';
import { clientRegistration } from '../clients/client.validators';
import { PRIORITIES } from '../projects/project.model';
import { APPROVAL_DOC_TYPES, EMAIL_KINDS, HANDOVER_TYPES, LEAD_STAGES, ORDER_STAGES } from './sales.model';

/** Assign to Recce Team: the codes the BD received for the project. */
export const recceCodesBody = z.object({
  projectCode: z.string().trim().regex(/^\d{8}$/, 'Project code must be exactly 8 digits'),
  estimationCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^EST-\d{6}$/, 'Estimation code must be EST- and 6 digits, e.g. EST-323343'),
  /** New client: the Client ID created in Zoho. Existing clients take theirs from Zoho. */
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,20}$/, 'Client ID: 2-20 letters, digits or -')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
const day = z.coerce.date({ message: 'Choose a date' });
/** Assign to Recce Team: the person, and what the operations project needs to be assigned. */
export const recceAssignBody = z
  .object({
    assigneeId: objectId,
    startDate: day,
    targetDate: day,
    district: z.string().trim().min(2, 'Enter the district / location').max(120),
    priority: z.enum(PRIORITIES).default('MEDIUM'),
    note: z.string().trim().max(2000).optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((v) => v.targetDate >= v.startDate, { path: ['targetDate'], message: 'End date must be on or after the start date' });

/** Generated once per form session by the web app; resubmitting the same key returns the first result. */
const requestKey = z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid request key').optional();

export const registerBody = clientRegistration.extend({ requestKey });
/**
 * Order Management: BD picks the flag first, then the client. New Client = a client from Client Management
 * (`clientId`); Existing Client = a Zoho customer (`zohoId`), which is brought into the CRM on the way.
 */
export const createOrderBody = z
  .object({
    clientId: objectId.optional(),
    zohoId: z.string().trim().min(1).max(64).optional(),
    clientType: z.enum(CLIENT_TYPES, { message: 'Choose New Client or Existing Client' }).optional(),
    /** New Lead: first discussion notes, kept on the lead. */
    initialNotes: z.string().trim().max(4000).optional().or(z.literal('').transform(() => undefined)),
    requestKey,
  })
  .superRefine((v, ctx) => {
    if (!v.clientId === !v.zohoId) ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'Select the client company' });
  });
export const zohoClientQuery = z.object({ q: z.string().trim().max(100).default('') });

const optDate = z.coerce.date().optional().or(z.literal('').transform(() => undefined));
export const orderListQuery = listQuery.extend({
  ownerId: objectId.optional().or(z.literal('').transform(() => undefined)),
  clientId: objectId.optional().or(z.literal('').transform(() => undefined)),
  clientType: z.enum(CLIENT_TYPES).optional().or(z.literal('').transform(() => undefined)),
  /** BD view: handed over to Client Servicing or not yet. */
  handover: z.enum(['ASSIGNED', 'PENDING']).optional().or(z.literal('').transform(() => undefined)),
});

export const handoverTypeBody = z.object({ type: z.enum(HANDOVER_TYPES, { message: 'Choose ASO, Shop Details Only or Shop + Measurement' }) });
export const handoverScopeBody = z.object({ full: z.boolean({ message: 'Choose whether to send the full handover' }) });
/** Handover chat message (multipart): text, and `voice` = the one attached file is a voice note of `durationSec`. */
export const handoverMessageBody = z.object({
  text: z.string().trim().max(4000, 'Keep the message under 4000 characters').optional(),
  voice: z.enum(['1', 'true']).optional().transform((v) => !!v),
  durationSec: z.coerce.number().min(0).max(305, 'A voice note can be at most 5 minutes').optional(),
});
const cell = (max: number) => z.string().trim().max(max).optional().or(z.null().transform(() => undefined));
/** Shop row typed in the table (text values; the site import rules check and clean them). */
export const shopRowBody = z.object({
  shopName: cell(250),
  dealerName: cell(250),
  location: cell(250),
  district: cell(250),
  address1: cell(250),
  address2: cell(250),
  address3: cell(250),
  pincode: cell(10),
  mobile: cell(40),
  mobileAlt: cell(40),
  gstin: cell(20),
  contactPerson: cell(250),
  width: cell(20),
  height: cell(20),
  unit: cell(10),
  boardType: cell(250),
  quantity: cell(10),
  remarks: cell(1000),
  clientSiteCode: cell(250),
  /** Columns of the uploaded Excel that are not shop fields (header -> value); omitted = keep the row's current ones. */
  extra: z.record(z.string().trim().min(1).max(120), z.string().trim().max(500)).optional(),
  /** Imported-columns tables: column id -> cell text, kept as typed (omitted = keep the row's cells). */
  cells: z.record(z.string().regex(/^c\d{1,4}$/, 'Invalid column'), z.string().max(2000)).optional(),
});
/**
 * Shop list upload options (multipart text fields), sent from the mapping step when the file was ambiguous: the sheet,
 * the Excel row number of the header row, and header -> field (or "extra" / "ignore").
 */
export const shopUploadBody = z.object({
  sheet: z.string().trim().max(120).optional(),
  headerRow: z.coerce.number().int().min(1).max(1_000_000).optional(),
  /** '1': only return the preview of this sheet / header row (the mapping step), import nothing. */
  preview: z.enum(['1', 'true']).optional().transform((v) => !!v),
  mapping: z
    .string()
    .max(20000)
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      try {
        const v = JSON.parse(s) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((t) => typeof t === 'string')) return v as Record<string, string>;
      } catch {
        /* reported below */
      }
      ctx.addIssue({ code: 'custom', message: 'Invalid column mapping' });
      return z.NEVER;
    }),
});
/**
 * ASO: the client's SO contacts. Completely blank rows are dropped; a contact that is kept needs a name and a mobile
 * number, the email is optional. One contact is primary (the first one when none is marked).
 */
export const soContactsBody = z.object({
  contacts: z
    .array(z.object({ name: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), isPrimary: z.boolean().optional() }))
    .max(50, 'Up to 50 SO contacts')
    .transform((list) => list.filter((c) => [c.name, c.phone, c.email].some((v) => (v ?? '').trim() !== '')))
    .pipe(
      z
        .array(
          z.object({
            name: z.string().trim().min(1, 'Enter the contact name').max(120),
            phone: mobileRule,
            email: optionalEmail,
            isPrimary: z.boolean().optional(),
          }),
        )
        .superRefine((list, ctx) => rejectDuplicateContacts(list, ctx, [])),
    )
    .transform((list) => {
      const p = Math.max(0, list.findIndex((c) => c.isPrimary));
      return list.map((c, i) => ({ ...c, isPrimary: i === p }));
    }),
});
export const rowIdParam = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid row id');
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

/** Create Project > Change Client: the new client (Client Management for New, Zoho for Existing). */
export const leadClientBody = z
  .object({
    clientId: objectId.optional(),
    zohoId: z.string().trim().min(1).max(64).optional(),
    clientType: z.enum(CLIENT_TYPES, { message: 'Choose New Client or Existing Client' }),
  })
  .superRefine((v, ctx) => {
    if (!v.clientId === !v.zohoId) ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'Select the client company' });
  });
export const closeLeadBody =z.object({ reason: z.string().trim().min(3, 'Enter why the lead is closed').max(1000) });
