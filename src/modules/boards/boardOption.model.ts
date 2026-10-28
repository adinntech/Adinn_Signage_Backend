import { Schema, model } from 'mongoose';
import { UNITS } from '../sites/site.fields';

export const BOARD_DECISIONS = ['PENDING', 'APPROVED', 'REJECTED', 'CHANGED'] as const;
export type BoardDecision = (typeof BOARD_DECISIONS)[number];

/**
 * One board that could fit one shop. A shop can have several options; BD / Operations record what the client decided:
 * APPROVED (this board is fine), REJECTED (not this shop / board) or CHANGED (client wants another board instead).
 */
const boardOptionSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    site: { type: Schema.Types.ObjectId, ref: 'Site', required: true },
    boardType: { type: String, required: true, trim: true },
    width: Number,
    height: Number,
    unit: { type: String, enum: UNITS, default: 'ft' },
    quantity: { type: Number, default: 1, min: 1 },
    sqft: Number,
    notes: String,
    decision: { type: String, enum: BOARD_DECISIONS, default: 'PENDING' },
    decisionRemark: String,
    decidedAt: Date,
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
boardOptionSchema.index({ project: 1, site: 1, createdAt: 1 });
boardOptionSchema.index({ project: 1, decision: 1 });
export const BoardOption = model('BoardOption', boardOptionSchema);
