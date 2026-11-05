import { Schema, model } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

export const CODE_KINDS = ['CLIENT_CODE', 'PROJECT_CODE'] as const;
export type CodeKind = (typeof CODE_KINDS)[number];

/**
 * DRAFT                 saved, not emailed yet
 * PENDING_CONFIRMATION  emailed (or recorded from the BD's email); waiting for the code to come back
 * CONFIRMED             the real code was entered by an authorised person
 * REJECTED              the authority refused it or it was withdrawn (a new request may follow)
 * FAILED                the email could not be sent (retry sends it again)
 */
export const CODE_STATUSES = ['DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'FAILED'] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];

/**
 * One logical request for one code (client code or project code) on one order. A combined email creates two of
 * these with the same `mailBatchId`; each is confirmed on its own. A sent email never confirms a code.
 */
const codeRequestSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    kind: { type: String, enum: CODE_KINDS, required: true },
    status: { type: String, enum: CODE_STATUSES, default: 'DRAFT', index: true },
    /** True once emailed and until rejected or failed: at most one live request per order and kind. */
    active: { type: Boolean, default: false },
    /** Rows that went out in the same email share this id. */
    mailBatchId: String,
    /** The email entry in the order's `salesprofile` (what was sent, to whom, attachments, status). */
    mailRef: Schema.Types.ObjectId,
    mailStatus: { type: String, enum: ['SENT', 'SKIPPED', 'FAILED'] },
    mailError: String,
    mode: { type: String, enum: ['COMBINED', 'SEPARATE', 'SINGLE', 'BD', 'MANUAL'] },
    /** MANUAL = Client Servicing recorded that the request was already sent outside the CRM. BD = the BD team's own project code request email, picked up by Client Servicing. */
    source: { type: String, enum: ['CS', 'BD'], default: 'CS' },
    requestKey: String,
    draft: {
      type: new Schema({ to: [String], cc: [String], bcc: [String], from: String, subject: String, body: String }, { _id: false }),
      default: null,
    },
    /** Recipients that must stay private (Bcc is not kept on the shared email entry). */
    bcc: [String],
    sentAt: Date,
    sentBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedCode: String,
    confirmedAt: Date,
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    /** Where the code came from (reply mail, reference number...). */
    evidenceNote: String,
    /** Proof files uploaded at confirmation (reply mail, screenshot). Erased with the order's client. */
    evidence: { type: [storedFileSchema], default: [] },
    rejectedReason: String,
    rejectedAt: Date,
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
// One live request per order and kind, even under a double click.
codeRequestSchema.index({ order: 1, kind: 1 }, { unique: true, partialFilterExpression: { active: true } });
// One draft per order and kind.
codeRequestSchema.index({ order: 1, kind: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'DRAFT' } });
// A repeated submit returns the first result.
codeRequestSchema.index({ requestKey: 1, kind: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });
// A confirmed code belongs to one request only.
codeRequestSchema.index({ kind: 1, confirmedCode: 1 }, { unique: true, partialFilterExpression: { confirmedCode: { $type: 'string' } } });
codeRequestSchema.index({ mailBatchId: 1 });
export const CodeRequest = model('CodeRequest', codeRequestSchema);
