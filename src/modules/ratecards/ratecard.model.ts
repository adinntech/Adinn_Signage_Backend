import { Schema, model } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

export const RATE_UNITS = ['SQFT', 'RFT', 'UNIT', 'KM'] as const;
export const RATE_UNIT_LABELS: Record<(typeof RATE_UNITS)[number], string> = { SQFT: 'Sq.ft', RFT: 'Running Feet', UNIT: 'Unit', KM: 'KM' };

/** Master (standard) signage rate. Quotations copy these values; changing a master rate never touches a saved quotation. */
const rateItemSchema = new Schema(
  {
    particulars: { type: String, required: true, trim: true },
    specifications: { type: String, trim: true },
    unit: { type: String, enum: RATE_UNITS, required: true },
    rate: { type: Number, required: true, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    /** Soft delete: quotations keep their own snapshot, so removing a master item never breaks them. */
    deletedAt: Date,
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
rateItemSchema.index({ deletedAt: 1, particulars: 1 });
export const RateItem = model('RateItem', rateItemSchema);

/** First-run master rates, taken from the ADINN signage rate card reference. Seeded once; editable afterwards. */
export const RATE_ITEM_SEED = [
  { particulars: 'ACP Facia Signage', specifications: '3mm ACP with vinyl, backlit', unit: 'SQFT', rate: 300 },
  { particulars: 'LED Glow Sign', specifications: 'Acrylic 3D letters with LED', unit: 'SQFT', rate: 500 },
  { particulars: 'Directional Signage', specifications: 'ACP with UV print', unit: 'UNIT', rate: 4000 },
  { particulars: 'In-Store Branding', specifications: 'Vinyl print with laminate', unit: 'SQFT', rate: 200 },
] as const;

const lineSchema = new Schema(
  {
    masterItem: { type: Schema.Types.ObjectId, ref: 'RateItem' },
    particulars: { type: String, required: true },
    specifications: String,
    unit: { type: String, enum: RATE_UNITS, required: true },
    /** Master rate captured when the line was copied (null for a custom line). */
    masterRate: { type: Number, default: null },
    quotedRate: { type: Number, required: true },
    overrideReason: String,
  },
  { _id: false },
);

/**
 * One saved version of an order's quotation, stored inside the order (SalesOrder.rateCardArray). Every save that
 * changes something appends a revision with its own PDF; earlier revisions and their PDFs are never modified.
 */
export const rateCardRevisionSchema = new Schema({
  revision: { type: Number, required: true },
  quotationRef: { type: String, required: true },
  clientName: { type: String, required: true },
  clientAddress: String,
  contact: { name: String, designation: String, phone: String, email: String },
  quotationDate: { type: Date, required: true },
  subject: { type: String, required: true },
  items: [lineSchema],
  terms: String, // sanitized HTML
  regards: { name: String, designation: String, mobile: String, email: String },
  changes: [{ _id: false, field: String, oldValue: Schema.Types.Mixed, newValue: Schema.Types.Mixed, changeType: { type: String, enum: ['ADDED', 'UPDATED', 'REMOVED'] } }],
  pdf: { type: storedFileSchema },
  /** Lead stage the revision was saved in: the first rate card, or a negotiation round. */
  phase: { type: String, enum: ['PREPARATION', 'NEGOTIATION'], default: 'PREPARATION' },
  editedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

export const revisionLabel = (n: number) => `v1.${n - 1}`;
