import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

/**
 * TEAM     open to everyone with one of `allowedRoles` (every role when empty); only Admin / Management create them
 * PROJECT  one per project, members come from the project (BD owner, Recce assignee, coordinator, Client Servicing)
 * PRIVATE  invite only
 * DM       exactly two people
 */
export const CHANNEL_KINDS = ['TEAM', 'PROJECT', 'PRIVATE', 'DM'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['OWNER', 'MEMBER'], default: 'MEMBER' },
    joinedAt: { type: Date, default: Date.now },
    /** Everything newer than this (from other people) counts as unread. */
    lastReadAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const channelSchema = new Schema(
  {
    name: { type: String, trim: true, required: true },
    kind: { type: String, enum: CHANNEL_KINDS, required: true, index: true },
    topic: { type: String, trim: true, default: '' },
    project: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    allowedRoles: { type: [String], default: [] },
    members: { type: [memberSchema], default: [] },
    pinned: [{ type: Schema.Types.ObjectId, ref: 'ConnectMessage' }],
    /** Sorted pair of user ids; one DM per pair. */
    dmKey: String,
    archived: { type: Boolean, default: false },
    lastMessageAt: Date,
    lastMessagePreview: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
channelSchema.index({ 'members.user': 1, lastMessageAt: -1 });
channelSchema.index({ dmKey: 1 }, { unique: true, partialFilterExpression: { dmKey: { $type: 'string' } } });
channelSchema.index({ project: 1 }, { unique: true, partialFilterExpression: { kind: 'PROJECT' } });
export const ConnectChannel = model('ConnectChannel', channelSchema);
export type ChannelDoc = HydratedDocument<InferSchemaType<typeof channelSchema>>;

/** A stored file plus what a chat needs to show it: voice notes carry their length. */
const attachmentSchema = storedFileSchema.clone().add({ voice: Boolean, durationSec: Number, peaks: [Number] });

const messageSchema = new Schema(
  {
    channel: { type: Schema.Types.ObjectId, ref: 'ConnectChannel', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, default: '' },
    /** The first message of a thread. Replies point at it; a reply cannot be replied to. */
    parent: { type: Schema.Types.ObjectId, ref: 'ConnectMessage', default: null },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    attachments: { type: [attachmentSchema], default: [] },
    reactions: { type: [new Schema({ emoji: String, users: [{ type: Schema.Types.ObjectId, ref: 'User' }] }, { _id: false })], default: [] },
    replyCount: { type: Number, default: 0 },
    lastReplyAt: Date,
    editedAt: Date,
    deletedAt: Date,
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
messageSchema.index({ channel: 1, parent: 1, _id: -1 });
messageSchema.index({ channel: 1, createdAt: 1 });
messageSchema.index({ mentions: 1, createdAt: -1 });
export const ConnectMessage = model('ConnectMessage', messageSchema);
