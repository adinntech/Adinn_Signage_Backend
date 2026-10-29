import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, type Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { discardStoredFiles, removeStoredFiles, storedFileUrl, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { Project } from '../projects/project.model';
import { SalesOrder } from '../sales/sales.model';
import { User } from '../users/user.model';
import { ConnectChannel, ConnectMessage, type ChannelDoc } from './connect.model';
import { emitChannel, emitUser, removeFromRoom, setChannelGuard } from './connect.hub';
import type { createChannelBody, editBody, membersBody, messagePayload, messagesQuery, pinBody, reactBody, updateChannelBody } from './connect.validators';

const MANAGERS = ['SUPER_ADMIN', 'MANAGEMENT'];
export const isManager = (role: string) => MANAGERS.includes(role);
const MAX_FILES = 5;

type Chan = ChannelDoc;
const memberOf = (ch: Chan, userId: string) => ch.members.find((m) => String(m.user) === userId);
const isOwner = (ch: Chan, a: Actor) => memberOf(ch, a.id)?.role === 'OWNER';
const roleAllowed = (ch: { allowedRoles: string[] }, role: string) => ch.allowedRoles.length === 0 || ch.allowedRoles.includes(role);

/** Who may read a channel. DMs and private channels are members only: not even Admin reads them. */
export function canRead(a: Actor, ch: Chan): boolean {
  if (memberOf(ch, a.id)) return true;
  if (ch.kind === 'TEAM') return roleAllowed(ch, a.role) || a.role === 'SUPER_ADMIN';
  if (ch.kind === 'PROJECT') return isManager(a.role);
  return false;
}
/** Owner of the channel, or Super Admin, may change it and its members. A DM never changes. */
export const canManage = (a: Actor, ch: Chan) => ch.kind !== 'DM' && (a.role === 'SUPER_ADMIN' || isOwner(ch, a) || (ch.kind === 'TEAM' && a.role === 'MANAGEMENT'));

const notFound = () => AppError.notFound('Channel not found');
async function load(id: string, a: Actor): Promise<Chan> {
  const ch = await ConnectChannel.findById(id);
  if (!ch || !canRead(a, ch)) throw notFound();
  return ch;
}
const audit = (a: Actor, ch: Chan, action: string, reason: string) =>
  recordAudit({ actor: a, action, entity: 'ConnectChannel', entityId: ch._id, project: ch.project ?? undefined, reason: `${ch.name}: ${reason}` });

setChannelGuard(async (userId, role, channelId) => {
  const ch = await ConnectChannel.findById(channelId);
  return !!ch && canRead({ id: userId, role }, ch);
});

/* ------------------------------------ people ------------------------------------ */

const userCard = (u: { _id: unknown; name?: string; role?: string }) => ({ id: String(u._id), name: u.name ?? 'Unknown', role: u.role ?? '' });

export async function people(q: string | undefined, a: Actor) {
  const filter: Record<string, unknown> = { isActive: true, deletedAt: null, _id: { $ne: new Types.ObjectId(a.id) } };
  if (q) filter.name = new RegExp(escapeRegex(q), 'i');
  return (await User.find(filter).select('name role').sort({ name: 1 }).limit(25).lean()).map(userCard);
}

/* ----------------------------------- channels ----------------------------------- */

/** One project channel per project. Members come from the project; people added by hand are kept. */
export async function ensureProjectChannel(projectId: string | Types.ObjectId) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).populate('client', 'name').lean();
  if (!p) throw AppError.notFound('Project not found');
  const order = p.salesOrder ? await SalesOrder.findById(p.salesOrder).select('csAssignee').lean() : null;
  const want = [...new Set([p.owner, p.assignedTo, p.coordinator, order?.csAssignee, p.createdBy].filter(Boolean).map(String))];
  const active = new Set((await User.find({ _id: { $in: want }, isActive: true, deletedAt: null }).select('_id').lean()).map((u) => String(u._id)));
  const topic = `${(p.client as unknown as { name?: string } | null)?.name ?? ''} · ${p.name}`;
  let ch = await ConnectChannel.findOne({ project: p._id, kind: 'PROJECT' });
  if (!ch) {
    try {
      ch = await ConnectChannel.create({ name: p.code, kind: 'PROJECT', topic, project: p._id, members: [...active].map((u) => ({ user: u, role: u === String(p.createdBy) ? 'OWNER' : 'MEMBER' })), createdBy: p.createdBy });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      ch = await ConnectChannel.findOne({ project: p._id, kind: 'PROJECT' });
    }
  }
  if (!ch) throw AppError.notFound('Channel not found');
  const have = new Set(ch.members.map((m) => String(m.user)));
  const missing = [...active].filter((u) => !have.has(u));
  if (missing.length) await ConnectChannel.updateOne({ _id: ch._id }, { $push: { members: { $each: missing.map((u) => ({ user: u, role: 'MEMBER', joinedAt: new Date(), lastReadAt: new Date() })) } } });
  return ConnectChannel.findById(ch._id) as Promise<Chan>;
}

/** Brings the person's channels up to date: team channels their role may see, and the channel of every project they work on. */
async function syncImplicit(a: Actor) {
  const me = new Types.ObjectId(a.id);
  const now = new Date();
  const teams = await ConnectChannel.find({ kind: 'TEAM', archived: false, 'members.user': { $ne: me } }).select('allowedRoles').lean();
  const join = teams.filter((t) => roleAllowed(t as { allowedRoles: string[] }, a.role)).map((t) => t._id);
  if (join.length) await ConnectChannel.updateMany({ _id: { $in: join } }, { $push: { members: { user: me, role: 'MEMBER', joinedAt: now, lastReadAt: now } } });
  if (isManager(a.role)) return; // Admin and Management browse project channels instead
  const orders = await SalesOrder.find({ csAssignee: me, deletedAt: null }).select('_id').lean();
  const projects = await Project.find({ deletedAt: null, $or: [{ owner: me }, { assignedTo: me }, { coordinator: me }, { salesOrder: { $in: orders.map((o) => o._id) } }] })
    .select('_id')
    .sort({ createdAt: -1 })
    .limit(150)
    .lean();
  if (!projects.length) return;
  const have = await ConnectChannel.find({ kind: 'PROJECT', project: { $in: projects.map((p) => p._id) } }).select('project members.user').lean();
  const known = new Map(have.map((c) => [String(c.project), c.members.some((m) => String(m.user) === a.id)]));
  for (const p of projects) if (known.get(String(p._id)) !== true) await ensureProjectChannel(p._id).catch(() => undefined);
}

export async function listChannels(a: Actor) {
  await syncImplicit(a);
  const me = new Types.ObjectId(a.id);
  const channels = await ConnectChannel.find({ 'members.user': me, archived: false }).sort({ lastMessageAt: -1, createdAt: -1 }).limit(200).lean();
  const otherIds = channels.filter((c) => c.kind === 'DM').flatMap((c) => c.members.map((m) => String(m.user))).filter((u) => u !== a.id);
  const projectIds = channels.map((c) => c.project).filter(Boolean);
  const [users, projects] = await Promise.all([
    User.find({ _id: { $in: otherIds } }).select('name role').lean(),
    Project.find({ _id: { $in: projectIds } }).select('code name status').lean(),
  ]);
  const counts = await Promise.all(
    channels.map(async (c) => {
      const since = c.members.find((m) => String(m.user) === a.id)?.lastReadAt ?? new Date(0);
      const base = { channel: c._id, author: { $ne: me }, deletedAt: null, createdAt: { $gt: since } };
      const [unread, mentions] = await Promise.all([ConnectMessage.countDocuments(base), ConnectMessage.countDocuments({ ...base, mentions: me })]);
      return { unread, mentions };
    }),
  );
  return channels.map((c, i) => {
    const other = c.kind === 'DM' ? users.find((u) => c.members.some((m) => String(m.user) === String(u._id) && String(u._id) !== a.id)) : undefined;
    const proj = projects.find((p) => String(p._id) === String(c.project));
    return {
      id: String(c._id),
      kind: c.kind,
      name: c.kind === 'DM' ? (other?.name ?? 'Direct message') : c.name,
      topic: c.topic ?? '',
      dmUser: other ? userCard(other) : null,
      project: proj ? { id: String(proj._id), code: proj.code, name: proj.name, status: proj.status } : null,
      memberCount: c.members.length,
      unread: counts[i]!.unread,
      mentionUnread: counts[i]!.mentions,
      lastMessageAt: c.lastMessageAt ?? null,
      lastMessagePreview: c.lastMessagePreview ?? '',
    };
  });
}

/** Admin / Management: project and team channels they are not in yet. */
export async function browseChannels(q: string | undefined, a: Actor) {
  if (!isManager(a.role)) throw AppError.forbidden();
  const filter: Record<string, unknown> = { kind: { $in: ['PROJECT', 'TEAM'] }, archived: false, 'members.user': { $ne: new Types.ObjectId(a.id) } };
  if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), 'i') }, { topic: new RegExp(escapeRegex(q), 'i') }];
  const rows = await ConnectChannel.find(filter).select('name kind topic members').sort({ lastMessageAt: -1, createdAt: -1 }).limit(30).lean();
  return rows.map((c) => ({ id: String(c._id), name: c.name, kind: c.kind, topic: c.topic ?? '', memberCount: c.members.length }));
}

export async function openProjectChannel(projectId: string, a: Actor) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('owner assignedTo coordinator salesOrder').lean();
  if (!p) throw AppError.notFound('Project not found');
  const order = p.salesOrder ? await SalesOrder.findById(p.salesOrder).select('csAssignee').lean() : null;
  const related = [p.owner, p.assignedTo, p.coordinator, order?.csAssignee].filter(Boolean).map(String).includes(a.id);
  if (!related && !isManager(a.role)) throw AppError.notFound('Project not found');
  const ch = await ensureProjectChannel(projectId);
  return channelDetail(String(ch._id), a);
}

export async function createChannel(input: z.infer<typeof createChannelBody>, a: Actor) {
  const me = new Types.ObjectId(a.id);
  if (input.kind === 'TEAM' && !isManager(a.role)) throw AppError.forbidden();
  const others = await User.find({ _id: { $in: input.memberIds }, isActive: true, deletedAt: null }).select('_id').lean();
  if (others.length !== input.memberIds.length) throw new AppError(422, 'VALIDATION_ERROR', 'Some people could not be found', [{ path: 'memberIds', message: 'Some people could not be found' }]);
  if (input.kind === 'DM') {
    const other = String(others[0]!._id);
    if (other === a.id) throw new AppError(422, 'VALIDATION_ERROR', 'Choose someone else', [{ path: 'memberIds', message: 'Choose someone else' }]);
    const dmKey = [a.id, other].sort().join(':');
    const have = await ConnectChannel.findOne({ dmKey });
    if (have) return channelDetail(String(have._id), a);
    try {
      const ch = await ConnectChannel.create({ name: 'DM', kind: 'DM', dmKey, members: [{ user: me, role: 'MEMBER' }, { user: other, role: 'MEMBER' }], createdBy: me });
      return channelDetail(String(ch._id), a);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return channelDetail(String((await ConnectChannel.findOne({ dmKey }))!._id), a);
    }
  }
  const ch = await ConnectChannel.create({
    name: input.name!,
    kind: input.kind,
    topic: input.topic ?? '',
    allowedRoles: input.kind === 'TEAM' ? input.allowedRoles : [],
    members: [{ user: me, role: 'OWNER' }, ...others.filter((o) => String(o._id) !== a.id).map((o) => ({ user: o._id, role: 'MEMBER' as const }))],
    createdBy: me,
  });
  await audit(a, ch, 'CHANNEL_CREATED', `${input.kind.toLowerCase()} channel created`);
  for (const m of ch.members) if (String(m.user) !== a.id) emitUser(String(m.user), 'channel:added', { channelId: String(ch._id) });
  return channelDetail(String(ch._id), a);
}

export async function channelDetail(id: string, a: Actor) {
  const ch = await load(id, a);
  const users = await User.find({ _id: { $in: ch.members.map((m) => m.user) } }).select('name role isActive').lean();
  const joined = !!memberOf(ch, a.id);
  const other = ch.kind === 'DM' ? users.find((u) => String(u._id) !== a.id) : undefined;
  const proj = ch.project ? await Project.findById(ch.project).select('code name status').lean() : null;
  return {
    id: String(ch._id),
    kind: ch.kind,
    name: ch.kind === 'DM' ? (other?.name ?? 'Direct message') : ch.name,
    topic: ch.topic ?? '',
    archived: ch.archived,
    allowedRoles: ch.allowedRoles,
    project: proj ? { id: String(proj._id), code: proj.code, name: proj.name, status: proj.status } : null,
    joined,
    canManage: canManage(a, ch),
    canPost: joined && !ch.archived,
    pinned: ch.pinned.map(String),
    members: ch.members
      .map((m) => {
        const u = users.find((x) => String(x._id) === String(m.user));
        return { id: String(m.user), name: u?.name ?? 'Former member', role: u?.role ?? '', channelRole: m.role, active: u?.isActive !== false };
      })
      .sort((x, y) => (x.channelRole === 'OWNER' ? -1 : 0) - (y.channelRole === 'OWNER' ? -1 : 0) || x.name.localeCompare(y.name)),
  };
}

export async function updateChannel(id: string, input: z.infer<typeof updateChannelBody>, a: Actor) {
  const ch = await load(id, a);
  if (!canManage(a, ch)) throw AppError.forbidden();
  if (ch.kind === 'PROJECT' && input.name) throw AppError.conflict('A project channel is named after its project code.');
  if (input.name) ch.name = input.name;
  if (input.topic !== undefined) ch.topic = input.topic;
  if (input.archived !== undefined) ch.archived = input.archived;
  await ch.save();
  await audit(a, ch, 'CHANNEL_UPDATED', input.archived ? 'archived' : input.archived === false ? 'restored' : 'details changed');
  emitChannel(id, 'channel:update', { channelId: id });
  return channelDetail(id, a);
}

/** Admin / Management joins a project or team channel they were only allowed to look at. */
export async function joinChannel(id: string, a: Actor) {
  const ch = await load(id, a);
  if (!memberOf(ch, a.id)) {
    await ConnectChannel.updateOne({ _id: ch._id, 'members.user': { $ne: new Types.ObjectId(a.id) } }, { $push: { members: { user: a.id, role: 'MEMBER', joinedAt: new Date(), lastReadAt: new Date() } } });
    await audit(a, ch, 'MEMBER_ADDED', 'joined the channel');
    emitChannel(id, 'channel:update', { channelId: id });
  }
  return channelDetail(id, a);
}

export async function addMembers(id: string, input: z.infer<typeof membersBody>, a: Actor) {
  const ch = await load(id, a);
  if (!canManage(a, ch)) throw AppError.forbidden();
  const users = await User.find({ _id: { $in: input.userIds }, isActive: true, deletedAt: null }).select('_id').lean();
  if (users.length !== input.userIds.length) throw new AppError(422, 'VALIDATION_ERROR', 'Some people could not be found', [{ path: 'userIds', message: 'Some people could not be found' }]);
  const fresh = users.map((u) => String(u._id)).filter((u) => !memberOf(ch, u));
  if (fresh.length) {
    await ConnectChannel.updateOne({ _id: ch._id }, { $push: { members: { $each: fresh.map((u) => ({ user: u, role: 'MEMBER', joinedAt: new Date(), lastReadAt: new Date() })) } } });
    await audit(a, ch, 'MEMBER_ADDED', `${fresh.length} member${fresh.length === 1 ? '' : 's'} added`);
    for (const u of fresh) emitUser(u, 'channel:added', { channelId: id });
    emitChannel(id, 'channel:update', { channelId: id });
  }
  return channelDetail(id, a);
}

/** Remove a person (owner / Super Admin) or leave (yourself). The last owner cannot leave a channel that still has other members. */
export async function removeMember(id: string, userId: string, a: Actor) {
  const ch = await load(id, a);
  if (ch.kind === 'DM') throw AppError.conflict('A direct message cannot be changed.');
  const target = memberOf(ch, userId);
  if (!target) throw AppError.notFound('That person is not in this channel');
  if (userId !== a.id && !canManage(a, ch)) throw AppError.forbidden();
  const owners = ch.members.filter((m) => m.role === 'OWNER');
  if (target.role === 'OWNER' && owners.length === 1 && ch.members.length > 1 && ch.kind !== 'PROJECT') throw AppError.conflict('Make someone else an owner first: the channel needs one.');
  await ConnectChannel.updateOne({ _id: ch._id }, { $pull: { members: { user: new Types.ObjectId(userId) } } });
  removeFromRoom(userId, id);
  await audit(a, ch, 'MEMBER_REMOVED', userId === a.id ? 'left the channel' : 'a member was removed');
  emitUser(userId, 'channel:removed', { channelId: id });
  emitChannel(id, 'channel:update', { channelId: id });
  return userId === a.id ? { left: true } : channelDetail(id, a);
}

/* ----------------------------------- messages ----------------------------------- */

type MsgDoc = {
  _id: unknown;
  channel: unknown;
  author: unknown;
  body?: string | null;
  parent?: unknown;
  mentions?: unknown[];
  attachments?: (StoredFile & { voice?: boolean | null; durationSec?: number | null })[];
  reactions?: { emoji?: string | null; users?: unknown[] }[];
  replyCount?: number | null;
  lastReplyAt?: Date | null;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  createdAt?: Date;
};

function present(m: MsgDoc, authors: Map<string, { name?: string; role?: string }>, me: string, pinned: Set<string>) {
  const gone = !!m.deletedAt;
  const au = authors.get(String(m.author));
  return {
    id: String(m._id),
    channel: String(m.channel),
    author: { id: String(m.author), name: au?.name ?? 'Former member', role: au?.role ?? '' },
    body: gone ? '' : (m.body ?? ''),
    parent: m.parent ? String(m.parent) : null,
    mentions: gone ? [] : (m.mentions ?? []).map(String),
    attachments: gone ? [] : (m.attachments ?? []).map((f) => ({ fileId: String(f.fileId), name: f.name ?? 'file', size: f.size ?? 0, mimeType: f.mimeType ?? '', kind: f.kind ?? 'document', voice: !!f.voice, durationSec: f.durationSec ?? null })),
    reactions: gone ? [] : (m.reactions ?? []).filter((r) => (r.users?.length ?? 0) > 0).map((r) => ({ emoji: r.emoji ?? '', count: r.users!.length, mine: r.users!.some((u) => String(u) === me) })),
    replyCount: m.replyCount ?? 0,
    lastReplyAt: m.lastReplyAt ?? null,
    edited: !!m.editedAt,
    deleted: gone,
    pinned: pinned.has(String(m._id)),
    createdAt: m.createdAt,
  };
}
async function presentMany(rows: MsgDoc[], ch: Pick<Chan, 'pinned'>, me: string) {
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.author)))] } }).select('name role').lean();
  const authors = new Map(users.map((u) => [String(u._id), { name: u.name, role: u.role }]));
  const pinned = new Set(ch.pinned.map(String));
  return rows.map((r) => present(r, authors, me, pinned));
}

export async function listMessages(id: string, q: z.infer<typeof messagesQuery>, a: Actor) {
  const ch = await load(id, a);
  const filter: Record<string, unknown> = { channel: ch._id, parent: q.thread ? new Types.ObjectId(q.thread) : null };
  if (q.before) filter._id = { $lt: new Types.ObjectId(q.before) };
  const rows = await ConnectMessage.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit).reverse();
  let root: unknown = null;
  if (q.thread) {
    const r = await ConnectMessage.findOne({ _id: q.thread, channel: ch._id }).lean();
    if (!r) throw AppError.notFound('Message not found');
    root = (await presentMany([r], ch, a.id))[0];
  }
  return { messages: await presentMany(page as MsgDoc[], ch, a.id), hasMore: more, root };
}

const previewOf = (body: string, files: { voice?: boolean }[]) => (body.trim() ? body.trim().slice(0, 90) : files.some((f) => f.voice) ? 'Voice note' : files.length ? `${files.length} attachment${files.length === 1 ? '' : 's'}` : '');

/** The names a stored file is filed under: the project's client and code, or "Team" and the channel id. */
async function folderOf(ch: Chan) {
  if (ch.project) {
    const p = await Project.findById(ch.project).select('code client').lean();
    const c = p ? await Client.findById(p.client).select('name').lean() : null;
    if (p) return { clientName: c?.name ?? 'Project', folderKey: p.code };
  }
  return { clientName: 'Team', folderKey: String(ch._id) };
}

export async function postMessage(id: string, input: z.infer<typeof messagePayload>, uploads: UploadedFile[], a: Actor) {
  const ch = await load(id, a);
  if (ch.archived) throw AppError.conflict('This channel is archived.');
  if (!memberOf(ch, a.id)) {
    if (ch.kind !== 'TEAM') throw AppError.forbidden();
    await joinChannel(id, a);
  }
  const body = input.body.trim();
  if (!body && uploads.length === 0) throw new AppError(422, 'VALIDATION_ERROR', 'Write a message or attach a file', [{ path: 'body', message: 'Write a message or attach a file' }]);
  if (uploads.length > MAX_FILES) throw new AppError(422, 'VALIDATION_ERROR', `Up to ${MAX_FILES} files per message`, [{ path: 'files', message: `Up to ${MAX_FILES} files per message` }]);

  let parent: Types.ObjectId | null = null;
  if (input.parent) {
    const root = await ConnectMessage.findOne({ _id: input.parent, channel: ch._id, deletedAt: null }).select('parent').lean();
    if (!root) throw AppError.notFound('The message you are replying to was not found');
    if (root.parent) throw AppError.conflict('Reply to the first message of the thread.');
    parent = root._id;
  }

  // Only people who can read this channel can be mentioned.
  const readers = await User.find({ _id: { $in: input.mentions }, isActive: true, deletedAt: null }).select('role').lean();
  const mentions = readers.filter((u) => ch.members.some((m) => String(m.user) === String(u._id)) || (ch.kind === 'TEAM' && roleAllowed(ch, u.role))).map((u) => u._id);

  const where = await folderOf(ch);
  const stored: (StoredFile & { voice?: boolean; durationSec?: number })[] = [];
  try {
    for (const file of uploads) {
      const s = await storeEmbeddedFile({ category: 'CONNECT_ATTACHMENT', ...where, file, actor: a, owner: { entity: 'ConnectChannel', id: ch._id } });
      const voice = !!input.voice && s.kind === 'audio';
      stored.push({ ...s, ...(voice ? { voice: true, durationSec: Math.round(input.voice!.durationSec) } : {}) });
    }
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }

  const now = new Date();
  const msg = await ConnectMessage.create({ channel: ch._id, author: a.id, body, parent, mentions, attachments: stored });
  if (parent) await ConnectMessage.updateOne({ _id: parent }, { $inc: { replyCount: 1 }, $set: { lastReplyAt: now } });
  await ConnectChannel.updateOne({ _id: ch._id, 'members.user': new Types.ObjectId(a.id) }, { $set: { lastMessageAt: now, lastMessagePreview: previewOf(body, stored), 'members.$.lastReadAt': now } });

  const out = (await presentMany([msg.toObject() as MsgDoc], ch, a.id))[0]!;
  emitChannel(id, 'message:new', out);
  if (parent) emitChannel(id, 'thread:update', { channelId: id, parent: String(parent), replyCount: (await ConnectMessage.findById(parent).select('replyCount').lean())?.replyCount ?? 0 });
  const tagged = new Set(mentions.map(String));
  // A voice note carries what the other person's screen needs to play it as soon as it arrives.
  const voice = out.attachments.find((f) => f.voice);
  for (const m of ch.members)
    if (String(m.user) !== a.id)
      emitUser(String(m.user), 'connect:activity', {
        channelId: id,
        messageId: out.id,
        mention: tagged.has(String(m.user)),
        dm: ch.kind === 'DM',
        preview: previewOf(body, stored),
        from: out.author.name,
        channelName: ch.kind === 'DM' ? out.author.name : ch.name,
        voice: voice ? { fileId: voice.fileId, durationSec: voice.durationSec } : null,
      });
  return out;
}

async function loadMessage(channelId: string, messageId: string, a: Actor) {
  const ch = await load(channelId, a);
  const m = await ConnectMessage.findOne({ _id: messageId, channel: ch._id });
  if (!m) throw AppError.notFound('Message not found');
  return { ch, m };
}
const emitUpdate = async (ch: Chan, m: { toObject: () => unknown }, a: Actor) => {
  const out = (await presentMany([m.toObject() as MsgDoc], ch, a.id))[0]!;
  emitChannel(String(ch._id), 'message:update', out);
  return out;
};

export async function editMessage(channelId: string, messageId: string, input: z.infer<typeof editBody>, a: Actor) {
  const { ch, m } = await loadMessage(channelId, messageId, a);
  if (m.deletedAt) throw AppError.conflict('This message was deleted.');
  if (String(m.author) !== a.id) throw AppError.forbidden();
  m.body = input.body;
  m.editedAt = new Date();
  await m.save();
  return emitUpdate(ch, m, a);
}

/** The author, the channel owner and Super Admin may delete. The message is hidden for good and its files are erased from storage. */
export async function deleteMessage(channelId: string, messageId: string, a: Actor) {
  const { ch, m } = await loadMessage(channelId, messageId, a);
  if (m.deletedAt) return emitUpdate(ch, m, a);
  if (String(m.author) !== a.id && !canManage(a, ch)) throw AppError.forbidden();
  const files = (m.attachments ?? []) as unknown as StoredFile[];
  const { failed } = await removeStoredFiles(files);
  if (failed.length) throw AppError.conflict(`Could not remove these files from storage, so the message was not deleted: ${failed.join(', ')}. Try again.`);
  m.deletedAt = new Date();
  m.deletedBy = new Types.ObjectId(a.id);
  m.body = '';
  m.set('attachments', []);
  await m.save();
  await ConnectChannel.updateOne({ _id: ch._id }, { $pull: { pinned: m._id } });
  await audit(a, ch, 'MESSAGE_DELETED', String(m.author) === a.id ? 'a message was deleted by its author' : 'a message was deleted by a channel manager');
  return emitUpdate(ch, m, a);
}

/** Super Admin only: removes the chosen messages (and any replies they own are left as they are). Files are erased from storage first. */
export async function deleteMessages(channelId: string, ids: string[], a: Actor) {
  if (a.role !== 'SUPER_ADMIN') throw AppError.forbidden();
  const ch = await load(channelId, a);
  const rows = await ConnectMessage.find({ _id: { $in: ids }, channel: ch._id, deletedAt: null });
  if (!rows.length) return { deleted: 0 };
  const files = rows.flatMap((m) => (m.attachments ?? []) as unknown as StoredFile[]);
  const { failed } = await removeStoredFiles(files);
  if (failed.length) throw AppError.conflict(`Could not remove these files from storage, so nothing was deleted: ${failed.join(', ')}. Try again.`);
  const now = new Date();
  await ConnectMessage.updateMany({ _id: { $in: rows.map((m) => m._id) } }, { $set: { deletedAt: now, deletedBy: new Types.ObjectId(a.id), body: '', attachments: [] } });
  await ConnectChannel.updateOne({ _id: ch._id }, { $pull: { pinned: { $in: rows.map((m) => m._id) } } });
  await audit(a, ch, 'MESSAGES_DELETED', `${rows.length} message${rows.length === 1 ? '' : 's'} deleted by Super Admin`);
  const fresh = await ConnectMessage.find({ _id: { $in: rows.map((m) => m._id) } }).lean();
  for (const m of await presentMany(fresh as MsgDoc[], ch, a.id)) emitChannel(String(ch._id), 'message:update', m);
  return { deleted: rows.length };
}

/** Super Admin only: clears the whole conversation (every message and reply). */
export async function clearChannel(channelId: string, a: Actor) {
  if (a.role !== 'SUPER_ADMIN') throw AppError.forbidden();
  const ch = await load(channelId, a);
  const ids = (await ConnectMessage.find({ channel: ch._id, deletedAt: null }).select('_id').limit(5000).lean()).map((m) => String(m._id));
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) deleted += (await deleteMessages(channelId, ids.slice(i, i + 200), a)).deleted;
  return { deleted };
}

export async function reactToMessage(channelId: string, messageId: string, input: z.infer<typeof reactBody>, a: Actor) {
  const { ch, m } = await loadMessage(channelId, messageId, a);
  if (m.deletedAt) throw AppError.conflict('This message was deleted.');
  if (!memberOf(ch, a.id)) throw AppError.forbidden();
  const me = new Types.ObjectId(a.id);
  const existing = m.reactions.find((r) => r.emoji === input.emoji);
  if (!existing) {
    if (m.reactions.length >= 20) throw AppError.conflict('Too many different reactions on one message.');
    m.reactions.push({ emoji: input.emoji, users: [me] });
  } else if (existing.users.some((u) => String(u) === a.id)) existing.set('users', existing.users.filter((u) => String(u) !== a.id));
  else existing.users.push(me);
  m.set('reactions', m.reactions.filter((r) => r.users.length > 0));
  await m.save();
  return emitUpdate(ch, m, a);
}

export async function pinMessage(channelId: string, input: z.infer<typeof pinBody>, pin: boolean, a: Actor) {
  const ch = await load(channelId, a);
  if (!memberOf(ch, a.id)) throw AppError.forbidden();
  const m = await ConnectMessage.findOne({ _id: input.messageId, channel: ch._id, deletedAt: null }).select('_id').lean();
  if (!m) throw AppError.notFound('Message not found');
  await ConnectChannel.updateOne({ _id: ch._id }, pin ? { $addToSet: { pinned: m._id } } : { $pull: { pinned: m._id } });
  await audit(a, ch, pin ? 'MESSAGE_PINNED' : 'MESSAGE_UNPINNED', pin ? 'a message was pinned' : 'a message was unpinned');
  emitChannel(channelId, 'channel:update', { channelId });
  return channelDetail(channelId, a);
}

export async function pinnedMessages(channelId: string, a: Actor) {
  const ch = await load(channelId, a);
  const rows = await ConnectMessage.find({ _id: { $in: ch.pinned }, deletedAt: null }).sort({ createdAt: -1 }).lean();
  return presentMany(rows as MsgDoc[], ch, a.id);
}

export async function markRead(channelId: string, a: Actor) {
  const ch = await load(channelId, a);
  if (memberOf(ch, a.id)) {
    await ConnectChannel.updateOne({ _id: ch._id, 'members.user': new Types.ObjectId(a.id) }, { $set: { 'members.$.lastReadAt': new Date() } });
    emitUser(a.id, 'channel:read', { channelId });
  }
  return { ok: true };
}

export async function channelFiles(channelId: string, a: Actor) {
  const ch = await load(channelId, a);
  const rows = await ConnectMessage.find({ channel: ch._id, deletedAt: null, 'attachments.0': { $exists: true } }).sort({ createdAt: -1 }).limit(200).lean();
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.author)))] } }).select('name').lean();
  return rows.flatMap((r) =>
    (r.attachments ?? []).map((f) => ({
      fileId: String(f.fileId),
      name: f.name ?? 'file',
      size: f.size ?? 0,
      mimeType: f.mimeType ?? '',
      kind: f.kind ?? 'document',
      voice: !!(f as { voice?: boolean }).voice,
      messageId: String(r._id),
      by: users.find((u) => String(u._id) === String(r.author))?.name ?? 'Former member',
      at: r.createdAt,
    })),
  );
}

/** Short-lived private link for one attachment, only for people who can read the channel. */
export async function attachmentUrl(channelId: string, fileId: string, a: Actor) {
  const ch = await load(channelId, a);
  const m = await ConnectMessage.findOne({ channel: ch._id, deletedAt: null, 'attachments.fileId': new Types.ObjectId(fileId) }).select('attachments').lean();
  const f = m?.attachments?.find((x) => String(x.fileId) === fileId);
  if (!f) throw AppError.notFound('File not found');
  return storedFileUrl(f as unknown as StoredFile);
}

export async function searchMessages(q: string, a: Actor) {
  const me = new Types.ObjectId(a.id);
  const channels = await ConnectChannel.find({ 'members.user': me }).select('name kind pinned members').lean();
  const rows = await ConnectMessage.find({ channel: { $in: channels.map((c) => c._id) }, deletedAt: null, body: new RegExp(escapeRegex(q), 'i') }).sort({ createdAt: -1 }).limit(30).lean();
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.author)))] } }).select('name role').lean();
  const authors = new Map(users.map((u) => [String(u._id), { name: u.name, role: u.role }]));
  return rows.map((r) => {
    const c = channels.find((x) => String(x._id) === String(r.channel))!;
    return { ...present(r as MsgDoc, authors, a.id, new Set(c.pinned.map(String))), channelName: c.kind === 'DM' ? 'Direct message' : c.name, channelKind: c.kind };
  });
}

export async function channelHistory(channelId: string, a: Actor) {
  const ch = await load(channelId, a);
  const logs = await AuditLog.find({ entity: 'ConnectChannel', entityId: ch._id }).sort({ at: -1 }).limit(100).populate('user', 'name').lean();
  return logs.map((l) => ({ id: String(l._id), action: l.action, reason: l.reason ?? '', at: l.at, by: (l.user as unknown as { name?: string } | null)?.name ?? null }));
}

/** Everything Connect keeps for one project: channels, messages and their stored files. Run before the project is purged. */
export async function removeProjectConnectData(projectId: string): Promise<{ failed: string[] }> {
  const channels = await ConnectChannel.find({ project: projectId }).select('_id').lean();
  const ids = channels.map((c) => c._id);
  if (!ids.length) return { failed: [] };
  const withFiles = await ConnectMessage.find({ channel: { $in: ids }, 'attachments.0': { $exists: true } }).select('attachments').lean();
  const files = withFiles.flatMap((m) => (m.attachments ?? []) as unknown as StoredFile[]);
  return removeStoredFiles(files);
}
