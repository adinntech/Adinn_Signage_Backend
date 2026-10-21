import { Schema, model } from 'mongoose';
import { FILE_CATEGORIES } from './file.categories';

/** Metadata only; the bytes live in local storage or DigitalOcean Spaces (never in MongoDB). */
const fileSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    category: { type: String, enum: FILE_CATEGORIES, required: true },
    /** Storage key, e.g. BD/Client_Details/AMUL/SGN-AMUL-2026-001/<file>. Unique: objects are never overwritten. */
    key: { type: String, required: true, unique: true },
    storage: { type: String, enum: ['local', 'space'], required: true },
    originalName: { type: String, required: true },
    mimeType: String,
    kind: { type: String, enum: ['image', 'video', 'document', 'sheet'], required: true },
    size: { type: Number, required: true },
    sha256: String,
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Set when the record is removed. Evidence categories keep the stored object. */
    deletedAt: Date,
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    objectRetained: Boolean,
  },
  { timestamps: true },
);
fileSchema.index({ project: 1, category: 1, createdAt: -1 });
export const FileAsset = model('FileAsset', fileSchema);
