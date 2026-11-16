import { Schema, model } from 'mongoose';

export const ROUTING_KEYS = ['PROJECT_CODE', 'CLIENT_CODE', 'VENDOR_REGISTRATION', 'VENDOR_RATE_APPROVAL'] as const;
export type RoutingKey = (typeof ROUTING_KEYS)[number];

/** Who each kind of request email goes to. Edited by the Super Admin; replaces the old env recipient lists. */
const mailRoutingSchema = new Schema(
  {
    _id: { type: String, enum: ROUTING_KEYS },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    bcc: { type: [String], default: [] },
    /** The mailbox replies are read from (used to fetch the code from the reply). */
    replyTo: String,
    /** Confirm the code on its own when the reply comes from one of the recipients and holds exactly one valid code. */
    autoConfirm: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const MailRouting = model('MailRouting', mailRoutingSchema);
