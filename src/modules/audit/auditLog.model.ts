import { Schema, model, type Types } from 'mongoose';

const auditSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  action: { type: String, required: true }, // CREATE | UPDATE | STATUS_CHANGE | DELETE | ...
  entity: { type: String, required: true, index: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  project: { type: Schema.Types.ObjectId, index: true },
  changes: [{ _id: false, field: String, oldValue: Schema.Types.Mixed, newValue: Schema.Types.Mixed }],
  reason: String,
  at: { type: Date, default: Date.now, index: true },
});
auditSchema.index({ entity: 1, entityId: 1, at: -1 });
export const AuditLog = model('AuditLog', auditSchema);

export interface AuditInput {
  actor: { id: string; role: string };
  action: string;
  entity: string;
  entityId: Types.ObjectId | string;
  project?: Types.ObjectId | string | undefined;
  changes?: { field: string; oldValue: unknown; newValue: unknown }[];
  reason?: string | undefined;
}
