import { Schema, model, type InferSchemaType } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

/**
 * Shop-wise recce evidence and its two-stage review: ONE collection, ONE document per shop (Site).
 *
 *   RecceSubmission  the working record of the person who visits the shop. It holds everything of that shop:
 *     mediaItems / notes / installation   the content (boards, measurements, feasibility)
 *     photos[]    one entry per photo. The original file is never changed; an annotated copy is a separate file.
 *     versions[]  IMMUTABLE snapshot made at every submit (which photos, which measurements). Never edited.
 *     reviews[]   one decision per (versionNo, stage). A reviewer can decide only his own stage, only once.
 *     reworks[]   what a reviewer asked to fix, item by item, with resolved / open state.
 * The arrays are bounded per shop (at most `maxPhotos` photos, a handful of versions), so one document stays small. Every change to
 * them is ONE atomic update on this document (filter + positional operators), never a read-modify-write of a whole array.
 * Every event is also written to the existing AuditLog (entity "RecceSubmission") and read back as the timeline.
 */

export const REVIEW_STAGES = ['OPS', 'CS'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];
export const STAGE_LABEL: Record<ReviewStage, string> = { OPS: 'Recce Operations', CS: 'Client Servicing' };

export const RECCE_STATUSES = ['IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REWORK_REQUIRED', 'REJECTED'] as const;
export type RecceStatus = (typeof RECCE_STATUSES)[number];

export const PHOTO_CATEGORIES = [
  'SHOP_FRONT', 'NAME_BOARD', 'LEFT_SIDE', 'RIGHT_SIDE', 'MEASUREMENT', 'MOUNTING_AREA', 'ELECTRICAL', 'EXISTING_BOARD', 'OBSTRUCTION', 'ADDITIONAL',
  // Mobile field flow (2026-11-21): the six GPS-tagged photos. SHOP_FRONT stays the "Front View" photo.
  'SIDE_VIEW', 'LONG_SHOT', 'ANNOTATED_VIEW', 'LOCATION_VIEW', 'ACCESS_PATH',
  // Quantity-based units (2026-11-27): the seven photos of one board unit (with SHOP_FRONT, LEFT_SIDE, RIGHT_SIDE, LONG_SHOT).
  'BACK_VIEW', 'CLOSE_UP', 'SURROUNDINGS',
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<PhotoCategory, string> = {
  SHOP_FRONT: 'Full Shop Front View', NAME_BOARD: 'Shop Name Board', LEFT_SIDE: 'Left Side View', RIGHT_SIDE: 'Right Side View',
  MEASUREMENT: 'Measurement View', MOUNTING_AREA: 'Mounting Area', ELECTRICAL: 'Electrical Connection', EXISTING_BOARD: 'Existing Board',
  OBSTRUCTION: 'Obstruction / Site Issue', ADDITIONAL: 'Additional Photo',
  SIDE_VIEW: 'Side View', LONG_SHOT: 'Long Shot', ANNOTATED_VIEW: 'Annotated View', LOCATION_VIEW: 'Location View', ACCESS_PATH: 'Access Path',
  BACK_VIEW: 'Back View', CLOSE_UP: 'Close-up', SURROUNDINGS: 'Surroundings',
};
/** The seven photos every board unit needs (default of RecceConfig.unitPhotoCategories). */
export const UNIT_PHOTO_CATEGORIES: PhotoCategory[] = ['SHOP_FRONT', 'BACK_VIEW', 'LEFT_SIDE', 'RIGHT_SIDE', 'LONG_SHOT', 'CLOSE_UP', 'SURROUNDINGS'];
export const PHOTO_SOURCES = ['LIVE_CAMERA', 'GALLERY'] as const;
export type PhotoSource = (typeof PHOTO_SOURCES)[number];

/** Installation feasibility. An unanswered field is NOT_ASSESSED, never NO. */
export const TRI_STATES = ['YES', 'NO', 'NOT_ASSESSED'] as const;
export type TriState = (typeof TRI_STATES)[number];
export const ELECTRICAL_ACCESS = ['AVAILABLE', 'NOT_AVAILABLE', 'NOT_ASSESSED'] as const;
/** The five answers the field person must give before submit. */
export const INSTALLATION_REQUIRED = ['ladderRequired', 'scaffoldingRequired', 'craneRequired', 'hydraRequired', 'manualInstallationPossible'] as const;

/** DRAFT: only the uploader sees it. SUBMITTED: part of a version. SUPERSEDED: replaced by a newer photo. REMOVED: soft-deleted with a reason. */
export const PHOTO_STATES = ['DRAFT', 'SUBMITTED', 'SUPERSEDED', 'REMOVED'] as const;
export type PhotoState = (typeof PHOTO_STATES)[number];

export const DECISIONS = ['PENDING', 'APPROVED', 'REJECTED', 'REWORK', 'VOID'] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * One physical piece of a board line (quantity 2 = Unit 1 and Unit 2), each with its own size, answers and photos (photos[].unitKey).
 * Optional: a board line without units is read as ONE unit made of its own width / height (older submissions).
 */
const fieldUnitSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 40 },
    unitNo: { type: Number, required: true, min: 1, max: 999 },
    width: { type: Number, min: 0, max: 100000 },
    height: { type: Number, min: 0, max: 100000 },
    unit: { type: String, enum: ['FT', 'IN', 'M', 'CM', 'MM'], default: 'FT' },
    answers: { type: [{ _id: false, key: { type: String, maxlength: 40 }, question: { type: String, maxlength: 200 }, answer: { type: String, maxlength: 500 } }], default: [] },
    notes: { type: String, maxlength: 500 },
  },
  { _id: false },
);

/** The field app's flat board line, as kept in each shop-level version snapshot. */
const fieldItemSchema = new Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true, maxlength: 80 },
    quantity: { type: Number, default: 1, min: 1, max: 999 },
    width: { type: Number, min: 0, max: 100000 },
    height: { type: Number, min: 0, max: 100000 },
    unit: { type: String, enum: ['FT', 'IN', 'M', 'CM', 'MM'], default: 'FT' },
    notes: { type: String, maxlength: 500 },
    /** One physical board per item: boards of different sizes are separate items with their own key. */
    sided: { type: String, enum: ['SINGLE', 'DOUBLE'] },
    condition: { type: String, enum: ['EXISTING', 'PROPOSED'] },
    position: { type: String, maxlength: 120 },
    installationNotes: { type: String, maxlength: 500 },
    units: { type: [fieldUnitSchema], default: undefined },
  },
  { _id: false },
);

const tri = { type: String, enum: TRI_STATES, default: 'NOT_ASSESSED' };
export const installationSchema = new Schema(
  {
    ladderRequired: tri,
    scaffoldingRequired: tri,
    craneRequired: tri,
    hydraRequired: tri,
    manualInstallationPossible: tri,
    electricalAccess: { type: String, enum: ELECTRICAL_ACCESS, default: 'NOT_ASSESSED' },
    installationHeightFt: { type: Number, min: 0, max: 500 },
    accessRestrictions: { type: [{ type: String, maxlength: 100 }], default: [] },
    obstruction: { type: String, maxlength: 300 },
    roadsideConstraints: { type: String, maxlength: 300 },
    safetyNotes: { type: String, maxlength: 500 },
    additionalEquipment: { type: [{ type: String, maxlength: 100 }], default: [] },
    notes: { type: String, maxlength: 500 },
  },
  { _id: false },
);

const flagSchema = new Schema({ code: String, message: String }, { _id: false });

/** One photo of the shop. Embedded in the submission; its `_id` is the photo id the apps and reviewers use. */
const photoSchema = new Schema({
  mediaKey: { type: String, default: '' },
  /** The board unit this photo belongs to (mediaItems[].units[].key). Empty = a shop-level photo (older submissions). */
  unitKey: { type: String, maxlength: 40 },
  category: { type: String, enum: PHOTO_CATEGORIES, required: true },
  caption: { type: String, default: '', maxlength: 300 },
  order: { type: Number, default: 0 },
  state: { type: String, enum: PHOTO_STATES, default: 'DRAFT' },
  /** The original file as captured. Never replaced. */
  original: { type: storedFileSchema, required: true },
  /** A marked-up copy (annotations burnt in by the phone / web). The original stays untouched. */
  edited: { type: storedFileSchema },
  annotations: { type: Schema.Types.Mixed },
  /** What the device reported. Never trusted on its own: see flags. */
  capturedAt: Date,
  lat: Number,
  lng: Number,
  gpsAccuracy: Number,
  /** Where the picture came from. Unset on older photos. */
  source: { type: String, enum: PHOTO_SOURCES },
  device: { type: String, maxlength: 120 },
  width: Number,
  height: Number,
  flags: { type: [flagSchema], default: [] },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  /** Phone-made id: the same photo sent twice (retry, resumed upload) is stored once. */
  clientId: { type: String, maxlength: 80 },
  /** Which version first contained it. */
  version: Number,
  replaces: { type: Schema.Types.ObjectId },
  supersededBy: { type: Schema.Types.ObjectId },
  removedAt: Date,
  removedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  removeReason: String,
  createdAt: { type: Date, default: Date.now },
});

/** IMMUTABLE snapshot of one submit. `photos` / `added` / `removed` hold photo ids (entries of `photos[]`). */
const versionSchema = new Schema({
  version: { type: Number, required: true },
  submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  submittedAt: { type: Date, default: Date.now },
  /** The exact photos of this version. Later removals do not change this list; they are read from the photo state. */
  photos: [{ type: Schema.Types.ObjectId }],
  added: [{ type: Schema.Types.ObjectId }],
  removed: [{ type: Schema.Types.ObjectId }],
  mediaItems: { type: [fieldItemSchema], default: [] },
  notes: { type: String, default: '' },
  /** Immutable installation feasibility snapshot made at submit (absent on versions made before 2026-11-21). */
  installation: { type: installationSchema },
  /** The stages that must approve this version (from the configuration at the time of submit). */
  stages: [{ type: String, enum: REVIEW_STAGES }],
  sequential: { type: Boolean, default: true },
  dueAt: Date,
  idempotencyKey: { type: String, maxlength: 80 },
});

/** One decision of one stage on one version. A reviewer can decide only his own stage, only once. */
const reviewSchema = new Schema({
  versionNo: { type: Number, required: true },
  stage: { type: String, enum: REVIEW_STAGES, required: true },
  decision: { type: String, enum: DECISIONS, default: 'PENDING' },
  reviewer: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewerRole: String,
  decidedAt: Date,
  comment: { type: String, default: '', maxlength: 2000 },
  checklist: [{ _id: false, key: String, label: String, passed: Boolean }],
  /** An Admin decided for this stage: who and why are kept. */
  override: { type: new Schema({ by: { type: Schema.Types.ObjectId, ref: 'User' }, reason: String }, { _id: false }) },
  /** Rejection only: what was rejected (photos, measurements or both) and the reviewer's optional voice note. */
  rejectMode: { type: String, enum: ['PHOTO', 'MEASUREMENT', 'BOTH'] },
  voiceNote: { type: storedFileSchema },
});

/** What a reviewer asked to fix, item by item. */
const reworkSchema = new Schema({
  versionNo: Number,
  stage: { type: String, enum: REVIEW_STAGES, required: true },
  kind: { type: String, enum: ['REWORK', 'ADDITIONAL'], required: true },
  instructions: { type: String, required: true, maxlength: 2000 },
  items: [
    {
      _id: { type: Schema.Types.ObjectId, auto: true },
      type: { type: String, enum: ['REPLACE_PHOTO', 'ADDITIONAL_PHOTO', 'FIX_MEASUREMENT', 'OTHER'], required: true },
      category: { type: String, enum: PHOTO_CATEGORIES },
      mediaKey: String,
      photo: { type: Schema.Types.ObjectId },
      note: { type: String, maxlength: 500 },
      resolved: { type: Boolean, default: false },
      resolvedInVersion: Number,
    },
  ],
  status: { type: String, enum: ['OPEN', 'RESOLVED', 'CLOSED'], default: 'OPEN' },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  resolvedAt: Date,
  createdAt: { type: Date, default: Date.now },
});

/**
 * Project Approval: one reviewer stage's decision on ONE photo or ONE board measurement of ONE version. At most one row per
 * (versionNo, stage, kind, ref); a newer version starts with no rows, so an old decision never approves the latest version.
 */
export const ITEM_KINDS = ['PHOTO', 'MEASUREMENT'] as const;
const itemReviewSchema = new Schema({
  versionNo: { type: Number, required: true },
  stage: { type: String, enum: REVIEW_STAGES, required: true },
  kind: { type: String, enum: ITEM_KINDS, required: true },
  /** Photo id (PHOTO) or the board item key (MEASUREMENT). */
  ref: { type: String, required: true, maxlength: 40 },
  decision: { type: String, enum: ['APPROVED', 'REJECTED'], required: true },
  reason: { type: String, default: '', maxlength: 500 },
  reviewer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reviewerRole: String,
  decidedAt: { type: Date, default: Date.now },
});

/* ------------------------------------------------ media items → units (the shop's record) ------------------------------------------------ */
/**
 * The shop's boards, one entry per media line: mediaItems[] → units[] (quantity 2 = SS-01 and SS-02). Every unit holds its own
 * measurement, answers, photos, versions, reviews (one per version and stage) and reworks. Unit 1 can be approved on V1 while
 * Unit 2 is sent back and comes again as V2. The field app (unchanged) still sends the flat working copy (top-level photos /
 * versions); the backend merges its draft into these units and turns every submit into unit versions (recceReview.units).
 * The shop status, pending stage, shop-level reviews and the field app's rework list are rolled up from the units.
 */
export const UNIT_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REWORK', 'REJECTED'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
/** REVERTED: an approval taken back by a reviewer (a separate entry: the approval itself stays in the history). */
export const UNIT_DECISIONS = ['PENDING', 'APPROVED', 'REJECTED', 'VOID', 'REVERTED'] as const;
export const MEASURE_FIELDS = ['width', 'height', 'both'] as const;
export const SIDE_TYPES = ['SINGLE', 'DOUBLE'] as const;
export const INSTALLATION_TYPES = ['WALL_MOUNT', 'PROJECTION_MOUNT', 'ROOF_TOP', 'GLASS_PASTING', 'WALL_PASTING', 'POLE_MOUNT', 'OTHER'] as const;
export const REWORK_STATES = ['OPEN', 'RESUBMITTED', 'CANCELLED'] as const;

const measurementSchema = new Schema({ width: Number, height: Number, unit: { type: String, enum: ['FT', 'IN', 'M', 'CM', 'MM'], default: 'FT' } }, { _id: false });
const answerSchema = new Schema({ questionId: { type: String, maxlength: 40 }, question: { type: String, maxlength: 200 }, answer: { type: String, maxlength: 500 } }, { _id: false });

/** IMMUTABLE snapshot of one unit submission. */
const unitVersionSchema = new Schema(
  {
    version: { type: Number, required: true },
    /** The shop submit (field app version) this unit version came from. */
    shopVersion: Number,
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    submittedAt: Date,
    installationType: { type: String, enum: [...INSTALLATION_TYPES, null] },
    measurement: { type: measurementSchema },
    answers: { type: [answerSchema], default: [] },
    photoIds: [{ type: Schema.Types.ObjectId }],
    /** What changed against the previous version: measurement.width, measurement.height, installationType, answers.<id>, photos.<CATEGORY>. */
    changedFields: { type: [String], default: [] },
  },
  { _id: false },
);

/** One stage's decision on one unit version. Decided once; VOID when the other stage already sent the unit back. */
const unitReviewSchema = new Schema(
  {
    version: { type: Number, required: true },
    stage: { type: String, enum: REVIEW_STAGES, required: true },
    decision: { type: String, enum: UNIT_DECISIONS, default: 'PENDING' },
    reviewer: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewerRole: String,
    decidedAt: Date,
    comment: { type: String, default: '', maxlength: 2000 },
    checklist: [{ _id: false, key: String, label: String, passed: Boolean }],
    rejectMode: { type: String, enum: ['PHOTO', 'MEASUREMENT', 'BOTH'] },
    /** The rework this rejection / revert opened (reworks[].reworkId). */
    reworkId: String,
    /** Revert only: why the approval was taken back. */
    revertReason: { type: String, maxlength: 200 },
    voiceNote: { type: storedFileSchema },
    override: { type: new Schema({ by: { type: Schema.Types.ObjectId, ref: 'User' }, reason: String }, { _id: false }) },
  },
  { _id: false },
);

/** What a rejection asked to fix in one unit: a photo or the measurement (Q&A is not rejected). */
const reworkItemSchema = new Schema(
  {
    kind: { type: String, enum: ITEM_KINDS, required: true },
    photoId: { type: Schema.Types.ObjectId },
    category: { type: String, enum: PHOTO_CATEGORIES },
    field: { type: String, enum: MEASURE_FIELDS },
    reason: { type: String, required: true, maxlength: 500 },
  },
  { _id: false },
);
const unitReworkSchema = new Schema(
  {
    reworkId: { type: String, required: true },
    sourceVersion: { type: Number, required: true },
    stage: { type: String, enum: REVIEW_STAGES, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    requestedAt: Date,
    status: { type: String, enum: REWORK_STATES, default: 'OPEN' },
    items: { type: [reworkItemSchema], default: [] },
    resolvedInVersion: Number,
    resolvedAt: Date,
  },
  { _id: false },
);

const mediaUnitSchema = new Schema(
  {
    /** SS-01 / DS-02: side prefix + unit number, unique inside its media item. */
    unitId: { type: String, required: true, maxlength: 20 },
    unitNo: { type: Number, required: true, min: 1, max: 999 },
    /** The key the field app uses for this unit (eg m1-u1), so its photos and answers land on the right unit. */
    fieldKey: { type: String, maxlength: 40 },
    status: { type: String, enum: UNIT_STATUSES, default: 'DRAFT' },
    currentVersion: { type: Number, default: 0 },
    approvedAt: Date,
    installationType: { type: String, enum: [...INSTALLATION_TYPES, null] },
    measurement: { type: measurementSchema },
    answers: { type: [answerSchema], default: [] },
    notes: { type: String, maxlength: 500 },
    /** Every photo of this unit, old and new (same id and stored file as the field app's photo; never overwritten). */
    photos: { type: [photoSchema], default: [] },
    versions: { type: [unitVersionSchema], default: [] },
    reviews: { type: [unitReviewSchema], default: [] },
    reworks: { type: [unitReworkSchema], default: [] },
  },
  { _id: false },
);

const mediaItemSchema = new Schema(
  {
    mediaKey: { type: String, required: true, maxlength: 20 },
    /** GSP, VINYL, … (from the field app's board name). */
    mediaType: { type: String, maxlength: 40 },
    sideType: { type: String, enum: SIDE_TYPES, default: 'SINGLE' },
    quantity: { type: Number, default: 1, min: 1, max: 999 },
    /** The board name as the field app shows it (eg "GSP Board"). */
    name: { type: String, maxlength: 80 },
    condition: { type: String, enum: ['EXISTING', 'PROPOSED'] },
    position: { type: String, maxlength: 120 },
    notes: { type: String, maxlength: 500 },
    installationNotes: { type: String, maxlength: 500 },
    units: { type: [mediaUnitSchema], default: [] },
  },
  { _id: false },
);


const submissionSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    site: { type: Schema.Types.ObjectId, ref: 'Site', required: true, unique: true },
    /** The mobile login doing this shop. A shop given to another person later is a recorded reassignment. */
    assignee: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channel: { type: String, enum: ['VENDOR', 'IN_HOUSE'] },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
    status: { type: String, enum: RECCE_STATUSES, default: 'IN_PROGRESS', index: true },
    /** Number of the latest submitted version (0 = never submitted). */
    currentVersion: { type: Number, default: 0 },
    mediaItems: { type: [mediaItemSchema], default: [] },
    notes: { type: String, default: '', maxlength: 2000 },
    /** Installation feasibility (draft, editable while the shop is open). Copied into each version at submit. */
    installation: { type: installationSchema },
    photos: { type: [photoSchema], default: [] },
    versions: { type: [versionSchema], default: [] },
    reviews: { type: [reviewSchema], default: [] },
    reworks: { type: [reworkSchema], default: [] },
    itemReviews: { type: [itemReviewSchema], default: [] },
    /** Unit counts rolled up from mediaItems[].units. */
    summary: { units: Number, approved: Number, underReview: Number, rework: Number, draft: Number },
    startedAt: Date,
    submittedAt: Date,
    /** Optional named reviewers per stage (set by Operations / Admin). */
    reviewers: { OPS: { type: Schema.Types.ObjectId, ref: 'User' }, CS: { type: Schema.Types.ObjectId, ref: 'User' } },
    priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH'], default: 'NORMAL' },
    attempts: { type: Number, default: 0 },
    finalApprovedAt: Date,
    /** The review stage waiting for a decision right now (null when nobody has to act), and when the review is due. */
    pendingStage: { type: String, enum: [...REVIEW_STAGES, null], default: null, index: true },
    dueAt: { type: Date, index: true },
    /** Bumped on every state change: the compare-and-set guard that makes the workflow transitions atomic. */
    rev: { type: Number, default: 0 },
  },
  { timestamps: true },
);
submissionSchema.index({ project: 1, status: 1 });
export const RecceSubmission = model('RecceSubmission', submissionSchema);
export type SubmissionDoc = InferSchemaType<typeof submissionSchema>;
/** The embedded parts, as stored. */
export type PhotoEntry = SubmissionDoc['photos'][number];
export type VersionEntry = SubmissionDoc['versions'][number];
export type ReviewEntry = SubmissionDoc['reviews'][number];
export type ReworkEntry = SubmissionDoc['reworks'][number];

/** Single configuration document: review order, checklist, required photos per media type, SLA. Edited by Admin. */
const configSchema = new Schema(
  {
    key: { type: String, unique: true, default: 'default' },
    stages: { type: [{ type: String, enum: REVIEW_STAGES }], default: ['OPS', 'CS'] },
    // false = both stages get the shop at the same time and decide in any order (default since 2026-11-23). true = the second stage waits for the first.
    sequential: { type: Boolean, default: false },
    allowRetryAfterReject: { type: Boolean, default: false },
    slaHours: { type: Number, default: 24 },
    maxPhotos: { type: Number, default: 40 },
    requireGps: { type: Boolean, default: false },
    checklist: {
      type: [{ _id: false, key: String, label: String, stage: { type: String, enum: [...REVIEW_STAGES, 'ALL'], default: 'ALL' }, gps: Boolean }],
      default: [
        { key: 'correct_shop', label: 'Correct shop', stage: 'ALL' },
        { key: 'shop_front', label: 'Shop front visible', stage: 'ALL' },
        { key: 'board_area', label: 'Board area visible', stage: 'ALL' },
        { key: 'angles', label: 'Required angles captured', stage: 'OPS' },
        { key: 'measurements', label: 'Measurements available', stage: 'OPS' },
        { key: 'media_type', label: 'Media type correct', stage: 'ALL' },
        { key: 'quantity', label: 'Required quantity verified', stage: 'ALL' },
        { key: 'quality', label: 'Photo quality acceptable', stage: 'OPS' },
        { key: 'gps', label: 'GPS evidence available', stage: 'OPS', gps: true },
        { key: 'client_req', label: 'Client requirement matched', stage: 'CS' },
      ],
    },
    /** Required photo categories. `default` applies to every media type; a key matching a media name (lower case, contains) overrides it. */
    /** Quantity-based units: the photos every unit needs and the questions asked per unit. */
    unitPhotoCategories: { type: [{ type: String, enum: PHOTO_CATEGORIES }], default: UNIT_PHOTO_CATEGORIES },
    unitQuestions: {
      type: [{ _id: false, key: String, label: String, type: { type: String, enum: ['YES_NO', 'TEXT', 'NUMBER', 'SELECT'], default: 'TEXT' }, options: [String], required: Boolean }],
      default: [
        { key: 'existing_board', label: 'Is there an existing board at this position?', type: 'YES_NO', required: true },
        { key: 'mounting_surface', label: 'Mounting surface', type: 'SELECT', options: ['Brick wall', 'Concrete', 'Glass', 'Metal sheet', 'Wood'], required: true },
        { key: 'power_available', label: 'Is power available within 5 ft?', type: 'YES_NO', required: true },
        { key: 'visibility', label: 'Board visibility from the road', type: 'SELECT', options: ['Clear', 'Partly blocked', 'Blocked'], required: true },
        { key: 'ladder_height', label: 'Installation height (ft)', type: 'NUMBER', required: false },
        { key: 'remarks', label: 'Remarks', type: 'TEXT', required: false },
      ],
    },
    requiredPhotos: { type: Schema.Types.Mixed, default: { default: ['SHOP_FRONT', 'NAME_BOARD'], measurement: ['SHOP_FRONT', 'NAME_BOARD', 'MEASUREMENT'] } },
  },
  { timestamps: true },
);
export const RecceConfig = model('RecceConfig', configSchema);

/** When a person last opened one shop's thread: messages from others after this moment are unread. One row per (shop, person). */
const threadReadSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    site: { type: Schema.Types.ObjectId, ref: 'Site', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastReadAt: { type: Date, required: true },
  },
  { timestamps: true },
);
threadReadSchema.index({ site: 1, user: 1 }, { unique: true });
export const RecceThreadRead = model('RecceThreadRead', threadReadSchema);
