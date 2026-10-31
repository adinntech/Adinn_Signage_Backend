import { z } from 'zod';
import { checkCredential, credentialShape, emailRule, employeeIdRule, nameRule, phoneRule } from '../../common/validators/credentials';
import { LOGIN_ROLE_KEYS, ROLES, SELF_REGISTER_ROLES } from '../roles/roles';

// identifier is an email or an employee ID. email is accepted for older clients.
// The credential is an MPIN or a password, matching how the account was registered.
export const loginSchema = z
  .object({
    identifier: z.string().trim().min(1, 'Email or Employee ID is required').max(120).optional(),
    email: z.string().trim().min(1).max(120).optional(),
    mpin: z.string().regex(/^\d{4}$/, 'MPIN must be 4 digits').optional(),
    password: z.string().min(1).max(200).optional(),
    // The role card the person picked. If given, the account must have been registered under that role.
    loginRole: z.enum(LOGIN_ROLE_KEYS).optional(),
    // Which app is signing in; roles are restricted to their platform (see ROLE_PLATFORMS). Optional for older clients.
    platform: z.enum(['web', 'mobile']).optional(),
    remember: z.boolean().default(true),
    device: z.string().max(100).optional(),
  })
  .transform((v, ctx) => {
    const identifier = (v.identifier ?? v.email ?? '').toLowerCase();
    if (!identifier) {
      ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'Email or Employee ID is required' });
      return z.NEVER;
    }
    if (identifier.includes('@') && !z.email().safeParse(identifier).success) {
      ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'Enter a valid email address' });
      return z.NEVER;
    }
    if (!v.mpin && !v.password) {
      ctx.addIssue({ code: 'custom', path: ['mpin'], message: 'MPIN or password is required' });
      return z.NEVER;
    }
    return { identifier, mpin: v.mpin, password: v.password, loginRole: v.loginRole, platform: v.platform, remember: v.remember, device: v.device };
  });

const identifierRule = z
  .string()
  .trim()
  .min(1, 'Email or Employee ID is required')
  .max(120)
  .transform((v) => v.toLowerCase());

export const forgotRequestSchema = z.object({ identifier: identifierRule });
export const forgotConfirmSchema = z.object({
  identifier: identifierRule,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  // Checked against the account's own method (MPIN or password) in the service.
  authMethod: z.enum(['PASSWORD', 'MPIN']).optional(),
  newSecret: z.string().min(1, 'Enter the new MPIN or password').max(100),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(1).optional() });
export const logoutSchema = refreshSchema;

/** Self-registration: name, email, phone, employee ID and either a 4-digit MPIN or a password. All required. */
export const registerSchema = z
  .object({
    name: nameRule,
    email: emailRule,
    phone: phoneRule,
    employeeId: employeeIdRule,
    role: z.enum(ROLES),
    platform: z.enum(['web', 'mobile']),
    ...credentialShape,
    remember: z.boolean().default(true),
    device: z.string().max(100).optional(),
  })
  .superRefine((v, ctx) => {
    checkCredential(v, ctx);
    if (!SELF_REGISTER_ROLES[v.platform].includes(v.role)) {
      ctx.addIssue({ code: 'custom', path: ['role'], message: 'This role cannot be registered from this app' });
    }
  });
