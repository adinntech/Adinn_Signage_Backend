import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { optionalMobile } from '../../common/validators/contact';
import { attachmentSchema } from '../projects/project.validators';
import { MESSAGE_TYPES } from './communication.model';

const addr = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email(),
});

export const messageCreate = z
  .object({
    type: z.enum(['EMAIL', 'NOTE', 'WHATSAPP_REF', 'FILE']),
    direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']).optional(),
    projectId: objectId.optional(),
    mode: z.enum(['reply', 'reply_all', 'forward']).optional(),
    replyToId: objectId.optional(),
    from: addr.optional(),
    to: z.array(addr).max(50).optional(),
    cc: z.array(addr).max(50).optional(),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(50000).default(''),
    attachments: z.array(attachmentSchema).max(50).optional(),
    sentAt: z.coerce.date().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode && !v.replyToId) ctx.addIssue({ code: 'custom', path: ['replyToId'], message: 'replyToId is required' });
    if (v.type === 'EMAIL' && !v.mode && !v.subject) ctx.addIssue({ code: 'custom', path: ['subject'], message: 'Subject is required' });
    if (v.type === 'NOTE' && !v.body.trim()) ctx.addIssue({ code: 'custom', path: ['body'], message: 'Note cannot be empty' });
    if (v.type === 'EMAIL' && v.direction === 'INBOUND' && !v.from) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Sender is required for received mail' });
  });

export const messageListQuery = listQuery.extend({
  projectId: objectId.optional(),
  unlinked: z.enum(['true', 'false']).optional(),
  type: z.enum(MESSAGE_TYPES).optional(),
  actioned: z.enum(['true', 'false']).optional(),
  threadId: z.string().max(40).optional(),
});

export const actionedBody = z.object({ actioned: z.boolean(), note: z.string().trim().max(500).optional() });
export const approvalRequestBody = z.object({ to: z.array(objectId).min(1).max(20), comment: z.string().trim().max(1000).optional() });
export const approvalDecisionBody = z.object({ status: z.enum(['APPROVED', 'REJECTED']), comment: z.string().trim().max(1000).optional() });

export const participantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(60).optional(),
  phone: optionalMobile,
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
  userId: objectId.optional(),
  included: z.boolean().default(true),
});
export const channelBody = z.object({
  groupName: z.string().trim().max(120).optional(),
  participants: z.array(participantSchema).max(100),
  externalGroupId: z.string().trim().max(200).optional(),
  externalGroupUrl: z.string().trim().url().max(500).optional().or(z.literal('').transform(() => undefined)),
});
export const channelKind = z.enum(['WITH_CLIENT', 'INTERNAL']);

export const createProjectFromMessage = z.object({
  clientId: objectId,
  campaign: z.string().trim().min(1).max(120),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  targetDate: z.coerce.date().optional(),
  expectedSites: z.number().int().min(0).optional(),
  coordinatorId: objectId.optional(),
});
