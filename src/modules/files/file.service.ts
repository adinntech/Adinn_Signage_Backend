import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { assertProjectAccess } from '../../common/project-access';
import { recordAudit } from '../audit/audit.service';
import { notifyProjectParty } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { permissionsFor, type Permission, type Role } from '../roles/roles';
import { CATEGORY_RULES, FILE_CATEGORIES, buildFileKey, kindOfFile, type FileCategory, type FileKind } from './file.categories';
import { FileAsset } from './file.model';
import { getStorage } from './storage';

const hasPerm = (role: string, p: Permission) => permissionsFor(role as Role).includes(p);
export const canReadCategory = (role: string, c: FileCategory) => CATEGORY_RULES[c].read.some((p) => hasPerm(role, p));
const readableCategories = (role: string) => FILE_CATEGORIES.filter((c) => canReadCategory(role, c));

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
  project: String(f.project),
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
  await assertProjectAccess(actor, String(f.project));
  const ttl = env.SIGNED_URL_TTL_SECONDS;
  const url = await getStorage().signedUrl(f.key, f.originalName, ttl);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), name: f.originalName, mimeType: f.mimeType };
}

export async function removeFile(id: string, actor: Actor) {
  const f = await findLive(id);
  assertCanWrite(actor.role, f.category as FileCategory);
  await assertProjectAccess(actor, String(f.project));
  const evidence = CATEGORY_RULES[f.category as FileCategory].evidence;
  if (!evidence) await getStorage().remove(f.key);
  f.deletedAt = new Date();
  f.deletedBy = actor.id as never;
  f.objectRetained = evidence;
  await f.save();
  await recordAudit({ actor, action: 'DELETE', entity: 'FileAsset', entityId: f._id, project: f.project, reason: evidence ? 'Evidence retained in storage' : undefined });
  return { id, removed: evidence ? ('hidden' as const) : ('erased' as const) };
}

/** Used by the signed local link: only serve keys that still have a live record. */
export async function liveKey(key: string) {
  return FileAsset.exists({ key, deletedAt: null });
}
