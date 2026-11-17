import type { Types } from 'mongoose';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { hashMpin } from '../auth/auth.service';
import { RefreshToken } from '../auth/refreshToken.model';
import { Vendor } from '../vendors/vendor.model';
import { User, toPublicUser, type UserDoc } from './user.model';

const ALIVE = { deletedAt: null };

/** Last 4 digits of the vendor ID (Zoho vendor number): the default MPIN and the end of the username. */
export const vendorIdTail = (vendorNo?: string | null) => {
  const digits = String(vendorNo ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

/** "S R Glass" + vendor ID 11001 -> "srglass1001" (letters of the name, at most 10, then the last 4 digits). */
export const vendorUsernameBase = (name: string, tail: string) => {
  const letters = name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10) || 'vendor';
  return `${letters}${tail}`;
};

const isDuplicateKey = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;

/** The first free username: srglass1001, then srglass1001-2, -3 ... when another vendor already took it. */
async function freeUsername(base: string) {
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await User.exists({ employeeId: candidate.toUpperCase() }))) return candidate;
  }
  throw AppError.conflict('Could not find a free username for this vendor');
}

export interface VendorLoginResult {
  created: boolean;
  /** Why no login was made (no vendor ID yet): the vendor can still be given shops; the login follows once the ID is known. */
  skipped?: 'NO_VENDOR_ID';
  user: ReturnType<typeof toPublicUser> | null;
  /** Shown once, only when the login was just created. */
  username?: string;
  defaultMpinHint?: string;
}

/**
 * Makes sure a vendor company has a mobile login. Safe to call any number of times (every job, every assignment):
 * a vendor that already has a login is left alone, so a second job never creates a second account or resets the MPIN.
 * Username = vendor name letters + last 4 digits of the vendor ID; MPIN = last 4 digits of the vendor ID (changed at first sign-in).
 * A vendor with no email in Zoho gets a placeholder address that no mail is ever sent to.
 */
export async function ensureVendorLogin(vendorId: string | Types.ObjectId, actor: Actor): Promise<VendorLoginResult> {
  const have = await User.findOne({ role: 'VENDOR', vendorId, ...ALIVE });
  if (have) return { created: false, user: toPublicUser(have as unknown as UserDoc) };

  const vendor = await Vendor.findOne({ _id: vendorId, ...ALIVE }).select('name mobile email zohoVendorNo').lean();
  if (!vendor) throw AppError.notFound('Vendor not found');
  const tail = vendorIdTail(vendor.zohoVendorNo);
  if (!tail) return { created: false, skipped: 'NO_VENDOR_ID', user: null };

  for (let attempt = 0; attempt < 3; attempt++) {
    const username = await freeUsername(vendorUsernameBase(vendor.name, tail));
    const realEmail = vendor.email && !(await User.exists({ email: vendor.email })) ? vendor.email : null;
    const phoneTaken = vendor.mobile ? await User.exists({ phone: vendor.mobile }) : true;
    try {
      const user = await User.create({
        name: vendor.name,
        email: realEmail ?? `${username.toLowerCase()}@vendor.invalid`,
        emailIsPlaceholder: !realEmail,
        employeeId: username,
        ...(phoneTaken ? {} : { phone: vendor.mobile }),
        role: 'VENDOR',
        vendorId,
        authMethod: 'MPIN',
        mpinHash: await hashMpin(tail),
        mustChangeMpin: true,
      });
      await recordAudit({ actor, action: 'CREATE', entity: 'User', entityId: user._id, reason: `Vendor login ${user.employeeId} created automatically for ${vendor.name}` });
      return { created: true, user: toPublicUser(user as unknown as UserDoc), username: String(user.employeeId), defaultMpinHint: 'Last 4 digits of the vendor ID' };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // Another request made the login (or took the username) a moment ago: look again, then retry with a fresh username.
      const again = await User.findOne({ role: 'VENDOR', vendorId, ...ALIVE });
      if (again) return { created: false, user: toPublicUser(again as unknown as UserDoc) };
    }
  }
  throw AppError.conflict('Could not create the vendor login. Try again');
}

/** Same as ensureVendorLogin, but never throws: used inside assignment flows, where a login problem must not block the work. */
export async function ensureVendorLoginQuietly(vendorId: string | Types.ObjectId, actor: Actor) {
  try {
    return await ensureVendorLogin(vendorId, actor);
  } catch (e) {
    console.error('Vendor login could not be created:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Recce Operations resets a vendor's MPIN back to the last 4 digits of the vendor ID. The vendor must choose a new one at
 * the next sign-in. Clears any lockout and signs the vendor out of every device.
 */
export async function resetVendorLoginMpin(vendorId: string, userId: string, actor: Actor) {
  const user = await User.findOne({ _id: userId, role: 'VENDOR', vendorId, ...ALIVE });
  if (!user) throw AppError.notFound('Login not found for this vendor');
  const vendor = await Vendor.findOne({ _id: vendorId, ...ALIVE }).select('zohoVendorNo').lean();
  const tail = vendorIdTail(vendor?.zohoVendorNo);
  if (!tail) throw AppError.conflict('This vendor has no vendor ID yet, so there is no default MPIN. Enter the vendor ID first');
  user.set({ authMethod: 'MPIN', mpinHash: await hashMpin(tail), passwordHash: undefined, mustChangeMpin: true, failedLogins: 0, lockedUntil: null });
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
  await recordAudit({ actor, action: 'RESET_CREDENTIAL', entity: 'User', entityId: user._id, reason: 'Vendor MPIN reset to the default by Recce Operations' });
  return { user: toPublicUser(user as unknown as UserDoc), defaultMpinHint: 'Last 4 digits of the vendor ID' };
}
