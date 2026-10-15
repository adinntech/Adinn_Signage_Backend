import { z } from 'zod';

// Field rules shared by registration (auth module) and user management (users module).

const WEAK_MPINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '3210']);

export const mpinRule = z
  .string()
  .regex(/^\d{4}$/, 'MPIN must be exactly 4 digits')
  .refine((v) => !WEAK_MPINS.has(v), 'Choose a less obvious MPIN');

export const passwordRule = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(100)
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

export const nameRule = z.string().trim().min(2, 'Enter the full name').max(80);
export const emailRule = z.email('Enter a valid email address').trim().toLowerCase();
export const employeeIdRule = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{2,30}$/, 'Enter a valid employee ID')
  .transform((v) => v.toUpperCase());
export const phoneRule = z
  .string()
  .trim()
  .regex(/^\d{10}$/, 'Phone number must be exactly 10 digits');

/** A credential is either a password or a 4-digit MPIN, never both. */
export const credentialShape = {
  authMethod: z.enum(['PASSWORD', 'MPIN']),
  password: z.string().optional(),
  mpin: z.string().optional(),
};

export function checkCredential(
  v: { authMethod: 'PASSWORD' | 'MPIN'; password?: string | undefined; mpin?: string | undefined },
  ctx: z.RefinementCtx,
) {
  const field = v.authMethod === 'MPIN' ? 'mpin' : 'password';
  const rule = v.authMethod === 'MPIN' ? mpinRule : passwordRule;
  const r = rule.safeParse(v[field] ?? '');
  if (!r.success) ctx.addIssue({ code: 'custom', path: [field], message: r.error.issues[0]?.message ?? 'Invalid value' });
}
