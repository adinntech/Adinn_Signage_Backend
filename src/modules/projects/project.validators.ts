import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { PRIORITIES, PROJECT_STATUSES, REQUIREMENT_SOURCES } from './project.model';

const optStr = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const optPhone = z.string().trim().regex(/^[+\d][\d\s-]{6,15}$/, 'Invalid phone number').optional().or(z.literal('').transform(() => undefined));

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
      phone: optPhone,
      email: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
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

export const projectCreate = z.object({
  clientId: objectId,
  campaign: z.string().trim().min(1).max(120),
  name: optStr(160),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  targetDate: date.optional().or(z.literal('').transform(() => undefined)),
  description: optStr(5000),
  ownerId: objectId.optional(),
  coordinatorId: objectId.optional(),
  sourceMessageId: objectId.optional(),
  requirement: requirementBody,
});

export const projectPatch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  campaign: z.string().trim().min(1).max(120).optional(),
  priority: z.enum(PRIORITIES).optional(),
  targetDate: date.nullable().optional(),
  description: optStr(5000),
  ownerId: objectId.nullable().optional(),
  coordinatorId: objectId.nullable().optional(),
});

export const statusBody = z
  .object({ status: z.enum(PROJECT_STATUSES), reason: z.string().trim().max(500).optional() })
  .refine((v) => !['ON_HOLD', 'CANCELLED'].includes(v.status) || !!v.reason, {
    message: 'A reason is required for ON_HOLD or CANCELLED',
    path: ['reason'],
  });

export const projectListQuery = listQuery.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  clientId: objectId.optional(),
  ownerId: objectId.optional(),
});
