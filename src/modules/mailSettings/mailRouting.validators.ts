import { z } from 'zod';
import { ROUTING_KEYS } from './mailRouting.model';

const EMAIL = z.string().trim().toLowerCase().max(200).email('Enter a valid email address');
const unique = (a: string[]) => [...new Set(a)];

export const routingKey = z.enum(ROUTING_KEYS);
export const routingBody = z.object({
  to: z.array(EMAIL).min(1, 'Enter at least one recipient').max(20).transform(unique),
  cc: z.array(EMAIL).max(20).default([]).transform(unique),
  bcc: z.array(EMAIL).max(20).default([]).transform(unique),
  replyTo: EMAIL.nullish(),
  autoConfirm: z.boolean().default(false),
});
