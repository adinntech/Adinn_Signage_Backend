import { Schema, model } from 'mongoose';
import { CATALOG_ICONS, QUESTION_SCOPES, QUESTION_TYPES, SIDEDNESS } from './catalog.types';

/**
 * Global master data (not owned by a project, so no project cascade). Boards store the media NAME, `mediaCode`, `installationType` and the
 * answers as plain values, so editing or deleting a catalog entry never changes a recce that was already made.
 */

const mediaSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, maxlength: 30 },
    shortName: { type: String, required: true, maxlength: 30 },
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 200 },
    icon: { type: String, enum: CATALOG_ICONS, default: 'category_outlined' },
    color: { type: String, default: '#455A64', match: /^#[0-9A-Fa-f]{6}$/ },
    illuminated: { type: Boolean, default: false },
    sidedness: { type: String, enum: SIDEDNESS, default: 'SINGLE' },
    depthFt: { type: Number, default: 0, min: 0, max: 20 },
    thicknessMm: { type: Number, default: 0, min: 0, max: 200 },
    /** Id of the 3D model template the phone draws (empty = the generic one). Not edited in the admin screens. */
    template: { type: String, default: '', maxlength: 30 },
    /** Installation codes allowed for this media, in the order they are offered. */
    installations: { type: [{ type: String, maxlength: 40 }], default: [] },
    /** Older media kept so old records stay readable: never offered for a new board. */
    legacy: { type: Boolean, default: false },
    /** false = hidden from new boards, still known to the boards that already use it. */
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const CatalogMedia = model('CatalogMedia', mediaSchema);

const installationSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, maxlength: 40 },
    name: { type: String, required: true, maxlength: 60 },
    description: { type: String, default: '', maxlength: 200 },
    icon: { type: String, enum: CATALOG_ICONS, default: 'category_outlined' },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const CatalogInstallation = model('CatalogInstallation', installationSchema);

const questionSchema = new Schema(
  {
    scope: { type: String, enum: QUESTION_SCOPES, required: true },
    /** The media code (scope MEDIA) or installation code (scope INSTALLATION); empty for COMMON. */
    scopeCode: { type: String, default: '', maxlength: 40 },
    /** The key the answer is stored under on a board. Never changes once answers exist. */
    id: { type: String, required: true, maxlength: 50 },
    label: { type: String, required: true, maxlength: 120 },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    options: { type: [{ type: String, maxlength: 60 }], default: [] },
    unit: { type: String, maxlength: 10 },
    required: { type: Boolean, default: true },
    hint: { type: String, maxlength: 120 },
    /** Only ask this question when the answer to question `showIfId` equals `showIfValue`. */
    showIfId: { type: String, maxlength: 50 },
    showIfValue: Schema.Types.Mixed,
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
questionSchema.index({ scope: 1, scopeCode: 1, id: 1 }, { unique: true });
export const CatalogQuestion = model('CatalogQuestion', questionSchema);

/** One counter, raised by every write: the phone asks "has the catalog changed since version N" with one cheap call. */
const metaSchema = new Schema({ _id: { type: String, default: 'catalog' }, version: { type: Number, default: 1 }, /** Set once the built-in list was loaded: a catalog the admin later empties is NOT filled again. */ seededAt: Date });
export const CatalogMeta = model('CatalogMeta', metaSchema);
