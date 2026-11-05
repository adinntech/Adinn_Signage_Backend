import { Schema, model } from 'mongoose';

/**
 * Vendor type choices shown in the registration form. Two are built in; Operations can add more. Every type follows one
 * of the two rule classes (`rules`): ORGANIZATION (contact person and GST mandatory) or ONE_MAN (neither).
 * Not tied to a project, so project deletes never touch it.
 */
const vendorTypeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, unique: true },
    rules: { type: String, enum: ['ORGANIZATION', 'ONE_MAN'], required: true },
    builtIn: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const VendorTypeOption = model('VendorTypeOption', vendorTypeSchema);
