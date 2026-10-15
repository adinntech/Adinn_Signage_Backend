import { Schema, model } from 'mongoose';

const contactSchema = new Schema(
  { name: { type: String, required: true, trim: true }, designation: String, phone: String, email: { type: String, lowercase: true, trim: true }, isPrimary: { type: Boolean, default: false } },
  { _id: false },
);

const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true }, // used in project IDs
    contacts: [contactSchema],
    address: String,
    city: String,
    state: String,
    gstin: { type: String, uppercase: true, trim: true },
    notes: String,
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
clientSchema.index({ name: 1 });
export const Client = model('Client', clientSchema);
