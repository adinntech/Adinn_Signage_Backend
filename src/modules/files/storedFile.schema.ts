import { Schema, type Types } from 'mongoose';

/**
 * A file owned by a BD CRM record (sales order comment / approval / rate card / sent email, email template PDF).
 * The full metadata lives inside the owning record; there is no FileAsset row. The bytes live in local storage or
 * DigitalOcean Spaces (`storage`), never in MongoDB.
 *
 * `fileId` is the file's own id: clients open it with GET /sales/orders/:id/files/:fileId/url. Ids that existed when
 * these files were FileAsset rows are kept by the migration, so old links keep working.
 */
export const storedFileSchema = new Schema(
  {
    fileId: { type: Schema.Types.ObjectId, required: true },
    key: String,
    storage: { type: String, enum: ['local', 'space'] },
    name: String,
    size: Number,
    mimeType: String,
    kind: { type: String, enum: ['image', 'video', 'document', 'sheet'] },
    sha256: String,
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: Date,
  },
  { _id: false },
);

export interface StoredFile {
  fileId: Types.ObjectId;
  /** Missing only on records not yet migrated from FileAsset. */
  key?: string | null | undefined;
  storage?: 'local' | 'space' | string | null | undefined;
  name?: string | null | undefined;
  size?: number | null | undefined;
  mimeType?: string | null | undefined;
  kind?: string | null | undefined;
  sha256?: string | null | undefined;
  uploadedBy?: Types.ObjectId | null | undefined;
  uploadedAt?: Date | null | undefined;
}
