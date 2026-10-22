import { Schema, model } from 'mongoose';

/** One browser (or phone) that allowed notifications for one person. A person can have several (office PC, laptop...). */
const pushSubscriptionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: String,
    lastSuccessAt: Date,
    failures: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const PushSubscription = model('PushSubscription', pushSubscriptionSchema);
