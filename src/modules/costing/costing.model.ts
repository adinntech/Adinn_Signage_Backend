import { Schema, model } from 'mongoose';
import { DEFAULT_RATES } from './costing.calc';

export const PLAN_STATUSES = ['DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'CONFIRMED', 'ASSIGNED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const CLIENT_DECISIONS = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export const CHANNELS = ['VENDOR', 'IN_HOUSE'] as const;

const ratesShape = Object.fromEntries(Object.entries(DEFAULT_RATES).map(([k, v]) => [k, { type: Number, default: v, min: 0 }]));

/**
 * Company-wide rates, set by admin. One document; every new plan copies it, so a later change never rewrites an old plan
 * (a plan can be told to pick up the latest rates).
 */
const policySchema = new Schema({ key: { type: String, default: 'default', unique: true }, ...ratesShape, updatedBy: { type: Schema.Types.ObjectId, ref: 'User' } }, { timestamps: true });
export const CostPolicy = model('CostPolicy', policySchema);

/**
 * One area of the project (normally a district) with its shops, and how it will be done: by the in-house team or by a
 * vendor. Several areas can go different ways, e.g. Madurai in-house, Coimbatore vendor A, Trichy vendor B.
 */
const legSchema = new Schema(
  {
    key: { type: String, required: true }, // stable id of the area, e.g. the normalised district name
    name: { type: String, required: true, trim: true },
    /** The district text the shops carry; shops with this district are given to the chosen channel when the plan is assigned. */
    district: String,
    shops: { type: Number, required: true, min: 1 },
    distanceKm: { type: Number, default: 0 },
    routeKm: Number,
    deadline: String, // yyyy-mm-dd, the date the recce must be done by
    channel: { type: String, enum: CHANNELS },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    vendorName: String,
    vendorRate: Number,
    cardRate: Number,
    cardFarRate: Number,
    vendorOther: { type: Number, default: 0 },
    tripStart: String, // yyyy-mm-ddThh:mm, wall-clock time
    tripEnd: String,
    clientsShared: { type: Number, default: 1 },
    otherAmount: { type: Number, default: 0 },
  },
  { _id: false },
);

/** One per project: the areas, the rates they were priced with, the approval and who it was assigned by. */
const planSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, unique: true },
    rates: ratesShape,
    legs: { type: [legSchema], default: [] },
    status: { type: String, enum: PLAN_STATUSES, default: 'DRAFT' },
    justification: String,
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    requestedAt: Date,
    reviewRemark: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    assignedAt: Date,
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    clientDecision: { type: String, enum: CLIENT_DECISIONS, default: 'PENDING' },
    clientRemark: String,
    clientDecidedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const CostPlan = model('CostPlan', planSchema);
