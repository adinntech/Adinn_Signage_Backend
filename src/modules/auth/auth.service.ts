import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { User, toPublicUser, type UserDoc } from '../users/user.model';
import { RefreshToken } from './refreshToken.model';
import { LOGIN_ROLE_GROUPS, ROLE_HOME, ROLE_PLATFORMS, permissionsFor, type LoginRoleKey, type Platform, type Role } from '../roles/roles';

export interface AccessPayload {
  sub: string;
  role: Role;
}
export interface ClientMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
  device?: string | undefined;
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');
// Without "remember me" the refresh token lives 24h and the web cookie is a browser-session cookie.
const refreshExpiry = (remember: boolean) =>
  new Date(Date.now() + (remember ? env.REFRESH_TOKEN_TTL_DAYS : 1) * 86400_000);

// Constant-time-ish dummy hash so unknown emails cost the same as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
export const hashMpin = (p: string) => bcrypt.hash(p, 12);

/** Fields to store for a new credential; the other secret is cleared so only one can ever work. */
export const credentialFields = async (v: { authMethod: 'PASSWORD' | 'MPIN'; password?: string | undefined; mpin?: string | undefined }) =>
  v.authMethod === 'MPIN'
    ? { authMethod: 'MPIN' as const, mpinHash: await hashMpin(v.mpin!), passwordHash: undefined }
    : { authMethod: 'PASSWORD' as const, passwordHash: await hashPassword(v.password!), mpinHash: undefined };

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export const findByIdentifier = (identifier: string) =>
  User.findOne({
    ...(identifier.includes('@') ? { email: identifier.toLowerCase() } : { employeeId: identifier.toUpperCase() }),
    deletedAt: null,
  });

export interface LoginInput {
  identifier: string;
  mpin?: string | undefined;
  password?: string | undefined; // legacy accounts only
  loginRole?: LoginRoleKey | undefined;
  platform?: Platform | undefined;
  remember: boolean;
}

/** Throws unless the role may use this app. Shared by login and registration. */
export function assertPlatform(role: Role, platform?: Platform) {
  if (platform && !ROLE_PLATFORMS[role].includes(platform)) {
    throw new AppError(
      403,
      'PLATFORM_NOT_ALLOWED',
      platform === 'web'
        ? 'Recce and vendor accounts sign in on the ADINN Recce mobile app, not the web CRM.'
        : 'This account signs in on the web CRM, not the mobile app.',
    );
  }
}

export async function login(input: LoginInput, meta: ClientMeta) {
  const user = await findByIdentifier(input.identifier).select('+passwordHash +mpinHash');
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes or ask an admin to reset your MPIN.`);
  }

  // The credential must match how the account was set up (accounts without a stored method use a password).
  const usesPassword = !!user && user.authMethod !== 'MPIN';
  const supplied = usesPassword ? input.password : input.mpin;
  const stored = usesPassword ? user?.passwordHash : user?.mpinHash;
  const valid = await bcrypt.compare(supplied ?? '', stored ?? DUMMY_HASH);

  if (!user || !valid) {
    if (user) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
        user.failedLogins = 0;
      }
      await user.save();
    }
    throw AppError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  // The role card must match the registered role. Checked only after the credential is right, so it reveals nothing
  // to someone guessing, and it does not count as a failed attempt.
  if (input.loginRole && !LOGIN_ROLE_GROUPS[input.loginRole].includes(user.role as Role)) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }
  if (!user.isActive) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
  assertPlatform(user.role as Role, input.platform);

  user.lastLoginAt = new Date();
  user.failedLogins = 0;
  user.lockedUntil = null;
  await user.save();
  return issueSession(user as unknown as UserDoc, crypto.randomUUID(), meta, input.remember);
}

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  employeeId: string;
  role: Role;
  authMethod: 'PASSWORD' | 'MPIN';
  password?: string | undefined;
  mpin?: string | undefined;
  platform: Platform;
  remember: boolean;
}

/**
 * Self-registration. The validator already limited the role to what this app may register.
 * The account is active immediately and the caller is signed in straight away.
 */
/** The first super admin may register themselves; after that admin accounts are created by an existing admin. */
export const adminRegistrationOpen = async () => (await User.countDocuments({ role: 'SUPER_ADMIN', isActive: true, deletedAt: null })) === 0;

export async function register(input: RegisterInput, meta: ClientMeta) {
  if (input.role === 'SUPER_ADMIN' && !(await adminRegistrationOpen())) {
    throw new AppError(403, 'ADMIN_EXISTS', 'An admin already exists. Ask them to create your account.');
  }
  const clash = await User.findOne({
    deletedAt: null,
    $or: [{ email: input.email }, { employeeId: input.employeeId }, { phone: input.phone }],
  }).lean();
  if (clash) {
    const field = clash.email === input.email ? 'email' : clash.employeeId === input.employeeId ? 'employee ID' : 'phone number';
    throw AppError.conflict(`An account with this ${field} already exists`);
  }
  const user = await User.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    employeeId: input.employeeId,
    role: input.role,
    ...(await credentialFields(input)),
    lastLoginAt: new Date(),
  });
  return issueSession(user as unknown as UserDoc, crypto.randomUUID(), meta, input.remember);
}

/** Role always comes from the account record, never from anything the client sent. */
const sessionUser = (user: UserDoc) => ({
  ...toPublicUser(user),
  permissions: permissionsFor(user.role as Role),
  home: ROLE_HOME[user.role as Role],
});

function signAccess(user: UserDoc) {
  const payload: AccessPayload = { sub: String(user._id), role: user.role as Role };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccess(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  } catch {
    throw AppError.unauthorized('Invalid or expired access token', 'TOKEN_INVALID');
  }
}

async function issueSession(user: UserDoc, family: string, meta: ClientMeta, remember: boolean) {
  const refreshToken = newRefreshToken();
  await RefreshToken.create({
    user: user._id,
    tokenHash: sha256(refreshToken),
    family,
    remember,
    expiresAt: refreshExpiry(remember),
    userAgent: meta.userAgent,
    ip: meta.ip,
    device: meta.device,
  });
  return {
    accessToken: signAccess(user),
    refreshToken,
    remember,
    user: sessionUser(user),
  };
}

export async function refresh(token: string, meta: ClientMeta) {
  const hash = sha256(token);
  const stored = await RefreshToken.findOne({ tokenHash: hash });
  if (!stored) throw AppError.unauthorized('Invalid refresh token', 'REFRESH_INVALID');

  if (stored.revokedAt) {
    // Re-use of a rotated token: assume theft, kill the whole chain.
    await RefreshToken.updateMany({ family: stored.family, revokedAt: null }, { revokedAt: new Date() });
    throw AppError.unauthorized('Refresh token re-use detected', 'REFRESH_REUSED');
  }
  if (stored.expiresAt < new Date()) throw AppError.unauthorized('Refresh token expired', 'REFRESH_EXPIRED');

  const user = await User.findById(stored.user);
  if (!user || !user.isActive || user.deletedAt) {
    throw AppError.unauthorized('Account unavailable', 'ACCOUNT_DISABLED');
  }

  // Atomic claim so two concurrent refreshes cannot both succeed.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: stored._id, revokedAt: null },
    { revokedAt: new Date() },
  );
  if (!claimed) throw AppError.unauthorized('Refresh token already used', 'REFRESH_REUSED');

  const session = await issueSession(user as unknown as UserDoc, stored.family, meta, stored.remember !== false);
  await RefreshToken.updateOne({ _id: stored._id }, { replacedByHash: sha256(session.refreshToken) });
  return session;
}

export async function logout(token?: string) {
  if (!token) return;
  const stored = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (stored) await RefreshToken.updateMany({ family: stored.family, revokedAt: null }, { revokedAt: new Date() });
}

export async function getMe(userId: string) {
  const user = await User.findById(userId);
  if (!user || !user.isActive || user.deletedAt) throw AppError.unauthorized('Account unavailable');
  return sessionUser(user as unknown as UserDoc);
}
