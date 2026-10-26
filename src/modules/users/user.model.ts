import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES } from '../roles/roles';

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
    vendorId: { type: Schema.Types.ObjectId, index: true }, // the vendor company a VENDOR login belongs to; sees only that vendor's shops
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
  email: u.email,
  employeeId: u.employeeId ?? null,
  phone: u.phone ?? null,
  role: u.role,
  vendorId: u.vendorId ? String(u.vendorId) : null,
  isActive: u.isActive,
  authMethod: u.authMethod ?? 'PASSWORD',
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: (u as unknown as { createdAt?: Date }).createdAt ?? null,
});
