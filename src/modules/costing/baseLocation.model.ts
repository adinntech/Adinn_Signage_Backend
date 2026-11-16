import { Schema, model } from 'mongoose';

/**
 * A named place the in-house team starts from (Adinn Factory, Adinn Head Office). Anyone who plans pins it once on the map;
 * after that it is a choice in every project's start point list. Not tied to a project.
 */
const baseLocationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true, unique: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const BaseLocation = model('BaseLocation', baseLocationSchema);
