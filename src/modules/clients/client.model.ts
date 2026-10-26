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

export const ORGANISATION_TYPES = ['PROPRIETORSHIP', 'PARTNERSHIP', 'PVT_LTD', 'LLP', 'PUBLIC_LTD', 'OTHERS'] as const;

/** One person on the Customer Onboarding Form (key management, accounts, finance). */
const onboardingPersonSchema = new Schema({ name: String, designation: String, mobile: String, email: { type: String, lowercase: true, trim: true } }, { _id: false });
const teamSchema = new Schema({ primary: { type: onboardingPersonSchema, default: null }, escalation: { type: onboardingPersonSchema, default: null } }, { _id: false });

/**
 * Customer Onboarding Form details (Lead Management > Client Registered). Kept on the company so every later order
 * reuses them. Company name, email and GST come from the client record itself.
 */
const onboardingSchema = new Schema(
  {
    organisationType: { type: String, enum: ORGANISATION_TYPES },
    organisationOther: String,
    pan: { type: String, uppercase: true, trim: true },
    msmeApplicable: Boolean,
    msmeNumber: String,
    primaryPhone: String,
    registered: {
      type: new Schema(
        { floorNo: String, buildingNo: String, premises: String, road: String, locality: String, city: String, district: String, state: String, pincode: String },
        { _id: false },
      ),
      default: null,
    },
    branchAddress: String,
    keyManagement: { type: [onboardingPersonSchema], default: [] },
    accounts: { type: teamSchema, default: null },
    finance: { type: teamSchema, default: null },
    savedAt: Date,
    savedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

/** NEW = registered through the BD "New Client" flow and not re-ordered yet; EXISTING = repeat client (clients created before the BD CRM count as EXISTING). */
export const CLIENT_TYPES = ['NEW', 'EXISTING'] as const;

const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Optional client name typed by BD, shown alongside the company name. */
    clientName: { type: String, trim: true },
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
    onboarding: { type: onboardingSchema, default: null },
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
