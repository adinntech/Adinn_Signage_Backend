import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * A lookup copy of every Zoho vendor's details with its city, read once from Zoho (the Zoho vendor list carries no address).
 * It only serves the city filter in Vendor master; Zoho stays the source and an entry is read again after CITY_TTL.
 */
const schema = new Schema(
  {
    zohoContactId: { type: String, required: true, unique: true },
    vendorNo: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    mobile: { type: String, default: null },
    gstin: { type: String, default: null },
    pan: { type: String, default: null },
    contactCode: { type: String, default: null },
    zohoStatus: { type: String, enum: ['active', 'inactive'], default: 'active' },
    zohoCreatedAt: { type: Date, default: null },
    createdByName: { type: String, default: null },
    /** The city: Zoho's own billing city, or else the last part of the address ("..., Ellis Nagar, Madurai - 625010" gives Madurai). */
    city: { type: String, default: null, index: true },
    address: { type: String, default: null },
    state: { type: String, default: null },
    /** Every address of the vendor from Zoho as separate parts. */
    addresses: { type: [new Schema({ kind: String, address: String, street2: String, city: String, state: String, zip: String }, { _id: false })], default: [] },
    checkedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

export type ZohoVendorCityDoc = InferSchemaType<typeof schema>;
export const ZohoVendorCity = model<ZohoVendorCityDoc>('ZohoVendorCity', schema);
