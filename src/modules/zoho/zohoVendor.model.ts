import { Schema, model } from 'mongoose';

/**
 * Copy of the vendor list in Zoho Books ("Zoho vendors"). Reference data only: a row here is NOT a registered vendor.
 * A vendor becomes part of the vendor master (Vendor) only when Operations registers it, which links it back through
 * `Vendor.zohoContactId`. Rows are refreshed by the sync and are not tied to any project, so project deletes never touch them.
 */
const zohoVendorSchema = new Schema(
  {
    zohoContactId: { type: String, required: true, unique: true },
    /** The digits before " - " in the Zoho contact name; some Zoho vendors have none. */
    vendorNo: { type: String, index: true },
    name: { type: String, required: true },
    email: String,
    /** Only a valid 10-digit mobile; Zoho free text that fails the check is dropped. */
    mobile: String,
    gstin: String,
    pan: String,
    /** Billing city and address, read from the Zoho detail call (the list call does not carry them). */
    city: String,
    address: String,
    /** Who created the vendor in Zoho, and when. */
    createdByName: String,
    zohoCreatedAt: Date,
    /** zohoModifiedAt the detail fields were read at; the sync re-reads details only when it differs. */
    detailModifiedAt: Date,
    detailAt: Date,
    zohoStatus: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    zohoModifiedAt: Date,
    syncedAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);
zohoVendorSchema.index({ name: 1 });
export const ZohoVendor = model('ZohoVendor', zohoVendorSchema);
