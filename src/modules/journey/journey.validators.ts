import { z } from 'zod';
import { objectId } from '../../common/query';

export const STAGE_KEYS = ['HANDOVER', 'CLIENT_CODE', 'PROJECT_CODE', 'RECCE_ASSIGNED', 'PLANNING', 'FIELD_RECCE', 'CLIENT_APPROVAL', 'COMPLETED'] as const;
export const commentBody = z.object({ stage: z.enum(STAGE_KEYS), body: z.string().trim().min(1, 'Write a comment').max(500) });

export const portfolioQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  q: z.string().trim().max(60).optional(),
  status: z.enum(['RECCE_ASSIGNED', 'PLANNING', 'IN_PROGRESS', 'CLIENT_APPROVAL', 'COMPLETED', 'ON_HOLD', 'CANCELLED', 'LOSS', 'DRAFT', 'ENQUIRY', 'NEW', 'ACTIVE']).optional(),
  stage: z.enum(['RECCE_ASSIGNED', 'PLANNING', 'FIELD_RECCE', 'CLIENT_APPROVAL', 'COMPLETED']).optional(),
  clientId: objectId.optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
