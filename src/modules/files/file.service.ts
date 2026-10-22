import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { assertProjectAccess } from '../../common/project-access';
import { recordAudit } from '../audit/audit.service';
import { notifyProjectParty } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { permissionsFor, type Permission, type Role } from '../roles/roles';
import { SalesOrder } from '../sales/sales.model';
import { EmailTemplate } from '../templates/template.model';
import { CATEGORY_RULES, FILE_CATEGORIES, buildFileKey, kindOfFile, type FileCategory, type FileKind } from './file.categories';
import { FileAsset } from './file.model';
import { getStorage, getStorageFor, type StorageProvider } from './storage';
import type { StoredFile } from './storedFile.schema';

type StorageType = StorageProvider['type'];

const hasPerm = (role: string, p: Permission) => permissionsFor(role as Role).includes(p);
export const canReadCategory = (role: string, c: FileCategory) => CATEGORY_RULES[c].read.some((p) => hasPerm(role, p));
const readableCategories = (role: string) => FILE_CATEGORIES.filter((c) => !CATEGORY_RULES[c].standalone && canReadCategory(role, c));

const sizeLimit = (k: FileKind) => (k === 'image' ? env.MAX_IMAGE_SIZE : k === 'video' ? env.MAX_VIDEO_SIZE : env.MAX_FILE_SIZE);
const mb = (n: number) => `${Math.round((n / 1048576) * 10) / 10} MB`;

/** Cheap content sniffing so a renamed file (e.g. an .exe called photo.jpg) is rejected. */
function contentMatches(name: string, b: Buffer): boolean {
  const n = name.toLowerCase();
  if (/\.jpe?g$/.test(n)) return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (n.endsWith('.png')) return b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (n.endsWith('.webp')) return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  if (n.endsWith('.pdf')) return b.subarray(0, 4).toString('latin1') === '%PDF';
  if (/\.(xlsx|docx|pptx)$/.test(n)) return b[0] === 0x50 && b[1] === 0x4b;
  if (n.endsWith('.mp4')) return b.subarray(4, 8).toString('latin1') === 'ftyp';
  if (n.endsWith('.csv')) return !b.subarray(0, 4096).includes(0);
  return false;
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export function validateFiles(category: FileCategory, files: UploadedFile[]) {
  const rule = CATEGORY_RULES[category];
  if (!files.length) throw AppError.badRequest('Attach at least one file');
  for (const f of files) {
    const kind = kindOfFile(f.originalname);
    if (!kind) throw AppError.badRequest(`${f.originalname}: this file type is not allowed`);
    if (!rule.kinds.includes(kind)) throw AppError.badRequest(`${f.originalname}: ${kind} files are not accepted in ${category}`);
    if (f.size > sizeLimit(kind)) throw new AppError(413, 'FILE_TOO_LARGE', `${f.originalname} is larger than the ${mb(sizeLimit(kind))} limit for ${kind} files`);
    if (!contentMatches(f.originalname, f.buffer)) throw AppError.badRequest(`${f.originalname}: the file content does not match its type`);
  }
}

export function assertCanWrite(role: string, category: FileCategory) {
  if (!hasPerm(role, CATEGORY_RULES[category].write)) throw AppError.forbidden();
}

const view = (f: InstanceType<typeof FileAsset> | Record<string, any>) => ({
  id: String(f._id),
  project: f.project ? String(f.project) : null,
  category: f.category,
  originalName: f.originalName,
  mimeType: f.mimeType,
  kind: f.kind,
  size: f.size,
  storage: f.storage,
  uploadedBy: String(f.uploadedBy),
  createdAt: f.createdAt,
});

async function projectWithClient(projectId: string) {
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).populate<{ client: { _id: Types.ObjectId; name: string } }>('client', 'name');
  if (!project) throw AppError.notFound('Project not found');
  return project;
}

export async function uploadFiles(projectId: string, category: FileCategory, files: UploadedFile[], actor: Actor) {
  assertCanWrite(actor.role, category);
  if (CATEGORY_RULES[category].standalone) throw AppError.badRequest(`${category} files cannot be uploaded to a project`);
  await assertProjectAccess(actor, projectId);
  validateFiles(category, files);
  const project = await projectWithClient(projectId);
  const storage = getStorage();

  // The same file (by content) cannot be uploaded twice into the same project + category, within one request or across requests.
  const hashes = files.map((f) => createHash('sha256').update(f.buffer).digest('hex'));
  const inBatch = hashes.findIndex((h, i) => hashes.indexOf(h) !== i);
  if (inBatch !== -1) throw AppError.conflict(`${files[inBatch]!.originalname} was selected twice`);
  const existing = await FileAsset.findOne({ project: project._id, category, deletedAt: null, sha256: { $in: hashes } }).select('originalName sha256').lean();
  if (existing) {
    const dup = files[hashes.indexOf(existing.sha256 as string)]!;
    throw AppError.conflict(`${dup.originalname} was already uploaded to this project (as "${existing.originalName}")`);
  }

  const stored: string[] = [];
  try {
    const out = [];
    for (const f of files) {
      const kind = kindOfFile(f.originalname)!;
      const key = buildFileKey({ category, clientName: project.client.name, projectCode: project.code, originalName: f.originalname });
      await storage.put(key, f.buffer, f.mimetype);
      stored.push(key);
      const doc = await FileAsset.create({
        project: project._id,
        client: project.client._id,
        category,
        key,
        storage: storage.type,
        originalName: f.originalname,
        mimeType: f.mimetype,
        kind,
        size: f.size,
        sha256: hashes[files.indexOf(f)],
        uploadedBy: actor.id,
      });
      await recordAudit({ actor, action: 'UPLOAD', entity: 'FileAsset', entityId: doc._id, project: project._id, changes: [{ field: 'key', oldValue: null, newValue: key }, { field: 'category', oldValue: null, newValue: category }] });
      out.push(view(doc));
    }
    if (category === 'BD_CLIENT_DETAILS') {
      // One notification per hour per project, however many files were added, so Operations is not flooded.
      const bucket = new Date().toISOString().slice(0, 13);
      await notifyProjectParty(
        project._id,
        'assignee',
        {
          kind: 'DOCUMENTS_ADDED',
          title: 'Client documents added',
          body: `${out.length} new file${out.length > 1 ? 's' : ''} added to project ${project.code} (${project.client.name}).`,
          dedupe: (r) => `docs:${project._id}:${r}:${bucket}`,
        },
        actor.id,
      );
    }
    return out;
  } catch (e) {
    // Do not leave orphaned objects behind when a later file in the batch fails.
    await Promise.allSettled(stored.map((k) => storage.remove(k)));
    await FileAsset.deleteMany({ key: { $in: stored } });
    throw e;
  }
}

export async function listFiles(projectId: string, actor: Actor, category?: FileCategory) {
  const role = actor.role;
  if (category && !canReadCategory(role, category)) throw AppError.forbidden();
  await assertProjectAccess(actor, projectId);
  const items = await FileAsset.find({ project: projectId, deletedAt: null, category: category ?? { $in: readableCategories(role) } })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return items.map(view);
}

async function findLive(id: string) {
  const f = await FileAsset.findOne({ _id: id, deletedAt: null });
  if (!f) throw AppError.notFound('File not found');
  return f;
}

/** Short-lived read link. Files are private; this is the only way to open one. */
export async function fileUrl(id: string, actor: Actor) {
  const f = await findLive(id);
  if (!canReadCategory(actor.role, f.category as FileCategory)) throw AppError.forbidden();
  if (f.project) await assertProjectAccess(actor, String(f.project));
  const ttl = env.SIGNED_URL_TTL_SECONDS;
  const url = await getStorage().signedUrl(f.key, f.originalName, ttl);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), name: f.originalName, mimeType: f.mimeType };
}

export async function removeFile(id: string, actor: Actor) {
  const f = await findLive(id);
  assertCanWrite(actor.role, f.category as FileCategory);
  if (CATEGORY_RULES[f.category as FileCategory].standalone) throw AppError.badRequest('This file belongs to a BD CRM record and is managed there');
  await assertProjectAccess(actor, String(f.project));
  const evidence = CATEGORY_RULES[f.category as FileCategory].evidence;
  if (!evidence) await getStorage().remove(f.key);
  f.deletedAt = new Date();
  f.deletedBy = actor.id as never;
  f.objectRetained = evidence;
  await f.save();
  await recordAudit({ actor, action: 'DELETE', entity: 'FileAsset', entityId: f._id, project: f.project ?? undefined, reason: evidence ? 'Evidence retained in storage' : undefined });
  return { id, removed: evidence ? ('hidden' as const) : ('erased' as const) };
}

/* --------------------- BD CRM files (metadata kept inside their own record) --------------------- */

export interface EmbeddedFileInput {
  category: FileCategory;
  /** Folder segments: client name and sales order number (ignored by template categories). */
  clientName: string;
  folderKey: string;
  file: UploadedFile;
  actor: Actor;
  /** The record the file belongs to (audit trail). */
  owner: { entity: 'SalesOrder' | 'EmailTemplate'; id: Types.ObjectId | string };
}

/**
 * Stores one file for a sales order or email template with the same rules as project files (type, size, content
 * sniffing, private storage, never overwritten). No FileAsset row is written: the caller saves the returned metadata
 * in its own record, and calls discardStoredFiles() if that save fails.
 */
export async function storeEmbeddedFile(i: EmbeddedFileInput): Promise<StoredFile> {
  assertCanWrite(i.actor.role, i.category);
  if (!CATEGORY_RULES[i.category].standalone) throw AppError.badRequest(`${i.category} is a project file category`);
  validateFiles(i.category, [i.file]);
  const storage = getStorage();
  const key = buildFileKey({ category: i.category, clientName: i.clientName, projectCode: i.folderKey, originalName: i.file.originalname });
  await storage.put(key, i.file.buffer, i.file.mimetype);
  try {
    await recordAudit({ actor: i.actor, action: 'UPLOAD', entity: i.owner.entity, entityId: i.owner.id, changes: [{ field: 'file', oldValue: null, newValue: key }, { field: 'category', oldValue: null, newValue: i.category }] });
  } catch (e) {
    await storage.remove(key).catch(() => undefined);
    throw e;
  }
  return {
    fileId: new Types.ObjectId(),
    key,
    storage: storage.type,
    name: i.file.originalname,
    size: i.file.size,
    mimeType: i.file.mimetype,
    kind: kindOfFile(i.file.originalname)!,
    sha256: createHash('sha256').update(i.file.buffer).digest('hex'),
    uploadedBy: new Types.ObjectId(i.actor.id),
    uploadedAt: new Date(),
  };
}

/** Where a stored file lives. Records not yet migrated only carry `fileId`; their details are read from the old FileAsset row. */
async function locate(f: StoredFile) {
  if (f.key && f.storage) return { key: f.key, storage: f.storage as StorageType, name: f.name ?? 'file', mimeType: f.mimeType ?? 'application/octet-stream' };
  const a = await FileAsset.findById(f.fileId).lean();
  if (!a) return null;
  return { key: a.key, storage: a.storage as StorageType, name: a.originalName, mimeType: a.mimeType ?? 'application/octet-stream' };
}

function providerFor(type: StorageType) {
  const p = getStorageFor(type);
  if (!p) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'This file is stored in DigitalOcean Spaces, which is not configured on this server');
  return p;
}

/** File bytes, e.g. for an email attachment. */
export async function readStoredFile(f: StoredFile) {
  const at = await locate(f);
  if (!at) throw AppError.notFound('Attachment file not found');
  return { name: at.name, mimeType: at.mimeType, content: await providerFor(at.storage).get(at.key) };
}

/** Short-lived read link. The caller has already checked that the user may see the owning record. */
export async function storedFileUrl(f: StoredFile) {
  const at = await locate(f);
  if (!at) throw AppError.notFound('File not found');
  const ttl = env.SIGNED_URL_TTL_SECONDS;
  const url = await providerFor(at.storage).signedUrl(at.key, at.name, ttl);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), name: at.name, mimeType: at.mimeType };
}

/**
 * Erases the stored object from the storage it was uploaded to (local disk or Spaces). Call it only after the record
 * no longer points at the file. A storage failure is logged, not thrown: the record is already updated, so the user
 * sees a consistent state and the worst case is one orphaned object.
 */
export async function eraseStoredFile(f: StoredFile, actor: Actor, owner: EmbeddedFileInput['owner']) {
  try {
    const at = await locate(f);
    if (!at) return;
    const storage = getStorageFor(at.storage);
    if (!storage) {
      console.error(`file erase skipped: ${at.storage} storage is not configured`, { key: at.key, fileId: String(f.fileId) });
      return;
    }
    await storage.remove(at.key);
    await recordAudit({ actor, action: 'FILE_ERASED', entity: owner.entity, entityId: owner.id, changes: [{ field: 'file', oldValue: at.key, newValue: null }], reason: at.name });
  } catch (e) {
    console.error('file erase failed', { fileId: String(f.fileId), key: f.key }, e);
  }
}

/** Removes objects stored by storeEmbeddedFile() when saving the owning record failed. */
export async function discardStoredFiles(files: StoredFile[]) {
  await Promise.allSettled(files.map((f) => getStorageFor(f.storage as StorageType)?.remove(f.key!)));
}

/** Used by the signed local link: only serve keys that a live record still points at. */
export async function liveKey(key: string) {
  if (await FileAsset.exists({ key, deletedAt: null })) return true;
  const inOrder = await SalesOrder.exists({
    deletedAt: null,
    $or: ['salescommentsArray.attachments.key', 'approvalDocumentsArray.file.key', 'rateCardArray.pdf.key', 'salesprofile.attachments.key'].map((p) => ({ [p]: key })),
  });
  return !!inOrder || !!(await EmailTemplate.exists({ 'pdf.key': key }));
}
