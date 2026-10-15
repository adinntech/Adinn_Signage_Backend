import { z } from 'zod';
import { checkCredential, credentialShape, emailRule, employeeIdRule, nameRule, phoneRule } from '../../common/validators/credentials';
import { listQuery } from '../../common/query';
import { ROLES } from '../roles/roles';

/** Admin creates an account directly (any role). */
export const createUserSchema = z
  .object({
    name: nameRule,
    email: emailRule,
    phone: phoneRule,
    employeeId: employeeIdRule,
    role: z.enum(ROLES),
    ...credentialShape,
  })
  .superRefine(checkCredential);

export const updateUserSchema = z
  .object({
    name: nameRule,
    email: emailRule,
    phone: phoneRule,
    employeeId: employeeIdRule,
    role: z.enum(ROLES),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** Admin sets a new MPIN or password for someone who forgot theirs. */
export const resetCredentialSchema = z.object(credentialShape).superRefine(checkCredential);

/** A signed-in user changes their own MPIN or password. */
export const changeCredentialSchema = z
  .object({ currentSecret: z.string().min(1, 'Enter your current MPIN or password'), ...credentialShape })
  .superRefine(checkCredential);

export const userListQuery = listQuery.extend({
  role: z.enum(ROLES).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export const lookupQuery = z.object({ roles: z.string().optional(), q: z.string().max(60).optional() });
