import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { mobileRule, optionalEmail, optionalMobile, rejectDuplicateContacts } from '../../common/validators/contact';
import { PRIORITIES, PROJECT_STATUSES, REQUIREMENT_SOURCES, REQUIREMENT_TYPES } from './project.model';

const optStr = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

export const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().nonnegative().optional(),
  mimeType: z.string().max(100).optional(),
  fileId: z.string().max(100).optional(),
  url: z.string().max(500).optional(),
});

export const requirementBody = z.object({
  source: z.enum(REQUIREMENT_SOURCES),
  sourceNote: optStr(500),
  contact: z
    .object({
      name: optStr(120),
      phone: optionalMobile,
      email: optionalEmail,
    })
    .default({}),
  expectedSites: z.number().int().min(0).max(100000).optional(),
  locations: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  description: optStr(5000),
  commercialNotes: optStr(5000),
  recceRequired: z.boolean().default(true),
  siteDataScenario: z.enum(['MEASUREMENT_REQUIRED', 'CLIENT_PROVIDED']).default('MEASUREMENT_REQUIRED'),
  attachments: z.array(attachmentSchema).max(50).default([]),
});

const date = z.coerce.date();
const optDate = date.optional().or(z.literal('').transform(() => undefined));

/** Client SO contact on a project. Name + a valid email and a 10-digit mobile are mandatory. */
export const projectContact = z.object({
  name: z.string().trim().min(2, 'Enter the contact name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: mobileRule,
});
const contactList = z
  .array(projectContact)
  .max(20)
  .superRefine((list, ctx) => rejectDuplicateContacts(list, ctx, ['contacts']));

export const projectCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{3,19}$/, 'Project code must be 4-20 letters, numbers or dashes');

const DEFAULT_REQUIREMENT = requirementBody.parse({ source: 'OTHER' });
const BD_START_STATUS = z.enum(['DRAFT', 'ENQUIRY', 'NEW']);

const projectFields = {
  code: projectCode.optional(),
  campaign: z.string().trim().min(1).max(120),
  name: optStr(160),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  startDate: optDate,
  targetDate: optDate,
  district: optStr(120),
  instructions: optStr(5000),
  requirementType: z.enum(REQUIREMENT_TYPES).optional(),
  expectedShops: z.number().int().min(1, 'Enter at least 1 shop').max(100000).nullable().optional(),
  contacts: contactList.optional(),
  description: optStr(5000),
  ownerId: objectId.optional(),
  coordinatorId: objectId.optional(),
  sourceMessageId: objectId.optional(),
};

function checkDates(v: { startDate?: Date | undefined; targetDate?: Date | undefined }, ctx: z.RefinementCtx) {
  if (v.startDate && v.targetDate && v.targetDate < v.startDate)
    ctx.addIssue({ code: 'custom', path: ['targetDate'], message: 'End date must be on or after the start date' });
}

export const projectCreate = z
  .object({
    clientId: objectId,
    ...projectFields,
    status: BD_START_STATUS.default('NEW'),
    requirement: requirementBody.default(DEFAULT_REQUIREMENT),
  })
  .superRefine((v, ctx) => {
    checkDates(v, ctx);
    if (v.requirementType && v.requirementType !== 'ASO' && v.expectedShops != null && v.expectedShops < 1)
      ctx.addIssue({ code: 'custom', path: ['expectedShops'], message: 'Enter the number of shops' });
  });

export const projectPatch = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    code: projectCode.optional(),
    campaign: z.string().trim().min(1).max(120).optional(),
    priority: z.enum(PRIORITIES).optional(),
    startDate: date.nullable().optional(),
    targetDate: date.nullable().optional(),
    district: optStr(120),
    instructions: optStr(5000),
    requirementType: z.enum(REQUIREMENT_TYPES).optional(),
    expectedShops: z.number().int().min(1).max(100000).nullable().optional(),
    contacts: contactList.optional(),
    description: optStr(5000),
    ownerId: objectId.nullable().optional(),
    coordinatorId: objectId.nullable().optional(),
  })
  .superRefine((v, ctx) => checkDates({ startDate: v.startDate ?? undefined, targetDate: v.targetDate ?? undefined }, ctx));

export const statusBody = z
  .object({ status: z.enum(PROJECT_STATUSES), reason: z.string().trim().max(500).optional() })
  .refine((v) => !['ON_HOLD', 'CANCELLED', 'LOSS'].includes(v.status) || !!v.reason, {
    message: 'A reason is required for ON_HOLD, CANCELLED or LOSS',
    path: ['reason'],
  });

export const assignBody = z.object({ assigneeId: objectId });
export const stageBody = z.object({ stage: z.enum(['PLANNING', 'IN_PROGRESS', 'CLIENT_APPROVAL', 'COMPLETED']) });

const csv = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values as [string, ...string[]])).optional());

export const projectListQuery = listQuery.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  statuses: csv(PROJECT_STATUSES),
  priority: z.enum(PRIORITIES).optional(),
  clientId: objectId.optional(),
  ownerId: objectId.optional(),
  assigneeId: objectId.optional(),
  /** true = only projects BD has assigned to Operations. */
  assigned: z.enum(['true', 'false']).optional(),
  requirementType: z.enum(REQUIREMENT_TYPES).optional(),
  /** true = past the expected end date and not yet completed or cancelled. */
  overdue: z.enum(['true']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const additionalShopsBody = z.object({
  count: z.number().int('Enter a whole number').min(0, 'Cannot be negative').max(100000),
  note: optStr(500),
});
