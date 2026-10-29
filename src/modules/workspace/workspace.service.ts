import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { CodeRequest } from '../codeRequests/codeRequest.model';
import { isManager } from '../connect/connect.service';
import { discardStoredFiles, removeStoredFiles, storedFileUrl, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { SalesOrder } from '../sales/sales.model';
import { User } from '../users/user.model';
import { NoteDraft, ProjectNote, ProjectVoiceNote } from './workspace.model';
import type { ActivityCategory, activityQuery, draftBody, noteEdit, notePayload, voicePayload } from './workspace.validators';

const MAX_FILES = 5;
const MAX_VOICE_NOTES = 200;

/* ---------------------------------- access ---------------------------------- */

/**
 * The people on a project (BD owner, Recce assignee, coordinator, Client Servicing of its order) and Admin / Management
 * may use its workspace. Anyone else is told the project does not exist.
 */
async function party(projectId: string, a: Actor) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('code name client owner assignedTo coordinator salesOrder').lean();
  if (!p) throw AppError.notFound('Project not found');
  const order = p.salesOrder ? await SalesOrder.findById(p.salesOrder).select('csAssignee').lean() : null;
  const ids = [...new Set([p.owner, p.assignedTo, p.coordinator, order?.csAssignee].filter(Boolean).map(String))];
  if (!isManager(a.role) && !ids.includes(a.id)) throw AppError.notFound('Project not found');
  return { p, partyIds: ids, order };
}
type Party = Awaited<ReturnType<typeof party>>;

const audit = (a: Actor, p: Party['p'], entityId: Types.ObjectId, action: string, reason: string) =>
  recordAudit({ actor: a, action, entity: 'Project', entityId, project: p._id, reason });

async function folderOf(p: Party['p']) {
  const c = await Client.findById(p.client).select('name').lean();
  return { clientName: c?.name ?? 'Project', folderKey: p.code };
}
const names = async (ids: unknown[]) => new Map((await User.find({ _id: { $in: [...new Set(ids.map(String))] } }).select('name role').lean()).map((u) => [String(u._id), { name: u.name, role: u.role }]));

/** The people notes can mention: those on the project. */
async function peopleOf(x: Party) {
  const users = await User.find({ _id: { $in: x.partyIds }, isActive: true, deletedAt: null }).select('name role').sort({ name: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, role: u.role }));
}

/** The project's header details, its people (for mentions) and what the workspace holds. */
export async function overview(projectId: string, a: Actor) {
  const x = await party(projectId, a);
  const [client, status, people, notes, voices] = await Promise.all([
    Client.findById(x.p.client).select('name clientNo').lean(),
    Project.findById(x.p._id).select('status').lean(),
    peopleOf(x),
    ProjectNote.countDocuments({ project: x.p._id, $or: [{ visibility: 'PROJECT' }, { author: new Types.ObjectId(a.id) }] }),
    ProjectVoiceNote.countDocuments({ project: x.p._id }),
  ]);
  return { project: { id: String(x.p._id), code: x.p.code, name: x.p.name, status: status?.status ?? '', client: { name: client?.name ?? '', clientNo: client?.clientNo ?? null } }, people, counts: { notes, voiceNotes: voices } };
}

/* --------------------------------- activity --------------------------------- */

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', ENQUIRY: 'Enquiry', NEW: 'Enquiry', RECCE_ASSIGNED: 'Recce Assigned', PLANNING: 'Planning', IN_PROGRESS: 'In Progress', CLIENT_APPROVAL: 'Client Approval', COMPLETED: 'Completed', ON_HOLD: 'On Hold', CANCELLED: 'Cancelled', LOSS: 'Loss' };
const label = (s: unknown) => STATUS_LABEL[String(s)] ?? String(s ?? '-');

type Log = { _id: unknown; action: string; entity: string; reason?: string | null; at: Date; changes?: { oldValue?: unknown; newValue?: unknown }[]; user?: unknown };

/** Turns a recorded action into a plain event: what happened, in which area. */
export function describe(l: Log): { category: ActivityCategory; title: string } {
  const why = l.reason ?? '';
  const c0 = l.changes?.[0];
  switch (l.action) {
    case 'CREATE':
      return l.entity === 'Project' ? { category: 'PROJECT', title: 'Project created' } : { category: 'PROJECT', title: `${l.entity} created` };
    case 'UPDATE':
      return { category: 'PROJECT', title: l.entity === 'Project' ? 'Project details updated' : `${l.entity} updated` };
    case 'STATUS_CHANGE':
    case 'STAGE_CHANGE':
      return { category: 'STAGE', title: why || `Stage changed: ${label(c0?.oldValue)} → ${label(c0?.newValue)}` };
    case 'ASSIGN':
      return { category: 'ASSIGNMENT', title: why || 'Assigned' };
    case 'UPLOAD':
      return { category: 'DOCUMENTS', title: why || 'Document uploaded' };
    case 'EMAIL_SENT':
    case 'CODE_REQUEST_SENT':
    case 'CODE_REQUEST_RETRY':
    case 'CODE_REQUEST_MARKED_SENT':
      return { category: 'MAIL', title: why || 'Email sent' };
    case 'CODE_CONFIRMED':
    case 'CODE_REJECTED':
      return { category: 'CODES', title: why || 'Code updated' };
    case 'APPROVAL':
    case 'APPROVAL_COMPLETE':
    case 'BOARD_DECISION':
    case 'CLIENT_COST_DECISION':
    case 'COST_APPROVAL':
      return { category: 'APPROVAL', title: why || 'Approval recorded' };
    case 'IMPORT_SITES':
    case 'IMPORT':
      return { category: 'SHOPS', title: why || 'Shops imported' };
    case 'NOTE_ADDED':
    case 'NOTE_EDITED':
    case 'NOTE_DELETED':
    case 'VOICE_NOTE_ADDED':
    case 'VOICE_NOTE_DELETED':
      return { category: 'NOTES', title: why };
    default:
      return { category: 'PROJECT', title: why || l.action.toLowerCase().replace(/_/g, ' ') };
  }
}

/**
 * The project's event history, newest first: its own audit entries plus those of its sales order and code requests.
 * It is read from the append-only audit log; nothing here can change or remove an entry.
 */
export async function activity(projectId: string, q: z.infer<typeof activityQuery>, a: Actor) {
  const { p, order } = await party(projectId, a);
  const requestIds = order ? await CodeRequest.find({ order: order._id }).distinct('_id') : [];
  const scope: Record<string, unknown>[] = [{ project: p._id }];
  if (order) scope.push({ entity: 'SalesOrder', entityId: order._id });
  if (requestIds.length) scope.push({ entity: 'CodeRequest', entityId: { $in: requestIds } });
  const wanted = q.category;
  // Fetch a little more than a page, then filter by category (a category is derived from the action, not stored).
  const out: ReturnType<typeof present>[] = [];
  let cursor = q.before ? new Types.ObjectId(q.before) : null;
  let more = false;
  for (let round = 0; round < 6 && out.length <= q.limit; round++) {
    const base = [{ $or: scope }, { $nor: [{ entity: 'Site', action: { $ne: 'APPROVAL' } }, { entity: 'ConnectChannel' }] }, ...(cursor ? [{ _id: { $lt: cursor } }] : [])];
    const rows = await AuditLog.find({ $and: base }).sort({ _id: -1 }).limit(100).populate('user', 'name role').lean();
    for (const l of rows) {
      const e = present(l as unknown as Log);
      if (!wanted || e.category === wanted) out.push(e);
    }
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1]!._id as Types.ObjectId;
    more = true;
  }
  const page = out.slice(0, q.limit);
  const hasMore = out.length > q.limit || (more && out.length > 0 && page.length === q.limit);
  return { events: page, hasMore, nextBefore: page.length ? page[page.length - 1]!.id : null };
}
function present(l: Log) {
  const d = describe(l);
  const u = l.user as { name?: string; role?: string } | null | undefined;
  return { id: String(l._id), at: l.at, category: d.category, title: d.title, by: u ? { name: u.name ?? 'Unknown', role: u.role ?? '' } : null };
}

/* ----------------------------------- notes ----------------------------------- */

type NoteRow = { _id: unknown; author: unknown; body?: string | null; visibility?: string | null; mentions?: unknown[]; attachments?: StoredFile[]; editedAt?: Date | null; createdAt?: Date };
function presentNote(n: NoteRow, who: Map<string, { name: string; role: string }>, a: Actor) {
  const mine = String(n.author) === a.id;
  const au = who.get(String(n.author));
  return {
    id: String(n._id),
    author: { id: String(n.author), name: au?.name ?? 'Former member', role: au?.role ?? '' },
    body: n.body ?? '',
    visibility: n.visibility ?? 'PROJECT',
    mentions: (n.mentions ?? []).map(String),
    attachments: (n.attachments ?? []).map((f) => ({ fileId: String(f.fileId), name: f.name ?? 'file', size: f.size ?? 0, mimeType: f.mimeType ?? '', kind: f.kind ?? 'document', voice: false, durationSec: null })),
    edited: !!n.editedAt,
    canEdit: mine,
    canDelete: mine || isManager(a.role),
    createdAt: n.createdAt,
  };
}

export async function listNotes(projectId: string, a: Actor) {
  const x = await party(projectId, a);
  const rows = await ProjectNote.find({ project: x.p._id, $or: [{ visibility: 'PROJECT' }, { author: new Types.ObjectId(a.id) }] }).sort({ createdAt: -1 }).limit(200).lean();
  const who = await names(rows.map((r) => r.author));
  return { notes: rows.map((r) => presentNote(r as NoteRow, who, a)), people: await peopleOf(x) };
}

export async function createNote(projectId: string, input: z.infer<typeof notePayload>, uploads: UploadedFile[], a: Actor) {
  const x = await party(projectId, a);
  if (!input.body && uploads.length === 0) throw new AppError(422, 'VALIDATION_ERROR', 'Write a note or attach a file', [{ path: 'body', message: 'Write a note or attach a file' }]);
  if (uploads.length > MAX_FILES) throw new AppError(422, 'VALIDATION_ERROR', `Up to ${MAX_FILES} files per note`, [{ path: 'files', message: `Up to ${MAX_FILES} files per note` }]);
  // Only people on the project can be mentioned, and a private note mentions nobody.
  const mentions = input.visibility === 'PRIVATE' ? [] : input.mentions.filter((m) => x.partyIds.includes(m) && m !== a.id);
  const where = await folderOf(x.p);
  const stored: StoredFile[] = [];
  try {
    for (const file of uploads) stored.push(await storeEmbeddedFile({ category: 'WORKSPACE_ATTACHMENT', ...where, file, actor: a, owner: { entity: 'Project', id: x.p._id } }));
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  const note = await ProjectNote.create({ project: x.p._id, author: a.id, body: input.body, visibility: input.visibility, mentions, attachments: stored as never });
  await NoteDraft.deleteOne({ project: x.p._id, author: a.id });
  if (input.visibility === 'PROJECT') await audit(a, x.p, note._id, 'NOTE_ADDED', `Note added${stored.length ? ` with ${stored.length} file${stored.length === 1 ? '' : 's'}` : ''}`);
  if (mentions.length) {
    const me = (await User.findById(a.id).select('name').lean())?.name ?? 'Someone';
    void notify({ recipients: mentions, kind: 'ACTIVITY', title: `${me} mentioned you in a note`, body: input.body.slice(0, 140), project: { _id: x.p._id, code: x.p.code }, actorId: a.id, dedupe: (r) => `note-mention:${note._id}:${r}` });
  }
  const who = await names([a.id]);
  return presentNote(note.toObject() as NoteRow, who, a);
}

async function loadNote(projectId: string, noteId: string, a: Actor) {
  const x = await party(projectId, a);
  const note = await ProjectNote.findOne({ _id: noteId, project: x.p._id });
  // Someone else's private note does not exist as far as this person is concerned.
  if (!note || (note.visibility === 'PRIVATE' && String(note.author) !== a.id)) throw AppError.notFound('Note not found');
  return { x, note };
}

export async function editNote(projectId: string, noteId: string, input: z.infer<typeof noteEdit>, a: Actor) {
  const { x, note } = await loadNote(projectId, noteId, a);
  if (String(note.author) !== a.id) throw AppError.forbidden();
  note.body = input.body;
  if (input.visibility) note.visibility = input.visibility;
  note.editedAt = new Date();
  await note.save();
  await audit(a, x.p, note._id, 'NOTE_EDITED', 'Note edited');
  return presentNote(note.toObject() as NoteRow, await names([note.author]), a);
}

export async function deleteNote(projectId: string, noteId: string, a: Actor) {
  const { x, note } = await loadNote(projectId, noteId, a);
  if (String(note.author) !== a.id && !isManager(a.role)) throw AppError.forbidden();
  const { failed } = await removeStoredFiles((note.attachments ?? []) as unknown as StoredFile[]);
  if (failed.length) throw AppError.conflict(`Could not remove these files from storage, so the note was not deleted: ${failed.join(', ')}. Try again.`);
  await note.deleteOne();
  await audit(a, x.p, note._id, 'NOTE_DELETED', String(note.author) === a.id ? 'Note deleted by its author' : 'Note deleted by a manager');
  return { id: noteId };
}

export async function noteFileUrl(projectId: string, noteId: string, fileId: string, a: Actor) {
  const { note } = await loadNote(projectId, noteId, a);
  const f = note.attachments.find((x) => String(x.fileId) === fileId);
  if (!f) throw AppError.notFound('File not found');
  return storedFileUrl(f as unknown as StoredFile);
}

export async function getDraft(projectId: string, a: Actor) {
  const x = await party(projectId, a);
  const d = await NoteDraft.findOne({ project: x.p._id, author: a.id }).lean();
  return d ? { body: d.body ?? '', visibility: d.visibility ?? 'PROJECT', savedAt: d.updatedAt } : null;
}
/** Saves what is being typed. An empty draft is removed. */
export async function saveDraft(projectId: string, input: z.infer<typeof draftBody>, a: Actor) {
  const x = await party(projectId, a);
  if (!input.body.trim()) {
    await NoteDraft.deleteOne({ project: x.p._id, author: a.id });
    return null;
  }
  const d = await NoteDraft.findOneAndUpdate({ project: x.p._id, author: a.id }, { $set: { body: input.body, visibility: input.visibility } }, { upsert: true, returnDocument: 'after' }).lean();
  return { body: d!.body ?? '', visibility: d!.visibility ?? 'PROJECT', savedAt: d!.updatedAt };
}

/* -------------------------------- voice notes -------------------------------- */

type VoiceRow = { _id: unknown; author: unknown; title?: string | null; file?: StoredFile | null; durationSec?: number | null; peaks?: number[]; createdAt?: Date };
const presentVoice = (v: VoiceRow, who: Map<string, { name: string; role: string }>, a: Actor) => ({
  id: String(v._id),
  title: v.title ?? '',
  author: { id: String(v.author), name: who.get(String(v.author))?.name ?? 'Former member', role: who.get(String(v.author))?.role ?? '' },
  durationSec: v.durationSec ?? 0,
  peaks: v.peaks ?? [],
  fileName: v.file?.name ?? 'voice-note',
  size: v.file?.size ?? 0,
  canDelete: String(v.author) === a.id || isManager(a.role),
  createdAt: v.createdAt,
});

export async function listVoiceNotes(projectId: string, a: Actor) {
  const x = await party(projectId, a);
  const rows = await ProjectVoiceNote.find({ project: x.p._id }).sort({ createdAt: -1 }).limit(MAX_VOICE_NOTES).lean();
  const who = await names(rows.map((r) => r.author));
  return rows.map((r) => presentVoice(r as VoiceRow, who, a));
}

export async function createVoiceNote(projectId: string, input: z.infer<typeof voicePayload>, file: UploadedFile | undefined, a: Actor) {
  const x = await party(projectId, a);
  if (!file) throw new AppError(422, 'VALIDATION_ERROR', 'Record or choose a voice note', [{ path: 'file', message: 'Record or choose a voice note' }]);
  if ((await ProjectVoiceNote.countDocuments({ project: x.p._id })) >= MAX_VOICE_NOTES) throw AppError.conflict(`Up to ${MAX_VOICE_NOTES} voice notes per project`);
  const stored = await storeEmbeddedFile({ category: 'WORKSPACE_ATTACHMENT', ...(await folderOf(x.p)), file, actor: a, owner: { entity: 'Project', id: x.p._id } });
  if (stored.kind !== 'audio') {
    await discardStoredFiles([stored]);
    throw new AppError(422, 'VALIDATION_ERROR', 'Choose an audio file', [{ path: 'file', message: 'Choose an audio file' }]);
  }
  const v = await ProjectVoiceNote.create({ project: x.p._id, author: a.id, title: input.title, file: stored as never, durationSec: Math.round(input.durationSec), peaks: input.peaks.map((n) => Math.round(n)) });
  await audit(a, x.p, v._id, 'VOICE_NOTE_ADDED', `Voice note added${input.title ? `: ${input.title}` : ''}`);
  return presentVoice(v.toObject() as VoiceRow, await names([a.id]), a);
}

async function loadVoice(projectId: string, id: string, a: Actor) {
  const x = await party(projectId, a);
  const v = await ProjectVoiceNote.findOne({ _id: id, project: x.p._id });
  if (!v) throw AppError.notFound('Voice note not found');
  return { x, v };
}
export async function deleteVoiceNote(projectId: string, id: string, a: Actor) {
  const { x, v } = await loadVoice(projectId, id, a);
  if (String(v.author) !== a.id && !isManager(a.role)) throw AppError.forbidden();
  const { failed } = await removeStoredFiles([v.file as unknown as StoredFile]);
  if (failed.length) throw AppError.conflict('Could not remove the recording from storage, so it was not deleted. Try again.');
  await v.deleteOne();
  await audit(a, x.p, v._id, 'VOICE_NOTE_DELETED', 'Voice note deleted');
  return { id };
}
export async function voiceNoteUrl(projectId: string, id: string, a: Actor) {
  const { v } = await loadVoice(projectId, id, a);
  return storedFileUrl(v.file as unknown as StoredFile);
}

/** Notes, drafts, voice notes and their stored files for one project. Run before the project is purged. */
export async function removeProjectWorkspaceData(projectId: string): Promise<{ failed: string[] }> {
  const [notes, voices] = await Promise.all([ProjectNote.find({ project: projectId, 'attachments.0': { $exists: true } }).select('attachments').lean(), ProjectVoiceNote.find({ project: projectId }).select('file').lean()]);
  const files = [...notes.flatMap((n) => (n.attachments ?? []) as unknown as StoredFile[]), ...voices.map((v) => v.file as unknown as StoredFile)];
  return removeStoredFiles(files);
}
