import { Schema, model } from 'mongoose';
import { CLIENT_TYPES } from '../clients/client.model';
import { storedFileSchema } from '../files/storedFile.schema';
import { rateCardRevisionSchema } from '../ratecards/ratecard.model';

/** BD sales pipeline (Kanban columns, in order). An order only ever moves forward one stage at a time. */
export const ORDER_STAGES = ['NEW_ORDER', 'COMPANY_PROFILE', 'RATE_CARD', 'CLIENT_APPROVAL'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/**
 * ONBOARDING = Customer Onboarding Form (Lead Management > Client Registered), sent through the PHP mail service.
 * PROJECT_CODE_REQUEST = Project Assign > Recce team: asks for the project code to be created.
 */
export const EMAIL_KINDS = ['COMPANY_PROFILE', 'RATE_CARD', 'ONBOARDING', 'PROJECT_CODE_REQUEST'] as const;
export const DELIVERY_STATUSES = ['SENT', 'FAILED', 'SKIPPED'] as const;
export const ASSIGN_ROUTES = ['HANDOVER', 'RECCE'] as const;
export type AssignRoute = (typeof ASSIGN_ROUTES)[number];
export const APPROVAL_DOC_TYPES = ['PURCHASE_ORDER', 'EMAIL_APPROVAL', 'WHATSAPP_APPROVAL', 'OTHER_WRITTEN', 'PHOTO', 'SUPPORTING_DOCUMENT'] as const;
export const PIPELINE_ACTIONS = ['CREATE', 'STAGE_CHANGE', 'ASSIGN', 'APPROVAL_COMPLETE', 'HANDOVER'] as const;
export const HANDOVER_DOC_KINDS = ['DOCUMENT', 'SHOP_LIST'] as const;
/**
 * What the BD hands to Client Servicing: ASO (client and contacts only; CS collects the shops by phone), the shop list
 * only, or the shop list with measurements and per-shop photos / documents.
 */
export const HANDOVER_TYPES = ['ASO', 'SHOP_DETAILS', 'SHOP_MEASUREMENT'] as const;
export type HandoverType = (typeof HANDOVER_TYPES)[number];

/**
 * Every Lead Management stage a lead can have been in. The mind map today is New Lead -> Project Assign (LEAD_FLOW);
 * the other stages (onboarding, requirements, rate card, negotiation, approval) are kept, switched off, for reuse.
 */
export const LEAD_STAGES = ['NEW_LEAD', 'PROJECT_ASSIGN', 'CLIENT_REGISTERED', 'REQUIREMENT_DISCUSSION', 'RATE_CARD', 'NEGOTIATION', 'CLIENT_APPROVAL'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_FLOW = ['NEW_LEAD', 'PROJECT_ASSIGN'] as const satisfies readonly LeadStage[];
/** STEP: a Project Assign step saved (handover type, code email, codes); CLIENT_CHANGE: the lead's client switched. */
export const LEAD_ACTIONS = ['START', 'COMPLETE', 'BACK', 'CLOSE', 'REOPEN', 'NOTES', 'STEP', 'CLIENT_CHANGE'] as const;

/** Files keep their full metadata inside the order (no FileAsset row); see storedFile.schema. */
const fileRef = storedFileSchema;

/** salescommentsArray: internal comments with optional attachments. */
const commentSchema = new Schema({
  body: { type: String, trim: true },
  attachments: [fileRef],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  createdAt: { type: Date, default: Date.now },
});

/**
 * salesprofile: every email sent for the order (Company Profile and Rate Card, told apart by `kind`). Keeps exactly
 * what was sent, even when the master template or rate card changes later.
 */
const emailSchema = new Schema({
  kind: { type: String, enum: EMAIL_KINDS, required: true },
  from: String,
  to: [String],
  cc: [String],
  subject: String,
  body: String,
  attachments: [fileRef],
  rateCardRevision: Number,
  status: { type: String, enum: DELIVERY_STATUSES, required: true },
  error: String,
  resentFrom: Schema.Types.ObjectId,
  /** Idempotency key from the composer; checked within this order before appending. */
  requestKey: String,
  sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sentAt: { type: Date, default: Date.now },
});

/**
 * approvalDocumentsArray: client approval proof. Replacing supersedes the old entry; it and its file are kept.
 * Until approval is complete a document can be deleted (its file is erased); after that the proof is locked.
 */
const approvalDocSchema = new Schema({
  docType: { type: String, enum: APPROVAL_DOC_TYPES, required: true },
  file: { type: fileRef, required: true },
  approvalDate: Date,
  remarks: String,
  replaces: Schema.Types.ObjectId,
  supersededAt: Date,
  supersededBy: Schema.Types.ObjectId,
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
});

/** salespipelineLogs: creation, stage moves, BD reassignment and approval completion (Pipeline History tab). */
const pipelineLogSchema = new Schema({
  action: { type: String, enum: PIPELINE_ACTIONS, required: true },
  fromStage: { type: String, enum: ORDER_STAGES, default: null },
  toStage: { type: String, enum: ORDER_STAGES, default: null },
  movedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  role: String,
  movedAt: { type: Date, default: Date.now },
  notes: String,
});

/** leadLogsArray: every Lead Management move (start, stage completed, back to a previous stage, close / reopen). */
const leadLogSchema = new Schema({
  action: { type: String, enum: LEAD_ACTIONS, required: true },
  fromStage: { type: String, enum: LEAD_STAGES, default: null },
  toStage: { type: String, enum: LEAD_STAGES, default: null },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  role: String,
  at: { type: Date, default: Date.now },
  note: String,
  /** STEP: which step (handover-type, email, codes). */
  step: String,
  /** What changed: the value before and after (STEP, CLIENT_CHANGE). */
  oldValue: { type: Schema.Types.Mixed, default: undefined },
  newValue: { type: Schema.Types.Mixed, default: undefined },
});

/** requirementNotesArray: Requirement Discussion notes, each with optional documents / reference images. */
const requirementNoteSchema = new Schema({
  body: { type: String, trim: true },
  attachments: [fileRef],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  createdAt: { type: Date, default: Date.now },
});

/** handoverDocumentsArray: files the BD hands to Client Servicing (client documents, and the shop list Excel). */
const handoverDocSchema = new Schema({
  kind: { type: String, enum: HANDOVER_DOC_KINDS, required: true },
  file: { type: fileRef, required: true },
  /** Shop list files: the handover type whose dataset they belong to, set when the type is switched away (unset = the current type). */
  shopType: String,
  /** Added after the order was handed over (shown as "added later" to Client Servicing). */
  afterHandover: { type: Boolean, default: false },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  createdAt: { type: Date, default: Date.now },
});

/**
 * handoverMessagesArray: the handover's chat-style communication (text, attachments, voice notes), oldest first.
 * Replaces the separate notes / voice notes / documents (kept below only for records from before it).
 */
const handoverMessageSchema = new Schema({
  text: { type: String, trim: true, maxlength: 4000 },
  attachments: { type: [fileRef], default: [] },
  /** A voice note: recorded in the browser or an uploaded audio file. */
  voice: {
    type: new Schema({ file: { type: fileRef, required: true }, durationSec: Number }, { _id: false }),
    default: null,
  },
  by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  /** Sent after the order was handed over. */
  afterHandover: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

/** handoverShopLogs: every change to a shop row (added, edited, deleted, imported), with the values before / after. */
export const SHOP_LOG_ACTIONS = ['ADD', 'EDIT', 'DELETE', 'IMPORT', 'CLEAR', 'IMAGE_ADD', 'IMAGE_REMOVE'] as const;
const shopLogSchema = new Schema({
  rowId: String,
  /** Handover type of the dataset the entry belongs to, set when the type is switched away (unset = the current type). */
  type: String,
  /** Row identity as the BD sees it ("Row 12 · ABC Traders"), kept so deleted rows stay recognisable. */
  label: String,
  action: { type: String, enum: SHOP_LOG_ACTIONS, required: true },
  before: { type: Schema.Types.Mixed, default: undefined },
  after: { type: Schema.Types.Mixed, default: undefined },
  /** Imported-column tables: the cells that changed, by column header (before / after; one side for add / delete). */
  cells: { type: [new Schema({ column: String, before: String, after: String }, { _id: false })], default: undefined },
  note: String,
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  role: String,
  at: { type: Date, default: Date.now },
});

/** handoverVoiceNotesArray (legacy): voice notes for Client Servicing, recorded in the browser or uploaded. */
const voiceNoteSchema = new Schema({
  file: { type: fileRef, required: true },
  /** Length in seconds as measured by the browser (at most 5 minutes). */
  durationSec: Number,
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  createdAt: { type: Date, default: Date.now },
});

/**
 * handoverShopsArray: shop rows from the BD's shop list, cleaned with the same rules as the project site import
 * (sites/site.fields). They become project sites when Client Servicing creates the project.
 */
const handoverShopSchema = new Schema(
  {
    rowNumber: Number,
    shopName: String,
    dealerName: String,
    location: String,
    district: String,
    address1: String,
    address2: String,
    address3: String,
    pincode: String,
    mobile: String,
    mobileAlt: String,
    gstin: String,
    contactPerson: String,
    width: Number,
    height: Number,
    unit: String,
    boardType: String,
    quantity: Number,
    remarks: String,
    clientSiteCode: String,
    /** Columns that did not match a known field, kept as-is (tables from before imported columns). */
    extra: { type: Schema.Types.Mixed, default: undefined },
    /** The row as imported / edited: column id (order.shopColumns) -> cell text exactly as shown in Excel. */
    cells: { type: Schema.Types.Mixed, default: undefined },
    state: { type: String, enum: ['VALID', 'WARNING', 'ERROR'] },
    issues: [String],
    /** Shop + Measurement: up to 10 images of this shop (where the board goes, measurements). */
    attachments: { type: [fileRef], default: undefined },
    /** Stable id of the row (kept through edits, Excel export / import); rows from before it get one on first read. */
    rowId: { type: String, index: true },
    updatedAt: Date,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

/**
 * One order per client enquiry, holding all of its sales activity in arrays. The company (Client) stays the master
 * record; an order only links to it, so a client can have many orders and editing an order never touches the company.
 */
const orderSchema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true }, // 20261025ORD#1 (older orders: ORD-2026-0001)
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    /** Snapshot at creation: NEW for the order created with a new client registration, EXISTING for repeat orders. */
    clientType: { type: String, enum: CLIENT_TYPES, required: true, index: true },
    stage: { type: String, enum: ORDER_STAGES, default: 'NEW_ORDER', index: true },
    stageChangedAt: Date,
    owner: { type: Schema.Types.ObjectId, ref: 'User', index: true }, // assigned BD
    estimatedAmount: Number,
    approvalStatus: { type: String, enum: ['PENDING', 'COMPLETED'], default: 'PENDING' },
    approvalCompletedAt: Date,
    approvalCompletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    /** Idempotency key sent by the form, so a double click or retry never creates a second order. */
    requestKey: { type: String, unique: true, sparse: true },

    /** Latest rate card revision number (0 = not saved yet) and its PDF, so checks never read the whole array. */
    currentRevision: { type: Number, default: 0 },
    rateCardPdf: { type: fileRef, default: null },

    /** Client Servicing person the BD handed this order to (set once; the BD cannot reassign). */
    csAssignee: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    handover: {
      type: new Schema(
        {
          assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          assignedAt: Date,
          note: String,
          /** First time the Client Servicing person opened the order ("New" badge until then). */
          seenAt: Date,
        },
        { _id: false },
      ),
      default: null,
    },
    handoverType: { type: String, enum: HANDOVER_TYPES, default: null },
    /** Last time any handover detail was saved (Handover Type & Details step on the mind map). */
    handoverUpdatedAt: { type: Date, default: null },
    /**
     * Assign to Client Servicing toggle: true = full handover (type, chat, shop list); false = client details and
     * contact persons only. New orders start OFF; orders saved before keep their stored value.
     */
    handoverFull: { type: Boolean, default: false },
    /** ASO: the client's SO (sales officer) contacts, kept apart from the client's contact persons. */
    soContacts: { type: [new Schema({ name: String, phone: String, email: String, isPrimary: Boolean })], default: undefined },
    /**
     * Project Assign route, taken by the first save on it: HANDOVER (Client Servicing: handover details) or RECCE
     * (Recce team: project code request email). The other route is then disabled.
     */
    assignRoute: { type: String, enum: ASSIGN_ROUTES, default: null },
    /**
     * Project Assign > Assign to Recce Team: the codes the BD received, and who the project went to. Assigning creates
     * the operations project (`project`, code = projectCode) and completes the lead.
     */
    recce: {
      type: new Schema(
        {
          /** 8 digits, e.g. 22070277. */
          projectCode: String,
          /** EST- and 6 digits, e.g. EST-323343. */
          estimationCode: String,
          codesSavedAt: Date,
          codesSavedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          /** Client ID in Zoho: typed for a New client (created in Zoho after the request email), from Zoho for an Existing one. */
          clientId: String,
          assignee: { type: Schema.Types.ObjectId, ref: 'User' },
          assignedAt: Date,
          assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          note: String,
          project: { type: Schema.Types.ObjectId, ref: 'Project' },
        },
        { _id: false },
      ),
      default: null,
    },
    /**
     * The client as it was handed over (to Client Servicing or the Recce team), saved with the assignment so later
     * client edits do not change what was handed over. GST certificates and custom fields: New (CRM) clients only.
     */
    handoverClient: {
      type: new Schema(
        {
          clientType: String,
          name: String,
          clientName: String,
          clientNo: String,
          email: String,
          phone: String,
          gstin: String,
          gstCertificates: { type: [fileRef], default: undefined },
          customFields: { type: [new Schema({ label: String, value: String }, { _id: false })], default: undefined },
          contacts: [new Schema({ name: String, designation: String, phone: String, email: String, isPrimary: Boolean }, { _id: false })],
          /** ASO handovers: the SO contacts as handed over. */
          soContacts: { type: [new Schema({ name: String, phone: String, email: String, isPrimary: Boolean }, { _id: false })], default: undefined },
          takenAt: Date,
        },
        { _id: false },
      ),
      default: null,
    },
    /** Additional notes for Client Servicing (full handover). */
    handoverNotes: { type: String, default: null },
    /** Total Shops: auto-filled with the valid rows of the uploaded list (the BD may correct it); Verify checks it against them. */
    declaredShopTotal: { type: Number, default: null },
    /** Set by Verify (count matches); cleared whenever the list or the declared total changes. */
    shopsVerifiedAt: { type: Date, default: null },
    shopsVerifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Summary of the current shop list (rows are in handoverShopsArray). */
    shopList: {
      type: new Schema(
        {
          fileId: Schema.Types.ObjectId,
          fileName: String,
          total: Number,
          valid: Number,
          warning: Number,
          error: Number,
          /** Rows that repeat an earlier row of the same file. */
          duplicates: Number,
          /** SHA-256 of the last uploaded file (the same file again is refused, so a retry does not add its rows twice). */
          fileHash: String,
          uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          uploadedAt: Date,
        },
        { _id: false },
      ),
      default: null,
    },

    /** Latest Customer Onboarding Form PDF for this order (sent emails keep their own copy of the file record). */
    onboardingPdf: { type: fileRef, default: null },
    onboardingPdfAt: Date,
    onboardingPdfBy: { type: Schema.Types.ObjectId, ref: 'User' },

    /** Lead Management state (null until the order is taken up as a lead). */
    lead: {
      type: new Schema(
        {
          stage: { type: String, enum: LEAD_STAGES, required: true },
          /** Stage of the previous (six-stage) flow a lead was in when it moved to Project Assign. */
          legacyStage: { type: String, enum: LEAD_STAGES },
          stageChangedAt: Date,
          startedAt: Date,
          startedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          /** Stage 1 "Initial Notes". */
          initialNotes: String,
          /** COMPLETED = Client Rate Approval done: the lead is won and its rate card and approval proof are locked. */
          status: { type: String, enum: ['OPEN', 'CLOSED', 'COMPLETED'], default: 'OPEN' },
          completedAt: Date,
          completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          closedAt: Date,
          closedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          closeReason: String,
        },
        { _id: false },
      ),
      default: null,
    },

    salescommentsArray: { type: [commentSchema], default: [] },
    salesprofile: { type: [emailSchema], default: [] },
    rateCardArray: { type: [rateCardRevisionSchema], default: [] },
    approvalDocumentsArray: { type: [approvalDocSchema], default: [] },
    salespipelineLogs: { type: [pipelineLogSchema], default: [] },
    handoverDocumentsArray: { type: [handoverDocSchema], default: [] },
    handoverShopsArray: { type: [handoverShopSchema], default: [] },
    /**
     * Columns of the shop table as uploaded: stable id, the original header text (blank / repeated allowed) in sheet
     * order, and the shop field it feeds internally (null = kept as a column only). Unset for tables from before.
     */
    shopColumns: { type: [new Schema({ id: String, header: String, field: { type: String, default: null } }, { _id: false })], default: undefined },
    handoverVoiceNotesArray: { type: [voiceNoteSchema], default: [] },
    handoverMessagesArray: { type: [handoverMessageSchema], default: [] },
    handoverShopLogs: { type: [shopLogSchema], default: [] },
    /**
     * Shop datasets of the handover types not selected now, by type: `{ rows, columns, list, declared }`. The selected
     * type's dataset is always in handoverShopsArray / shopColumns / shopList; switching the type swaps them.
     */
    shopSets: { type: Schema.Types.Mixed, default: undefined },
    leadLogsArray: { type: [leadLogSchema], default: [] },
    requirementNotesArray: { type: [requirementNoteSchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
orderSchema.index({ stage: 1, createdAt: -1 });
orderSchema.index({ csAssignee: 1, createdAt: -1 });
// A project / estimation code belongs to one order only.
orderSchema.index({ 'recce.projectCode': 1 }, { unique: true, partialFilterExpression: { 'recce.projectCode': { $type: 'string' } } });
orderSchema.index({ 'recce.estimationCode': 1 }, { unique: true, partialFilterExpression: { 'recce.estimationCode': { $type: 'string' } } });
orderSchema.index({ 'lead.stage': 1, 'lead.stageChangedAt': -1 });
// Resend / edit-details look orders up by an array item's id.
orderSchema.index({ 'salesprofile._id': 1 });
orderSchema.index({ 'approvalDocumentsArray._id': 1 });
// "Was this file emailed?" check before a template PDF is erased.
orderSchema.index({ 'salesprofile.attachments.fileId': 1 });
export const SalesOrder = model('SalesOrder', orderSchema);

/** Projection that leaves out the activity arrays (Kanban, overview, checks). */
export const WITHOUT_ARRAYS = '-salescommentsArray -salesprofile -rateCardArray -approvalDocumentsArray -salespipelineLogs -handoverDocumentsArray -handoverShopsArray -handoverVoiceNotesArray -leadLogsArray -requirementNotesArray -handoverShopLogs -shopSets';
