import { z } from 'zod';
import type { TemplateKey } from './template.model';

/** URL slug -> template key. */
const KEYS: Record<string, TemplateKey> = { 'company-profile': 'COMPANY_PROFILE' };
export const templateKey = z
  .string()
  .refine((k) => k in KEYS, 'Unknown template')
  .transform((k) => KEYS[k]!);

export const templateBody = z.object({
  subject: z.string().trim().min(1, 'Enter the email subject').max(250),
  body: z.string().trim().min(1, 'Enter the email content').max(20000),
});
