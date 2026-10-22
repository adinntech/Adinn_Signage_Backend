import { Schema, model } from 'mongoose';

export const NOTIFICATION_KINDS = [
  'PROJECT_ASSIGNED',
  'PROJECT_REASSIGNED',
  'DOCUMENTS_ADDED',
  'SHOPS_IMPORTED',
  'STAGE_CHANGED',
  'APPROVAL_CORRECTION',
  'PROJECT_CANCELLED',
  /** Any other create / edit / delete on a project, sent to the people working on it. */
  'ACTIVITY',
  /** The same, for Super Admin: everything everyone does, in the app only. */
  'ADMIN_ACTIVITY',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** One attempt trail per channel. In-app delivery is the notification record itself; EMAIL and browser PUSH are tracked here. */
const deliverySchema = new Schema(
  {
    channel: { type: String, enum: ['EMAIL', 'PUSH'], required: true },
    status: { type: String, enum: DELIVERY_STATUSES, required: true },
    to: String,
    attempts: { type: Number, default: 0 },
    lastError: String,
    sentAt: Date,
    updatedAt: Date,
  },
  { _id: false },
);

/**
 * A notification for exactly one person. Read state and delivery status live in MongoDB, so every
 * "who was told, when, and did they open it" question is answerable without any external service.
 */
const notificationSchema = new Schema(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    project: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    projectCode: String,
    clientName: String,
    /** Same event for the same person is stored once, so retries and double clicks never notify twice. */
    dedupeKey: { type: String, required: true, unique: true },
    readAt: Date,
    deliveries: [deliverySchema],
  },
  { timestamps: true },
);
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1 });
notificationSchema.index({ 'deliveries.status': 1, 'deliveries.attempts': 1 });
export const Notification = model('Notification', notificationSchema);
