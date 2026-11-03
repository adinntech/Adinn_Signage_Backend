import { Schema, model } from 'mongoose';

/** Skills a vendor can be given in Vendor price management (e.g. Flex printing). Anyone with vendor access can add a new one; not tied to a project. */
const vendorSkillSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const VendorSkill = model('VendorSkill', vendorSkillSchema);
