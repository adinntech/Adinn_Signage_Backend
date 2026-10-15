import { Schema, model, type Types } from 'mongoose';

// One document per issued refresh token. `family` groups a rotation chain so that
// re-use of an already-rotated token revokes the whole chain.
const refreshTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    remember: { type: Boolean, default: true },
    revokedAt: Date,
    replacedByHash: String,
    userAgent: String,
    ip: String,
    device: String,
  },
  { timestamps: true },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface RefreshTokenDoc {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  revokedAt?: Date | null;
}
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
