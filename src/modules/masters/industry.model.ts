import { Schema, model } from 'mongoose';

/** Same trimmed, single-spaced, lower-case form for display names; the unique index on it blocks case/space duplicates. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Industry / Business Category master used by the client form. Clients store the name as text (Client.industry). */
const industrySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Industry = model('Industry', industrySchema, 'industries');
