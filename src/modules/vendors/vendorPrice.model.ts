import { Schema, model } from 'mongoose';

/**
 * Price per shop of a Zoho vendor that is not registered yet (keyed by the Zoho contact), with a small snapshot of who the vendor is
 * (the Zoho vendor list itself is not stored: a vendor is kept here only because a cost was added to it). Registered vendors keep their
 * price on the Vendor itself; registering a Zoho vendor copies this price over, so it is typed once only.
 * Not tied to a project, so project deletes never touch it.
 */
const vendorPriceSchema = new Schema(
  {
    zohoContactId: { type: String, required: true, unique: true },
    /** Snapshot read from Zoho when the cost was saved. */
    vendorNo: String,
    name: String,
    email: String,
    mobile: String,
    gstin: String,
    pan: String,
    city: String,
    address: String,
    createdByName: String,
    contactCode: String,
    zohoStatus: { type: String, enum: ['active', 'inactive'], default: 'active' },
    zohoCreatedAt: Date,
    snapshotAt: Date,
    ratePerShop: Number,
    skills: [String],
    farRatePerShop: Number,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const VendorPrice = model('VendorPrice', vendorPriceSchema);
