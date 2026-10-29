import { z } from 'zod';
import { objectId } from '../../common/query';
import { ROLES } from '../roles/roles';

const ids = z.array(objectId).max(50).transform((l) => [...new Set(l)]);
const emoji = z.string().trim().regex(/^[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]{1,16}$/u, 'Choose an emoji');

export const createChannelBody = z
  .object({
    kind: z.enum(['TEAM', 'PRIVATE', 'DM']),
    name: z.string().trim().min(2, 'Enter a channel name').max(60).optional(),
    topic: z.string().trim().max(200).optional(),
    memberIds: ids.default([]),
    /** TEAM only: the roles that can see it. Empty = every role. */
    allowedRoles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'DM' && v.memberIds.length !== 1) ctx.addIssue({ code: 'custom', path: ['memberIds'], message: 'Choose one person' });
    if (v.kind !== 'DM' && !v.name) ctx.addIssue({ code: 'custom', path: ['name'], message: 'Enter a channel name' });
  });

export const updateChannelBody = z.object({ name: z.string().trim().min(2).max(60).optional(), topic: z.string().trim().max(200).optional(), archived: z.boolean().optional() });
export const membersBody = z.object({ userIds: ids.refine((l) => l.length > 0, 'Choose at least one person') });

export const messagePayload = z.object({
  body: z.string().max(4000).default(''),
  parent: objectId.optional(),
  mentions: ids.default([]),
  voice: z.object({ durationSec: z.number().min(0).max(600), peaks: z.array(z.number().min(0).max(100)).max(64).default([]) }).optional(),
});
export const editBody = z.object({ body: z.string().trim().min(1, 'Message cannot be empty').max(4000) });
export const reactBody = z.object({ emoji });
export const pinBody = z.object({ messageId: objectId });

export const messagesQuery = z.object({
  before: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  thread: objectId.optional(),
});
export const searchQuery = z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(60) });
export const peopleQuery = z.object({ q: z.string().trim().max(60).optional() });
export const browseQuery = z.object({ q: z.string().trim().max(60).optional() });
export const bulkDeleteBody = z.object({ ids: z.array(objectId).min(1, 'Select at least one message').max(200).transform((l) => [...new Set(l)]) });
