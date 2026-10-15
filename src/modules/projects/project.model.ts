import { Schema, model } from 'mongoose';

export const PROJECT_STATUSES = ['NEW', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const projectSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // SGN-<CLIENT>-<YEAR>-<NNN>
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
