import { Schema, model } from 'mongoose';

/**
 * Price per shop of a Zoho vendor that is not registered yet (keyed by the Zoho contact). Registered vendors keep their
 * price on the Vendor itself; registering a Zoho vendor copies this price over, so it is typed once only.
 * Not tied to a project, so project deletes never touch it.
 */
const vendorPriceSchema = new Schema(
  {
    zohoContactId: { type: String, required: true, unique: true },
    ratePerShop: Number,
    skills: [String],
    farRatePerShop: Number,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const VendorPrice = model('VendorPrice', vendorPriceSchema);
