import { Schema, model } from 'mongoose';

/**
 * Recce cost module: INTERNAL cost tracking only. Nothing here feeds client invoices, quotations or receivables.
 */

export const TRIP_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SETTLED'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
export const TRANSPORT_TYPES = ['PUBLIC', 'PRIVATE'] as const;
export const LEG_MODES = ['BUS', 'TRAIN', 'AUTO', 'CAB', 'RAPIDO', 'METRO', 'BIKE', 'OTHER'] as const;
export const VEHICLE_TYPES = ['BIKE', 'CAR', 'OTHER'] as const;
export const MISC_TYPES = ['PARKING', 'TOLL', 'LOCAL_TRAVEL', 'LUGGAGE', 'PRINTING', 'PHOTOCOPY', 'SMALL_PURCHASE', 'OTHER'] as const;
export const STAY_ORIGINS = ['OFFICE', 'CURRENT_LOCATION'] as const;

/** Admin-set rates. Every change is a NEW version (effectiveFrom); old versions stay as the change history. */
const mealWindow = { from: { type: String, required: true }, to: { type: String, required: true }, amount: { type: Number, required: true, min: 0 } };
const rateConfigSchema = new Schema(
  {
    effectiveFrom: { type: Date, required: true, index: true },
    kmRate: { type: Number, required: true, min: 0 },
    breakfast: mealWindow,
    lunch: mealWindow,
    dinner: mealWindow,
    dailyFoodMax: { type: Number, required: true, min: 0 },
    /** Minutes the trip must overlap a meal window before that meal is suggested. */
    mealMinOverlapMinutes: { type: Number, required: true, min: 0 },
    stayDistanceKm: { type: Number, required: true, min: 0 },
    stayDurationHours: { type: Number, required: true, min: 0 },
    stayPerNight: { type: Number, required: true, min: 0 },
    stayMaxAmount: { type: Number, required: true, min: 0 },
    stayOrigin: { type: String, enum: STAY_ORIGINS, default: 'OFFICE' },
    /** A bill is mandatory for any single travel leg / misc expense above this amount. */
    receiptRequiredAbove: { type: Number, required: true, min: 0 },
    /** A claim whose total is above this needs Super Admin (not just Finance) approval. */
    adminApprovalAbove: { type: Number, required: true, min: 0 },
    /** Odometer distance above this in one trip is flagged for review. */
    maxTripKm: { type: Number, required: true, min: 1 },
    note: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const RecceRateConfig = model('RecceRateConfig', rateConfigSchema);

const gps = new Schema({ lat: Number, lng: Number, accuracy: Number, address: String }, { _id: false });
const odo = new Schema(
  {
    reading: { type: Number, min: 0 },
    photoFileId: Schema.Types.ObjectId,
    gps,
    capturedAt: Date,
    uploadedAt: Date,
  },
  { _id: false },
);

const legSchema = new Schema({
  from: { type: String, required: true, trim: true, maxlength: 120 },
  to: { type: String, required: true, trim: true, maxlength: 120 },
  district: { type: String, trim: true, maxlength: 80 },
  mode: { type: String, enum: LEG_MODES, required: true },
  at: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0 },
  receiptFileId: Schema.Types.ObjectId,
  remarks: { type: String, maxlength: 300 },
});
const miscSchema = new Schema({
  type: { type: String, enum: MISC_TYPES, required: true },
  date: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  description: { type: String, trim: true, maxlength: 200 },
  remarks: { type: String, maxlength: 300 },
  receiptFileId: Schema.Types.ObjectId,
  site: { type: Schema.Types.ObjectId, ref: 'Site' },
  shopRef: { type: String, trim: true, maxlength: 120 },
});
const historySchema = new Schema({ at: { type: Date, default: Date.now }, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, action: String, from: String, to: String, remark: String }, { _id: false });

/**
 * One recce trip of an in-house employee for one project: transport (public legs OR private vehicle), food, stay and
 * miscellaneous bills. Amounts are always recalculated on the server; `calc` is the stored result and
 * `rateSnapshot` freezes the rates used, so a later Admin rate change never touches a submitted / approved claim.
 */
const tripSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    clientCode: String,
    projectCode: String,
    employee: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeName: String,
    status: { type: String, enum: TRIP_STATUSES, default: 'DRAFT', index: true },
    startAt: { type: Date, required: true },
    endAt: Date,
    transportType: { type: String, enum: TRANSPORT_TYPES, required: true },
    legs: [legSchema],
    vehicle: { type: { type: String, enum: VEHICLE_TYPES }, regNo: { type: String, trim: true, uppercase: true, maxlength: 20 } },
    odoStart: odo,
    odoEnd: odo,
    misc: [miscSchema],
    // Stay
    stayOrigin: { type: String, enum: STAY_ORIGINS },
    startLocation: String,
    destination: String,
    /** Public transport has no odometer: the distance / duration are entered by hand (no routing API is wired in). */
    manualDistanceKm: { type: Number, min: 0 },
    manualDistanceEvidence: String,
    estimatedTravelHours: { type: Number, min: 0 },
    stayNights: { type: Number, min: 0, default: 0 },
    stayClaimed: { type: Number, min: 0, default: 0 },
    stayBillFileId: Schema.Types.ObjectId,
    stayRemarks: String,
    stayException: { approved: Boolean, by: { type: Schema.Types.ObjectId, ref: 'User' }, reason: String },
    foodClaimed: { type: Number, min: 0 },
    foodRemarks: String,
    /** Server-computed figures (re-derived on every save). */
    calc: { type: Schema.Types.Mixed },
    flags: [String],
    rateSnapshot: { type: Schema.Types.Mixed },
    /** Per-component amounts the reviewer approved. */
    approved: { transport: Number, food: Number, stay: Number, misc: Number, total: Number },
    reviewRemark: String,
    history: [historySchema],
  },
  { timestamps: true },
);
tripSchema.index({ client: 1, startAt: -1 });
tripSchema.index({ employee: 1, startAt: -1 });
export const RecceTrip = model('RecceTrip', tripSchema);

/** Vendor recce rate card: one active plan per vendor + recce type + date range. */
const vendorRateSchema = new Schema(
  {
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    recceType: { type: String, required: true, trim: true, maxlength: 60 },
    ratePerShop: { type: Number, min: 0, default: 0 },
    ratePerDay: { type: Number, min: 0, default: 0 },
    ratePerLocation: { type: Number, min: 0, default: 0 },
    fixedProjectRate: { type: Number, min: 0, default: 0 },
    travelCharges: { type: Number, min: 0, default: 0 },
    stayCharges: { type: Number, min: 0, default: 0 },
    otherCharges: { type: Number, min: 0, default: 0 },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const VendorRecceRateCard = model('VendorRecceRateCard', vendorRateSchema);

/** The vendor rate applied to one project assignment, frozen at the time it was applied. */
const vendorCostSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    clientCode: String,
    projectCode: String,
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    rateCard: { type: Schema.Types.ObjectId, ref: 'VendorRecceRateCard' },
    recceType: String,
    shops: { type: Number, min: 0, default: 0 },
    days: { type: Number, min: 0, default: 0 },
    locations: { type: Number, min: 0, default: 0 },
    scope: String,
    additional: { type: Number, min: 0, default: 0 },
    snapshot: { type: Schema.Types.Mixed },
    total: { type: Number, required: true },
    appliedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
vendorCostSchema.index({ project: 1, vendor: 1 }, { unique: true });
export const VendorRecceCost = model('VendorRecceCost', vendorCostSchema);
