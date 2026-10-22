import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { assertNotCancelled, assertProjectAccess } from '../../common/project-access';
import { recordAudit } from '../audit/audit.service';
import { notifyProjectParty } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { permissionsFor, type Permission, type Role } from '../roles/roles';
import { SalesOrder } from '../sales/sales.model';
import { EmailTemplate } from '../templates/template.model';
import { CATEGORY_RULES, FILE_CATEGORIES, SECTION_LABEL, buildFileKey, kindOfFile, type FileCategory, type FileKind } from './file.categories';
import { getStorage, getStorageFor, type StorageProvider, type Disposition } from './storage';
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

/** A file as recorded inside its project document (Project.files). `_id` is the file id. */
export interface FileEntry {
  _id: Types.ObjectId;
  section?: string | null;
  category: string;
  key: string;
  storage: 'local' | 'space';
  path?: string | null;
  url?: string | null;
  originalName: string;
  mimeType?: string | null;
  kind: FileKind;
  size?: number | null;
  sha256?: string | null;
  uploadedBy?: Types.ObjectId | null;
  uploadedAt?: Date | null;
  deletedAt?: Date | null;
  deletedBy?: Types.ObjectId | null;
  objectRetained?: boolean | null;
}

const isLive = (f: FileEntry) => !f.deletedAt;

const view = (f: FileEntry, projectId: Types.ObjectId | string) => ({
  id: String(f._id),
  project: f.project ? String(f.project) : null,
  category: f.category,
  originalName: f.originalName,
  mimeType: f.mimeType,
  kind: f.kind,
  size: f.size,
  storage: f.storage,
  /** Full public URL (Spaces only). */
  url: f.url ?? undefined,
  section: f.section ?? undefined,
  uploadedBy: f.uploadedBy ? String(f.uploadedBy) : undefined,
  createdAt: f.uploadedAt,
});

async function projectFiles(projectId: string | Types.ObjectId): Promise<FileEntry[]> {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('files').lean();
  return ((p?.files ?? []) as unknown as FileEntry[]).filter(isLive);
}

async function projectWithClient(projectId: string) {
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).populate<{ client: { _id: Types.ObjectId; name: string } }>('client', 'name');
  if (!project) throw AppError.notFound('Project not found');
  if (!project.client) throw AppError.conflict('The client of this project no longer exists. Ask an admin to restore the client or re-create the project.');
  return project;
}

export async function uploadFiles(projectId: string, category: FileCategory, files: UploadedFile[], actor: Actor) {
  assertCanWrite(actor.role, category);
  if (CATEGORY_RULES[category].standalone) throw AppError.badRequest(`${category} files cannot be uploaded to a project`);
  await assertProjectAccess(actor, projectId);
  await assertNotCancelled(projectId);
  validateFiles(category, files);
  const project = await projectWithClient(projectId);
  const storage = getStorage();

  // The same file (by content) cannot be uploaded twice into the same project + category, within one request or across requests.
  const hashes = files.map((f) => createHash('sha256').update(f.buffer).digest('hex'));
  const inBatch = hashes.findIndex((h, i) => hashes.indexOf(h) !== i);
  if (inBatch !== -1) throw AppError.conflict(`${files[inBatch]!.originalname} was selected twice`);
  const existing = (await projectFiles(project._id)).find((f) => f.category === category && f.sha256 && hashes.includes(f.sha256));
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
      const entry: FileEntry = {
        _id: new Types.ObjectId(),
        section: SECTION_LABEL[category],
        category,
        key,
        storage: storage.type,
        ...(storage.locate ? storage.locate(key) : {}),
        originalName: f.originalname,
        mimeType: f.mimetype,
        kind,
        size: f.size,
        sha256: hashes[files.indexOf(f)]!,
        uploadedBy: new Types.ObjectId(actor.id),
        uploadedAt: new Date(),
      };
      await Project.updateOne({ _id: project._id }, { $push: { files: entry } });
      await recordAudit({ actor, action: 'UPLOAD', entity: 'FileAsset', entityId: entry._id, project: project._id, changes: [{ field: 'key', oldValue: null, newValue: key }, { field: 'category', oldValue: null, newValue: category }] });
      out.push(view(entry, project._id));
    }
    if (category === 'BD_CLIENT_DETAILS') {
      // One notification per upload (however many files it holds). Keyed on the first file so every new upload is announced.
      const batch = out[0]?.id ?? Date.now();
      await notifyProjectParty(
        project._id,
        'assignee',
        {
          kind: 'DOCUMENTS_ADDED',
          title: 'Client documents added',
          body: `${out.length} new file${out.length > 1 ? 's' : ''} added to project ${project.code} (${project.client.name}).`,
          dedupe: (r) => `docs:${project._id}:${r}:${batch}`,
        },
        actor.id,
      );
    }
    return out;
  } catch (e) {
    // Do not leave orphaned objects behind when a later file in the batch fails.
    await Promise.allSettled(stored.map((k) => storage.remove(k)));
    await Project.updateOne({ _id: project._id }, { $pull: { files: { key: { $in: stored } } } });
    throw e;
  }
}

export async function listFiles(projectId: string, actor: Actor, category?: FileCategory) {
  const role = actor.role;
  if (category && !canReadCategory(role, category)) throw AppError.forbidden();
  await assertProjectAccess(actor, projectId);
  const allowed = category ? [category as string] : (readableCategories(role) as string[]);
  return (await projectFiles(projectId))
    .filter((f) => allowed.includes(f.category))
    .sort((a, b) => +(b.uploadedAt ?? 0) - +(a.uploadedAt ?? 0))
    .slice(0, 500)
    .map((f) => view(f, projectId));
}

/** Finds a live file by id inside whichever project holds it. */
async function findLive(id: string) {
  const p = await Project.findOne({ 'files._id': id, deletedAt: null }).select('files').lean();
  const f = ((p?.files ?? []) as unknown as FileEntry[]).find((x) => String(x._id) === String(id) && isLive(x));
  if (!p || !f) throw AppError.notFound('File not found');
  return { ...f, project: p._id as Types.ObjectId };
}

/** Short-lived read link. Used for previews and downloads under the original name. */
export async function fileUrl(id: string, actor: Actor, disposition: Disposition = 'inline') {
  const f = await findLive(id);
  if (!canReadCategory(actor.role, f.category as FileCategory)) throw AppError.forbidden();
  if (f.project) await assertProjectAccess(actor, String(f.project));
  const ttl = env.SIGNED_URL_TTL_SECONDS;
  const url = await getStorageFor(f.storage).signedUrl(f.key, f.originalName, ttl, disposition);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), name: f.originalName, mimeType: f.mimeType };
}

/** The file's bytes for an in-app preview. Same access rules as the signed link. */
export async function fileContent(id: string, actor: Actor) {
  const f = await findLive(id);
  if (!canReadCategory(actor.role, f.category as FileCategory)) throw AppError.forbidden();
  await assertProjectAccess(actor, String(f.project));
  try {
    return { stream: await getStorageFor(f.storage).stream(f.key), name: f.originalName, mimeType: f.mimeType ?? 'application/octet-stream' };
  } catch {
    throw AppError.notFound('The stored file is missing');
  }
}

export async function removeFile(id: string, actor: Actor) {
  const f = await findLive(id);
  assertCanWrite(actor.role, f.category as FileCategory);
  if (CATEGORY_RULES[f.category as FileCategory].standalone) throw AppError.badRequest('This file belongs to a BD CRM record and is managed there');
  await assertProjectAccess(actor, String(f.project));
  const evidence = CATEGORY_RULES[f.category as FileCategory].evidence;
  if (evidence) {
    // Critical evidence: hide it but keep the record, because the stored object is kept.
    await Project.updateOne({ _id: f.project, 'files._id': f._id }, { $set: { 'files.$.deletedAt': new Date(), 'files.$.deletedBy': new Types.ObjectId(actor.id), 'files.$.objectRetained': true } });
  } else {
    await getStorageFor(f.storage).remove(f.key);
    await Project.updateOne({ _id: f.project }, { $pull: { files: { _id: f._id } } });
  }
  await recordAudit({ actor, action: 'DELETE', entity: 'FileAsset', entityId: f._id, project: f.project, reason: evidence ? 'Evidence retained in storage' : undefined });
  return { id, removed: evidence ? ('hidden' as const) : ('erased' as const) };
}

/**
 * Erases every file of a project that is being deleted, from storage (local folder or Spaces) and from the project record.
 * A file that cannot be erased is reported, not hidden.
 */
export async function removeProjectFiles(projectId: string) {
  // Every recorded file, including hidden evidence: the whole project is being destroyed, so nothing may be left in storage.
  const files = (((await Project.findById(projectId).select('files').lean())?.files ?? []) as unknown as FileEntry[]);
  const failed: string[] = [];
  const erased: Types.ObjectId[] = [];
  for (const f of files) {
    try {
      await getStorageFor(f.storage).remove(f.key);
      erased.push(f._id);
    } catch (e) {
      failed.push(f.originalName);
      console.error('could not erase file', f.key, e);
    }
  }
  if (erased.length) {
    await Project.updateOne({ _id: projectId }, { $pull: { files: { _id: { $in: erased } } } });
  }
  return { erased: erased.length, failed };
}

/** Returns the original file name for a key that still has a live record, or null (only recorded files are served). */
export async function liveFileName(key: string): Promise<string | null> {
  const p = await Project.findOne({ files: { $elemMatch: { key, deletedAt: null } } }).select('files').lean();
  const f = ((p?.files ?? []) as unknown as FileEntry[]).find((x) => x.key === key && isLive(x));
  return f ? f.originalName : null;
}

/**
 * Lets the browser ask "do you already have these files?" before uploading them, using a SHA-256 of the content.
 * Returns the stored name for every hash that is already in this project + category.
 */
export async function checkDuplicates(projectId: string, category: FileCategory, hashes: string[], actor: Actor) {
  assertCanWrite(actor.role, category);
  await assertProjectAccess(actor, projectId);
  const rows = (await projectFiles(projectId)).filter((f) => f.category === category && f.sha256 && hashes.includes(f.sha256));
  const byHash = new Map(rows.map((r) => [r.sha256 as string, r.originalName]));
  return hashes.map((sha256) => ({ sha256, duplicate: byHash.has(sha256), existingName: byHash.get(sha256) ?? null }));
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

/** Finds the stored-file entry with this key anywhere inside a record (comments, approvals, rate cards ...). */
function findStored(node: unknown, key: string): StoredFile | null {
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findStored(x, key);
      if (r) return r;
    }
  } else if (node && typeof node === 'object' && !(node instanceof Types.ObjectId) && !(node instanceof Date)) {
    const o = node as Record<string, unknown>;
    if (o.key === key && typeof o.name === 'string') return o as unknown as StoredFile;
    for (const v of Object.values(o)) {
      const r = findStored(v, key);
      if (r) return r;
    }
  }
  return null;
}

/** Original name of a BD CRM file (sales order or email template) that a live record still points at, or null. */
async function liveEmbeddedName(key: string): Promise<string | null> {
  const order = await SalesOrder.findOne({
    deletedAt: null,
    $or: ['salescommentsArray.attachments.key', 'approvalDocumentsArray.file.key', 'rateCardArray.pdf.key', 'salesprofile.attachments.key'].map((p) => ({ [p]: key })),
  }).lean();
  const inOrder = order && findStored(order, key);
  if (inOrder) return inOrder.name ?? 'file';
  const tpl = await EmailTemplate.findOne({ 'pdf.key': key }).lean();
  const inTpl = tpl && findStored(tpl, key);
  return inTpl ? (inTpl.name ?? 'file') : null;
}
