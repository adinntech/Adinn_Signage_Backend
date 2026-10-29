import { Schema, model } from 'mongoose';
import { storedFileSchema } from '../files/storedFile.schema';

export const NOTE_VISIBILITY = ['PROJECT', 'PRIVATE'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITY)[number];

/** A note on a project. PROJECT = everyone on the project (and Admin / Management); PRIVATE = only its author. */
const noteSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, default: '' },
    visibility: { type: String, enum: NOTE_VISIBILITY, default: 'PROJECT' },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    attachments: { type: [storedFileSchema], default: [] },
    editedAt: Date,
  },
  { timestamps: true },
);
noteSchema.index({ project: 1, createdAt: -1 });
export const ProjectNote = model('ProjectNote', noteSchema);

/** The note a person is typing, saved as they type so nothing is lost. One per person per project. */
const draftSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, default: '' },
    visibility: { type: String, enum: NOTE_VISIBILITY, default: 'PROJECT' },
  },
  { timestamps: true },
);
draftSchema.index({ project: 1, author: 1 }, { unique: true });
export const NoteDraft = model('NoteDraft', draftSchema);

/** A recorded voice note on a project, with a small waveform (bar heights 0 to 100) so it can be drawn without decoding the audio. */
const voiceSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, trim: true, default: '' },
    file: { type: storedFileSchema, required: true },
    durationSec: { type: Number, default: 0 },
    peaks: { type: [Number], default: [] },
  },
  { timestamps: true },
);
voiceSchema.index({ project: 1, createdAt: -1 });
export const ProjectVoiceNote = model('ProjectVoiceNote', voiceSchema);
