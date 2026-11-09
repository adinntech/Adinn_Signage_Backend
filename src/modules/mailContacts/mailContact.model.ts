import { Schema, model } from 'mongoose';

/** The address book behind the To / Cc / Bcc suggestions: staff and group mailboxes people often mail. */
const mailContactSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 200 },
    name: { type: String, trim: true, maxlength: 120 },
    /** Free label such as "Accounts" or "Signage team", shown next to the address. */
    group: { type: String, trim: true, maxlength: 60 },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
mailContactSchema.index({ name: 1 });
mailContactSchema.index({ active: 1, email: 1 });
export const MailContact = model('MailContact', mailContactSchema);
