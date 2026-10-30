import { Schema, model } from 'mongoose';

/** A comment an admin leaves on one stage of a project's journey ("waiting for client PO", "chased on 12 Nov"). */
const journeyCommentSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    stage: { type: String, required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true },
  },
  { timestamps: true },
);
journeyCommentSchema.index({ project: 1, stage: 1, createdAt: -1 });
export const JourneyComment = model('JourneyComment', journeyCommentSchema);
