import { Schema, model } from 'mongoose';

export const VENDOR_TYPES = ['ONE_MAN', 'ORGANIZATION'] as const;
export const VENDOR_STATUSES = ['PENDING_KYC', 'ACTIVE', 'INACTIVE', 'BLACKLISTED'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];
export const KYC_ITEMS = ['pan', 'gst', 'bank', 'address'] as const;

/**
 * Vendor master. A vendor is registered as PENDING_KYC, becomes ACTIVE once the KYC checklist is complete and an
 * Operations user activates it, and only ACTIVE vendors can be given shops. Rates left empty use the company rates.
 */
const vendorSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // VND-0001
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    type: { type: String, enum: VENDOR_TYPES, required: true },
    contactPerson: String,
    mobile: { type: String, required: true },
    mobileAlt: String,
    email: { type: String, lowercase: true, trim: true },
    gstin: String,
    pan: String,
    address: String,
    district: String,
    serviceAreas: [String],
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
      verifiedAt: Date,
      verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    notes: String,
    source: { type: String, enum: ['MANUAL', 'IMPORT'], default: 'MANUAL' },
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
