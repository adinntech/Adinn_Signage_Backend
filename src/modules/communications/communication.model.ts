import { Schema, model } from 'mongoose';

export const MESSAGE_TYPES = ['EMAIL', 'NOTE', 'SYSTEM', 'WHATSAPP_REF', 'FILE', 'APPROVAL'] as const;

const attachment = new Schema({ name: String, size: Number, mimeType: String, fileId: String, url: String }, { _id: false });
const address = new Schema({ name: String, email: { type: String, lowercase: true, trim: true } }, { _id: false });

const messageSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', index: true }, // null = unlinked inbox mail
    threadId: { type: String, required: true, index: true },
    parent: { type: Schema.Types.ObjectId, ref: 'CommunicationMessage' },
    type: { type: String, enum: MESSAGE_TYPES, required: true },
    direction: { type: String, enum: ['INBOUND', 'OUTBOUND', 'INTERNAL'], default: 'INTERNAL' },
    // Outbound mail is only logged until an email provider is configured.
    deliveryStatus: { type: String, enum: ['RECEIVED', 'LOGGED', 'SENT', 'FAILED'] },
    from: address,
    to: [address],
    cc: [address],
    subject: String,
    body: { type: String, default: '' },
    attachments: [attachment],
    sentAt: { type: Date, default: Date.now, index: true },
    actioned: { type: Boolean, default: false, index: true },
    actionedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    actionedAt: Date,
    actionNote: String,
    approval: {
      status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'] },
      requestedTo: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedAt: Date,
      comment: String,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
messageSchema.index({ project: 1, sentAt: -1 });
messageSchema.index({ subject: 'text', body: 'text' });
export const CommunicationMessage = model('CommunicationMessage', messageSchema);

const participant = new Schema(
  {
    name: { type: String, required: true },
    role: String, // BD | Recce | Client | Client Servicing | Support | Operations
    phone: String,
    email: String,
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    included: { type: Boolean, default: true },
  },
  { _id: false },
);

const channelSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    kind: { type: String, enum: ['WITH_CLIENT', 'INTERNAL'], required: true },
    groupName: String,
    participants: [participant],
    status: { type: String, enum: ['NOT_CREATED', 'LINKED'], default: 'NOT_CREATED' },
    externalGroupId: String,
    externalGroupUrl: String,
    linkedAt: Date,
    linkedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
channelSchema.index({ project: 1, kind: 1 }, { unique: true });
export const CommunicationChannel = model('CommunicationChannel', channelSchema);
