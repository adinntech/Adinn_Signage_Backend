import { Schema, model } from 'mongoose';
import { SCENARIOS, UNITS } from './site.fields';

export const SITE_STATUSES = ['PENDING'] as const; // recce lifecycle statuses are added in later phases
export const APPROVAL_STATES = ['PENDING', 'APPROVED', 'CORRECTION'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

const siteSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    siteCode: { type: String, required: true, unique: true }, // SGN-AMUL-2026-001-S001
    seq: { type: Number, required: true },
    scenario: { type: String, enum: SCENARIOS, required: true },
    shopName: String,
    dealerName: String,
    location: String,
    district: String,
    address1: String,
    address2: String,
    pincode: String,
    mobile: String,
    mobileAlt: String,
    gstin: String,
    contactPerson: String,
    width: Number,
    height: Number,
    unit: { type: String, enum: UNITS },
    quantity: { type: Number, default: 1 },
    sqft: Number, // derived: width x height x quantity in sq.ft
    boardType: String,
    remarks: String,
    clientSiteCode: String,
    extra: { type: Schema.Types.Mixed }, // any other client columns, original header -> value
    dupKey: { type: String, index: true },
    status: { type: String, enum: SITE_STATUSES, default: 'PENDING' },
    /** Two independent pre-recce approvals of the shop details / board measurement. */
    opsApproval: { type: String, enum: APPROVAL_STATES, default: 'PENDING' },
    bdApproval: { type: String, enum: APPROVAL_STATES, default: 'PENDING' },
    approvalNote: String,
    approvalUpdatedAt: Date,
    approvalUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    importBatch: { type: Schema.Types.ObjectId, ref: 'ImportBatch' },
    sourceRow: Number,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
siteSchema.index({ project: 1, deletedAt: 1, seq: 1 });
siteSchema.index({ project: 1, dupKey: 1 });
siteSchema.index({ project: 1, district: 1 });
siteSchema.index({ project: 1, status: 1 });
export const Site = model('Site', siteSchema);

const issue = new Schema({ field: String, code: String, message: String }, { _id: false });

const batchSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    fileName: String,
    fileSize: Number,
    sheetName: String,
    headers: [String],
    mapping: { type: Schema.Types.Mixed, default: {} },
    scenario: { type: String, enum: SCENARIOS },
    defaultUnit: { type: String, enum: UNITS, default: 'ft' },
    duplicatePolicy: { type: String, enum: ['skip', 'import', 'update'], default: 'skip' },
    status: { type: String, enum: ['UPLOADED', 'PREVIEWED', 'COMMITTING', 'COMMITTED', 'FAILED', 'DISCARDED'], default: 'UPLOADED', index: true },
    totalRows: { type: Number, default: 0 },
    summary: { valid: Number, warning: Number, error: Number, duplicates: Number, skipped: Number },
    result: { created: Number, updated: Number, skippedRows: Number, errorRows: Number },
    committedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const ImportBatch = model('ImportBatch', batchSchema);

const rowSchema = new Schema({
  batch: { type: Schema.Types.ObjectId, ref: 'ImportBatch', required: true },
  rowNumber: { type: Number, required: true }, // row number in the uploaded sheet
  raw: { type: Schema.Types.Mixed, required: true }, // header -> cell text
  mapped: { type: Schema.Types.Mixed, default: {} },
  extra: { type: Schema.Types.Mixed },
  errors: [issue],
  warnings: [issue],
  state: { type: String, enum: ['VALID', 'WARNING', 'ERROR'], default: 'VALID' },
  dupKey: String,
  dup: { type: { type: String, enum: ['FILE', 'EXISTING', 'DEALER'] }, ref: String },
  skipped: { type: Boolean, default: false },
});
rowSchema.index({ batch: 1, rowNumber: 1 });
rowSchema.index({ batch: 1, state: 1 });
export const ImportRow = model('ImportRow', rowSchema);
