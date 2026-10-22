import { Schema, model } from 'mongoose';

/**
 * NEW/ACTIVE are the original statuses. The BD -> Operations pipeline adds
 * DRAFT -> ENQUIRY -> RECCE_ASSIGNED -> PLANNING -> IN_PROGRESS -> CLIENT_APPROVAL -> COMPLETED.
 */
export const PROJECT_STATUSES = [
  'NEW', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED',
  'DRAFT', 'ENQUIRY', 'RECCE_ASSIGNED', 'PLANNING', 'IN_PROGRESS', 'CLIENT_APPROVAL',
] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const REQUIREMENT_TYPES = ['ASO', 'SHOP_DETAILS', 'SHOP_MEASUREMENT'] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

const projectFileSchema = new Schema(
  {
    section: String,
    category: { type: String, required: true },
    /** Storage key, e.g. BD/Client_Details/AMUL/<project code>/<file>. */
    key: { type: String, required: true },
    storage: { type: String, enum: ['local', 'space'], required: true },
    /** Spaces only: full object path in the bucket (with the app folder) and the full URL. Not set for local files. */
    path: String,
    url: String,
    originalName: { type: String, required: true },
    mimeType: String,
    kind: { type: String, enum: ['image', 'video', 'document', 'sheet'], required: true },
    size: Number,
    sha256: String,
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
    deletedAt: Date,
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    objectRetained: Boolean,
  },
  { _id: true },
);

const contactSchema = new Schema(
  { name: { type: String, required: true, trim: true }, email: { type: String, lowercase: true, trim: true }, phone: String },
  { _id: true },
);

const projectSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // SGN-<CLIENT>-<YEAR>-<NNN>, or a BD-supplied code (e.g. 22070277)
    requirementType: { type: String, enum: REQUIREMENT_TYPES },
    startDate: Date,
    district: { type: String, trim: true },
    instructions: String,
    /** Expected number of shops (null for ASO surveys where the count is unknown). */
    expectedShops: Number,
    contacts: [contactSchema],
    /**
     * Every file of this project, grouped by CRM section (the single place files are recorded; there is no separate
     * collection). Each entry's _id is the file id. Not loaded unless asked for, so project lists stay light.
     * Critical evidence that was "deleted" stays here with deletedAt set, because its stored object is kept.
     */
    files: { type: [projectFileSchema], select: false, default: undefined },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    assignedAt: Date,
    name: { type: String, required: true, trim: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    campaign: { type: String, trim: true },
    status: { type: String, enum: PROJECT_STATUSES, default: 'NEW', index: true },
    statusReason: String,
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM' },
    targetDate: Date,
    description: String,
    recceRequired: { type: Boolean, default: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', index: true }, // BD owner
    coordinator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    sourceMessage: { type: Schema.Types.ObjectId, ref: 'CommunicationMessage' },
    siteCount: { type: Number, default: 0 }, // maintained by Phase 3
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
projectSchema.index({ createdAt: -1 });
projectSchema.index({ name: 'text', code: 'text', campaign: 'text' });
export const Project = model('Project', projectSchema);

export const REQUIREMENT_SOURCES = ['EMAIL', 'PHONE', 'WHATSAPP', 'REFERRAL', 'MEETING', 'OTHER'] as const;

const attachment = new Schema(
  { name: String, size: Number, mimeType: String, fileId: String, url: String },
  { _id: false },
);

const requirementSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, unique: true },
    source: { type: String, enum: REQUIREMENT_SOURCES, required: true },
    sourceMessage: { type: Schema.Types.ObjectId, ref: 'CommunicationMessage' },
    sourceNote: String, // e.g. who referred / meeting date
    contact: { name: String, phone: String, email: { type: String, lowercase: true } },
    expectedSites: Number,
    locations: [String],
    description: String,
    commercialNotes: String,
    recceRequired: { type: Boolean, default: true },
    siteDataScenario: { type: String, enum: ['MEASUREMENT_REQUIRED', 'CLIENT_PROVIDED'], default: 'MEASUREMENT_REQUIRED' },
    attachments: [attachment],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const Requirement = model('Requirement', requirementSchema);
