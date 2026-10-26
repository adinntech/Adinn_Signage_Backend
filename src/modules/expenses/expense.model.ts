import { Schema, model } from 'mongoose';

export const EXPENSE_CATEGORIES = ['TRAVEL', 'FUEL', 'FOOD', 'STAY', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/**
 * One claim line from the recce team (mobile app or web). The bill / ticket / receipt is a normal project file in the
 * RECCE_EXPENSE category; `receiptFileId` points to it. A claim is paid only with proof, and Finance / Admin approves it.
 */
const expenseSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    note: String,
    receiptFileId: Schema.Types.ObjectId,
    status: { type: String, enum: EXPENSE_STATUSES, default: 'PENDING' },
    reviewRemark: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true },
);
expenseSchema.index({ project: 1, date: -1 });
export const Expense = model('Expense', expenseSchema);
