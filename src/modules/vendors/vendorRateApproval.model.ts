import { Schema, model } from 'mongoose';

export const RATE_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'NOT_APPROVED', 'REPLACED'] as const;
export type RateApprovalStatus = (typeof RATE_APPROVAL_STATUSES)[number];

const rates = new Schema({ ratePerShop: Number, farRatePerShop: Number }, { _id: false });

/**
 * A vendor cost typed above the company rate (Admin > Cost Rates) is held here until the approver answers the mail.
 * APPROVED: the typed cost is applied. NOT_APPROVED: the company rate is applied instead. REPLACED: a newer request for the
 * same vendor took over before this one was answered.
 */
const vendorRateApprovalSchema = new Schema(
  {
    /** ADN-Signage-vap-ddmmyy01: in the mail subject; the reply is matched by it. */
    requestId: { type: String, required: true, unique: true },
    zohoContactId: { type: String, required: true, index: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    vendorName: String,
    vendorNo: String,
    /** Who the vendor is (from Zoho or the registered vendor) at the time of the request: shown in the list and sent in the mail. */
    info: new Schema({ email: String, mobile: String, gstin: String, pan: String, city: String, address: String, createdByName: String, contactCode: String }, { _id: false }),
    /** What was typed. */
    requested: { type: rates, required: true },
    /** The company rate at that moment: the most the approver is asked to allow without a yes. */
    limit: { type: rates, required: true },
    /** What the vendor had before. */
    current: { type: rates, required: true },
    status: { type: String, enum: RATE_APPROVAL_STATUSES, default: 'PENDING', index: true },
    /** What was finally applied (the typed cost or the company rate). */
    applied: rates,
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: String,
    to: [String],
    cc: [String],
    bcc: [String],
    sentAt: Date,
    decidedAt: Date,
    decidedBy: String,
    reply: new Schema({ messageId: String, from: String, receivedAt: Date, snippet: String }, { _id: false }),
    /** Every reply read, with what was made of it (decided, unclear, or ignored because already decided). */
    history: [{ _id: false, messageId: String, from: String, receivedAt: Date, at: Date, snippet: String, outcome: String }],
  },
  { timestamps: true },
);
export const VendorRateApproval = model('VendorRateApproval', vendorRateApprovalSchema);
