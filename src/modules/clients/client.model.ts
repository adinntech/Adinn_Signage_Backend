import { Schema, model } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

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

/** Extra details BD adds per client: a free label with its value (the API requires the label, except on a draft). */
const customFieldSchema = new Schema({ label: { type: String, trim: true }, value: { type: String, trim: true } }, { _id: false });

/** DRAFT = an Add Client form saved part-way: no Client ID, not listed as a client or offered in pickers until saved. */
export const CLIENT_STATUSES = ['ACTIVE', 'INACTIVE', 'DRAFT'] as const;
function notDraft(this: { status?: string }) {
  return this.status !== 'DRAFT';
}

/** NEW = registered through the BD "New Client" flow and not re-ordered yet; EXISTING = repeat client (clients created before the BD CRM count as EXISTING). */
export const CLIENT_TYPES = ['NEW', 'EXISTING'] as const;
export const CLIENT_SOURCES = ['CRM', 'ZOHO'] as const;

const clientSchema = new Schema(
  {
    // Required except on a draft. Typed as required: every record other code reads (non-draft) has a name.
    name: { type: String, required: notDraft as unknown as true, trim: true },
    /** Optional client name typed by BD, shown alongside the company name. */
    clientName: { type: String, trim: true },
    // used in project IDs; a draft carries a placeholder (DRAFT-...) until it is saved as a client
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    /** Client ID shown in the BD CRM, e.g. CLI-0001. Assigned once, never reused. */
    clientNo: { type: String, unique: true, sparse: true },
    email: { type: String, lowercase: true, trim: true },
    /** Company phone number. */
    phone: { type: String, trim: true },
    industry: { type: String, trim: true },
    contacts: [contactSchema],
    address: String,
    city: String,
    district: String,
    state: String,
    pincode: String,
    gstin: { type: String, uppercase: true, trim: true },
    /** GST certificate scans / PDFs (category CLIENT_GST_CERTIFICATE). */
    gstCertificates: { type: [storedFileSchema], default: [] },
    customFields: { type: [customFieldSchema], default: [] },
    notes: String,
    onboarding: { type: onboardingSchema, default: null },
    clientType: { type: String, enum: CLIENT_TYPES },
    /** CRM = registered in Client Management; ZOHO = brought in from the Zoho customer list (existing clients). */
    source: { type: String, enum: CLIENT_SOURCES, default: 'CRM' },
    /** Zoho customer id (Books contact_id / CRM Account id) once this client is linked to Zoho. */
    zohoId: { type: String, trim: true },
    status: { type: String, enum: CLIENT_STATUSES, default: 'ACTIVE', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
clientSchema.index({ name: 1 });
clientSchema.index({ clientType: 1, createdAt: -1 });
clientSchema.index({ zohoId: 1 }, { sparse: true });
export const Client = model('Client', clientSchema);
