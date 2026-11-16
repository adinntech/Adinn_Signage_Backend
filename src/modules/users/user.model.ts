import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES, userTypeOf, type Role } from '../roles/roles';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    employeeId: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    // Either a 4-digit MPIN or a password; only the hash matching authMethod is stored.
    authMethod: { type: String, enum: ['PASSWORD', 'MPIN'] },
    mpinHash: { type: String, select: false },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
    isActive: { type: Boolean, default: true },
    /** Set on a vendor login the office created with a default MPIN: the app forces a new MPIN at first sign-in. */
    mustChangeMpin: { type: Boolean, default: false },
    /** The email is a made-up address (vendor has none in Zoho): no mail is ever sent to it, MPIN reset goes through Recce Operations. */
    emailIsPlaceholder: { type: Boolean, default: false },
    vendorId: { type: Schema.Types.ObjectId, index: true }, // the vendor company a VENDOR login belongs to; sees only that vendor's shops
    // Forgot MPIN / password: a hashed 6-digit code emailed to the user. Single use, short-lived, limited attempts.
    resetCodeHash: { type: String, select: false },
    resetCodeExpiresAt: { type: Date, select: false },
    resetCodeAttempts: { type: Number, default: 0, select: false },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    deletedAt: Date,
    deletedEmail: String, // original email of a soft-deleted user, so the address can be registered again
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: import('mongoose').Types.ObjectId };
export const User = model('User', userSchema);

export const toPublicUser = (u: UserDoc) => ({
  id: String(u._id),
  name: u.name,
  email: u.emailIsPlaceholder ? null : u.email,
  hasEmail: !u.emailIsPlaceholder,
  mustChangeMpin: !!u.mustChangeMpin,
  employeeId: u.employeeId ?? null,
  phone: u.phone ?? null,
  role: u.role,
  userType: userTypeOf(u.role as Role),
  vendorId: u.vendorId ? String(u.vendorId) : null,
  isActive: u.isActive,
  authMethod: u.authMethod ?? 'PASSWORD',
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: (u as unknown as { createdAt?: Date }).createdAt ?? null,
});
