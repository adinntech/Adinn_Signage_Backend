import { Schema, model } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

export const VENDOR_TYPES = ['ONE_MAN', 'ORGANIZATION'] as const;
export const VENDOR_STATUSES = ['PENDING_KYC', 'ACTIVE', 'INACTIVE', 'BLACKLISTED'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];
export const KYC_ITEMS = ['pan', 'gst', 'bank', 'address', 'aadhaar'] as const;
/** Scans can also be filed under "other" (a missed document): they are not part of the checklist. */
export const KYC_DOC_TYPES = [...KYC_ITEMS, 'aadhaar', 'other'] as const;

/** A KYC scan: the stored-file details plus the checklist item it proves. */
const kycFileSchema = storedFileSchema.clone().add({ docType: { type: String, enum: KYC_DOC_TYPES, required: true } });

/**
 * Vendor master. A vendor is registered as PENDING_KYC, becomes ACTIVE once the KYC checklist is complete and an
 * Operations user activates it, and only ACTIVE vendors can be given shops. Rates left empty use the company rates.
 */
const vendorSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // VND-0001
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    /** Rule class: ORGANIZATION needs a contact person and a GST number, ONE_MAN does not. */
    type: { type: String, enum: VENDOR_TYPES, required: true },
    /** The vendor type the person chose (see VendorTypeOption); its rule class is `type`. */
    typeName: String,
    contactPerson: String,
    designation: String,
    mobile: { type: String, required: true },
    mobileAlt: String,
    email: { type: String, lowercase: true, trim: true },
    gstin: String,
    pan: String,
    address: String,
    pincode: String,
    state: String,
    /** City / district (the pincode lookup fills it). */
    district: String,
    /** Aadhaar number (12 digits). Needed instead of a GST number when the vendor has no GST. */
    aadhaar: String,
    /** Registered with GST? Set by the registration form; decides which documents are mandatory. Older vendors have no value. */
    hasGst: Boolean,
    serviceAreas: [String],
    skills: [String],
    bank: { accountName: String, accountNo: String, ifsc: String },
    ratePerShop: Number,
    farRatePerShop: Number,
    status: { type: String, enum: VENDOR_STATUSES, default: 'PENDING_KYC', index: true },
    statusReason: String,
    kyc: {
      pan: { type: Boolean, default: false },
      gst: { type: Boolean, default: false },
      bank: { type: Boolean, default: false },
      address: { type: Boolean, default: false },
      aadhaar: { type: Boolean, default: false },
      verifiedAt: Date,
      verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    /** Zoho Books vendor this record was filled from; the number is the digits before " - " in the Zoho contact name. */
    zohoContactId: { type: String, index: true, sparse: true },
    zohoVendorNo: String,
    /** KYC scans (category VENDOR_KYC_DOCUMENT). Operations views them, then ticks the checklist. */
    kycFiles: { type: [kycFileSchema], default: [] },
    /** Registration request mail (to Accounts) and its reply: the vendor ID they send back lets Operations proceed. */
    registration: {
      mailSentAt: Date,
      vendorIdAt: Date,
      /** The reply from Accounts read from the reply mailbox, with the vendor ID found in it (a person still confirms it). */
      reply: { messageId: String, from: String, receivedAt: Date, snippet: String, detectedVendorNo: String },
      vendorIdBy: { type: Schema.Types.ObjectId, ref: 'User' },
      /** The mail being written (Save as Draft / autosave), kept until it is sent. */
      /** createdAt / createdBy: when and by whom it was first saved; savedAt / savedBy: the last save. */
      draft: { to: [String], cc: [String], bcc: [String], subject: String, body: String, createdAt: Date, createdBy: { type: Schema.Types.ObjectId, ref: 'User' }, savedAt: Date, savedBy: { type: Schema.Types.ObjectId, ref: 'User' } },
    },
    mails: {
      type: [
        new Schema({
          to: [String],
          cc: [String],
          bcc: [String],
          from: String,
          subject: String,
          body: String,
          status: { type: String, enum: ['SENT', 'FAILED', 'SKIPPED'], required: true },
          error: String,
          requestKey: String,
          /** ADN-Signage-vnd-06122601: the ID in the subject, used to match the reply. */
          requestId: String,
          attachmentNames: [String],
          /** When and by whom the mail was first written (its draft), and its last edit before sending. */
          writtenAt: Date,
          writtenBy: { type: Schema.Types.ObjectId, ref: 'User' },
          lastEditedAt: Date,
          sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
          sentAt: { type: Date, default: Date.now },
        }),
      ],
      default: [],
    },
    notes: String,
    source: { type: String, enum: ['MANUAL', 'IMPORT', 'ZOHO'], default: 'MANUAL' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
vendorSchema.index({ mobile: 1 });
vendorSchema.index({ nameKey: 1, district: 1 });
vendorSchema.index({ name: 'text' });
export const Vendor = model('Vendor', vendorSchema);
