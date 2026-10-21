import { Schema, model } from 'mongoose';

/** ASO projects: the area / sales office the team visits, how many shops were found and what was discussed. */
const surveyAreaSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    area: { type: String, required: true, trim: true },
    areaKey: { type: String, required: true }, // normalised name, used for the duplicate check
    notes: String,
    shopsFound: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
surveyAreaSchema.index({ project: 1, areaKey: 1 }, { unique: true });
export const SurveyArea = model('SurveyArea', surveyAreaSchema);
