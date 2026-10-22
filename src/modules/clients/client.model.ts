import { Schema, model } from 'mongoose';

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    designation: String,
    phone: String,
    alternatePhone: String,
    email: { type: String, lowercase: true, trim: true },
    alternateEmail: { type: String, lowercase: true, trim: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false },
);

/** NEW = registered through the BD "New Client" flow and not re-ordered yet; EXISTING = repeat client (clients created before the BD CRM count as EXISTING). */
export const CLIENT_TYPES = ['NEW', 'EXISTING'] as const;

const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true }, // used in project IDs
    /** Client ID shown in the BD CRM, e.g. CLI-0001. Assigned once, never reused. */
    clientNo: { type: String, unique: true, sparse: true },
    email: { type: String, lowercase: true, trim: true },
    industry: { type: String, trim: true },
    contacts: [contactSchema],
    address: String,
    city: String,
    district: String,
    state: String,
    pincode: String,
    gstin: { type: String, uppercase: true, trim: true },
    notes: String,
    clientType: { type: String, enum: CLIENT_TYPES },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
clientSchema.index({ name: 1 });
clientSchema.index({ clientType: 1, createdAt: -1 });
export const Client = model('Client', clientSchema);
