import { Schema, model } from 'mongoose';
import { DEFAULT_RATES } from './costing.calc';

export const VENDOR_TYPES = ['ONE_MAN', 'ORGANIZATION'] as const;
export const PLAN_STATUSES = ['DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'CONFIRMED'] as const;
export const CLIENT_DECISIONS = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export const CHANNELS = ['VENDOR', 'IN_HOUSE'] as const;

const ratesShape = Object.fromEntries(Object.entries(DEFAULT_RATES).map(([k, v]) => [k, { type: Number, default: v, min: 0 }]));

/** Company-wide default rates. One document; every new cost plan copies it, so later changes never rewrite old plans. */
const policySchema = new Schema({ key: { type: String, default: 'default', unique: true }, ...ratesShape, updatedBy: { type: Schema.Types.ObjectId, ref: 'User' } }, { timestamps: true });
export const CostPolicy = model('CostPolicy', policySchema);

/** One per project: the inputs, the rates they were priced with, the chosen channel and who approved it. */
const planSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, unique: true },
    rates: ratesShape,
    vendorType: { type: String, enum: VENDOR_TYPES },
    vendorName: String,
    /** The registered vendor this plan prices; their own rate card (if any) replaces the company rates. */
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    shops: { type: Number, required: true, min: 1 },
    shopsCovered: Number,
    vendorDistanceKm: { type: Number, default: 0 },
    vendorOther: { type: Number, default: 0 },
    days: { type: Number, default: 1 },
    nights: { type: Number, default: 0 },
    totalKm: { type: Number, default: 0 },
    fuelAmount: { type: Number, default: 0 },
    otherAmount: { type: Number, default: 0 },
    clientsShared: { type: Number, default: 1 },
    chosen: { type: String, enum: CHANNELS },
    status: { type: String, enum: PLAN_STATUSES, default: 'DRAFT' },
    justification: String,
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    requestedAt: Date,
    reviewRemark: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    clientDecision: { type: String, enum: CLIENT_DECISIONS, default: 'PENDING' },
    clientRemark: String,
    clientDecidedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const CostPlan = model('CostPlan', planSchema);
