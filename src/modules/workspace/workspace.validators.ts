import { z } from 'zod';
import { objectId } from '../../common/query';
import { NOTE_VISIBILITY } from './workspace.model';

export const ACTIVITY_CATEGORIES = ['PROJECT', 'STAGE', 'ASSIGNMENT', 'DOCUMENTS', 'MAIL', 'CODES', 'APPROVAL', 'SHOPS', 'NOTES'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const activityQuery = z.object({
  category: z.enum(ACTIVITY_CATEGORIES).optional(),
  before: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const ids = z.array(objectId).max(30).transform((l) => [...new Set(l)]);
export const notePayload = z.object({
  body: z.string().trim().max(4000).default(''),
  visibility: z.enum(NOTE_VISIBILITY).default('PROJECT'),
  mentions: ids.default([]),
});
export const noteEdit = z.object({ body: z.string().trim().min(1, 'A note cannot be empty').max(4000), visibility: z.enum(NOTE_VISIBILITY).optional() });
export const draftBody = z.object({ body: z.string().max(4000), visibility: z.enum(NOTE_VISIBILITY).default('PROJECT') });

export const voicePayload = z.object({
  title: z.string().trim().max(80).default(''),
  durationSec: z.number().min(1, 'The recording is empty').max(600),
  /** Bar heights 0 to 100, at most 64 bars. */
  peaks: z.array(z.number().min(0).max(100)).max(64).default([]),
});
