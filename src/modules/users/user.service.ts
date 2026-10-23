import bcrypt from 'bcryptjs';
import type { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta, parseSort, type Actor } from '../../common/query';
import { diff, recordAudit } from '../audit/audit.service';
import { credentialFields } from '../auth/auth.service';
import { RefreshToken } from '../auth/refreshToken.model';
import { ROLES, type Role } from '../roles/roles';
import { User, toPublicUser, type UserDoc } from './user.model';
import type { changeCredentialSchema, createUserSchema, lookupQuery, resetCredentialSchema, updateUserSchema, userListQuery } from './user.validators';

const ALIVE = { deletedAt: null };
const FIELDS = ['name', 'email', 'phone', 'employeeId', 'role', 'isActive'];

const revokeSessions = (userId: Types.ObjectId) => RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });

async function getAlive(id: string) {
  const user = await User.findOne({ _id: id, ...ALIVE });
  if (!user) throw AppError.notFound('User not found');
  return user;
}

/** Another active super admin must always exist, so the last one cannot be demoted, disabled or deleted. */
async function assertNotLastAdmin(user: { _id: Types.ObjectId; role: string; isActive: boolean }) {
  if (user.role !== 'SUPER_ADMIN' || !user.isActive) return;
  const others = await User.countDocuments({ _id: { $ne: user._id }, role: 'SUPER_ADMIN', isActive: true, ...ALIVE });
  if (others === 0) throw AppError.conflict('At least one active super admin must remain');
}

async function assertUnique(fields: { email?: string | undefined; phone?: string | undefined; employeeId?: string | undefined }, exceptId?: string) {
  const or = (['email', 'phone', 'employeeId'] as const).filter((k) => fields[k]).map((k) => ({ [k]: fields[k] }));
  if (!or.length) return;
  const clash = await User.findOne({ ...ALIVE, ...(exceptId ? { _id: { $ne: exceptId } } : {}), $or: or }).lean();
  if (!clash) return;
  const field = fields.email && clash.email === fields.email ? 'email' : fields.employeeId && clash.employeeId === fields.employeeId ? 'employee ID' : 'phone number';
  throw AppError.conflict(`Another user already has this ${field}`);
}

export async function listUsers(q: z.infer<typeof userListQuery>) {
  const filter: Record<string, unknown> = { ...ALIVE };
  if (q.role) filter.role = q.role;
  if (q.isActive) filter.isActive = q.isActive === 'true';
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: re }, { email: re }, { employeeId: re }, { phone: re }];
  }
  const [items, total] = await Promise.all([
    User.find(filter)
      .sort(parseSort(q.sort, ['name', 'email', 'role', 'createdAt', 'lastLoginAt'], '-createdAt'))
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    User.countDocuments(filter),
  ]);
  return { items: items.map((u) => toPublicUser(u as unknown as UserDoc)), meta: pageMeta(q.page, q.limit, total) };
}

export async function getUser(id: string) {
  return toPublicUser((await getAlive(id)) as unknown as UserDoc);
}

export async function createUser(input: z.infer<typeof createUserSchema>, actor: Actor) {
  await assertUnique(input);
  const user = await User.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    employeeId: input.employeeId,
    role: input.role,
    ...(await credentialFields(input)),
  });
  await recordAudit({ actor, action: 'CREATE', entity: 'User', entityId: user._id });
  return toPublicUser(user as unknown as UserDoc);
}

export async function updateUser(id: string, patch: z.infer<typeof updateUserSchema>, actor: Actor) {
  const user = await getAlive(id);
  const isSelf = id === actor.id;
  if (isSelf && (patch.role !== undefined || patch.isActive === false)) {
    throw AppError.conflict('You cannot change your own role or disable your own account');
  }
  if ((patch.role !== undefined && patch.role !== user.role) || patch.isActive === false) await assertNotLastAdmin(user);
  await assertUnique(patch, id);

  const before = user.toObject();
  user.set(patch);
  // Role changes can move someone to a different app or permission set: end their sessions.
  const roleChanged = patch.role !== undefined && patch.role !== before.role;
  await user.save();
  if (roleChanged || patch.isActive === false) await revokeSessions(user._id);
  await recordAudit({ actor, action: 'UPDATE', entity: 'User', entityId: user._id, changes: diff(before as never, patch as never, FIELDS) });
  return toPublicUser(user as unknown as UserDoc);
}

/** Admin sets a new MPIN or password (the "forgot credential" path). Clears any lockout and signs the user out everywhere. */
export async function resetCredential(id: string, input: z.infer<typeof resetCredentialSchema>, actor: Actor) {
  const user = await getAlive(id);
  user.set({ ...(await credentialFields(input)), failedLogins: 0, lockedUntil: null });
  await user.save();
  await revokeSessions(user._id);
  await recordAudit({ actor, action: 'RESET_CREDENTIAL', entity: 'User', entityId: user._id });
}

export async function changeOwnCredential(actor: Actor, input: z.infer<typeof changeCredentialSchema>) {
  const user = await User.findOne({ _id: actor.id, ...ALIVE }).select('+mpinHash +passwordHash');
  if (!user) throw AppError.unauthorized('Account unavailable');
  const stored = user.authMethod === 'MPIN' ? user.mpinHash : user.passwordHash;
  if (!stored || !(await bcrypt.compare(input.currentSecret, stored))) {
    throw new AppError(400, 'INVALID_CREDENTIALS', 'Your current MPIN or password is incorrect');
  }
  user.set(await credentialFields(input));
  await user.save();
  await revokeSessions(user._id); // other devices must sign in again
  await recordAudit({ actor, action: 'CHANGE_CREDENTIAL', entity: 'User', entityId: user._id });
}

/** Soft delete. The original email is kept in deletedEmail so the address and IDs can be registered again. */
export async function deleteUser(id: string, actor: Actor) {
  if (id === actor.id) throw AppError.conflict('You cannot delete your own account');
  const user = await getAlive(id);
  await assertNotLastAdmin(user);
  user.set({ deletedAt: new Date(), isActive: false, deletedEmail: user.email, email: `deleted-${id}@deleted.invalid`, employeeId: undefined, phone: undefined });
  await user.save();
  await revokeSessions(user._id);
  await recordAudit({ actor, action: 'DELETE', entity: 'User', entityId: user._id });
}

/** Minimal directory for owner/approver/participant pickers. */
export async function lookupUsers(q: z.infer<typeof lookupQuery>) {
  const roles = (q.roles?.split(',') ?? []).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  const filter: Record<string, unknown> = { isActive: true, ...ALIVE };
  if (roles.length) filter.role = { $in: roles };
  if (q.q) filter.name = new RegExp(escapeRegex(q.q), 'i');
  return User.find(filter).select('name role email phone').sort({ name: 1 }).limit(100).lean();
}
