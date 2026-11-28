import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { ConnectChannel, ConnectMessage } from '../connect/connect.model';
import { postShopMessage, shopMessagePage, shopMessages } from '../connect/connect.service';
import { validateFiles, type UploadedFile } from '../files/file.service';
import { Notification } from '../notifications/notification.model';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { User } from '../users/user.model';
import { assertProjectOpen, clientNameFor, getConfig, logEvent, reviewPath, seedItems, siteLabel, stageRecipients, type MediaItem } from './recceReview.common';
import { RecceSubmission, RecceThreadRead, type ReviewStage } from './recceReview.model';

/**
 * The shop communication thread, shared by the field router (own shops) and the review router (reviewers). The messages live in
 * the project's Adinn Connect channel (field `shop`); this file adds paging, refs, one image per message, unread counts and the
 * "new message" notification. Access to the shop is checked by the caller, which passes the loaded shop and submission.
 */

export type ThreadSite = { _id: Types.ObjectId; project: Types.ObjectId; shopName?: string | null | undefined; siteCode?: string | null | undefined; boardType?: string | null | undefined; width?: number | null | undefined; height?: number | null | undefined; unit?: string | null | undefined; quantity?: number | null | undefined; assignedTo?: Types.ObjectId | null | undefined };
export type ThreadSub = { _id: Types.ObjectId; assignee?: Types.ObjectId | null | undefined; mediaItems?: { key?: string | null; mediaKey?: string | null }[] | undefined; reviewers?: { OPS?: Types.ObjectId | null | undefined; CS?: Types.ObjectId | null | undefined } | undefined; pendingStage?: string | null | undefined };
export type ThreadCtx = { site: ThreadSite; sub: ThreadSub | null; side: 'FIELD' | 'REVIEW' };

/* ------------------------------------------------ validators ------------------------------------------------ */

const beforeParam = z.string().trim().max(40).transform((v, ctx) => {
  if (/^[a-f\d]{24}$/i.test(v)) return { id: v };
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return { date: d };
  ctx.addIssue({ code: 'custom', message: 'before must be a message id or an ISO time' });
  return z.NEVER;
});
/** No parameters = the original reply (last 100, oldest first). `limit` and / or `before` = a newest-first page. */
export const threadQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: beforeParam.optional() });
export const REF_TYPES = ['PHOTO', 'BOARD', 'VERSION'] as const;
export const refBody = z.object({ type: z.enum(REF_TYPES), id: z.string().trim().min(1).max(40) });
export type Ref = z.infer<typeof refBody>;

/** A thread post: JSON, or multipart where `refs` is a JSON string. A message needs text or a photo. */
export function parsePost(raw: Record<string, unknown> | undefined) {
  let refs: unknown = raw?.refs ?? [];
  if (typeof refs === 'string') {
    try { refs = JSON.parse(refs.trim() || '[]'); } catch { throw AppError.badRequest('refs must be a JSON array'); }
  }
  return z.object({ body: z.string().trim().max(2000).default(''), refs: z.array(refBody).max(10).default([]) }).parse({ body: raw?.body, refs });
}

/* ------------------------------------------------ read ------------------------------------------------ */

export async function listThread(actor: Actor, ctx: ThreadCtx, q: z.infer<typeof threadQuery>) {
  if (q.limit === undefined && !q.before) return { items: await shopMessages(ctx.site.project, ctx.site._id, actor.id), meta: undefined };
  const limit = q.limit ?? 30;
  const page = await shopMessagePage(ctx.site.project, ctx.site._id, actor.id, { limit, before: q.before });
  return { items: page.items, meta: { limit, hasMore: page.nextBefore !== null, nextBefore: page.nextBefore } };
}

/** Messages from other people newer than the moment this person last opened (marked read) the thread. */
export async function unreadCount(actor: Actor, ctx: ThreadCtx) {
  const ch = await ConnectChannel.findOne({ project: ctx.site.project, kind: 'PROJECT' }).select('_id').lean();
  if (!ch) return { unread: 0 };
  const read = await RecceThreadRead.findOne({ site: ctx.site._id, user: actor.id }).select('lastReadAt').lean();
  const unread = await ConnectMessage.countDocuments({ channel: ch._id, shop: ctx.site._id, deletedAt: null, author: { $ne: new Types.ObjectId(actor.id) }, ...(read ? { createdAt: { $gt: read.lastReadAt } } : {}) });
  return { unread };
}

/** Marks the thread read for this person (and the "new message" notifications of this shop). Safe to repeat. */
export async function markThreadRead(actor: Actor, ctx: ThreadCtx) {
  const now = new Date();
  const write = () => RecceThreadRead.updateOne({ site: ctx.site._id, user: actor.id }, { $set: { project: ctx.site.project, lastReadAt: now } }, { upsert: true });
  try { await write(); } catch (e) { if ((e as { code?: number }).code !== 11000) throw e; await write(); }
  await Notification.updateMany({ recipient: actor.id, site: ctx.site._id, kind: 'RECCE_MESSAGE', readAt: null }, { readAt: now });
  return { ok: true, unread: 0 };
}

/* ------------------------------------------------ post ------------------------------------------------ */

/**
 * Every ref must exist in THIS shop: a photo id of its submission (reviewers cannot point at drafts), a board key of its media items
 * (current, an earlier version, or the seeded board before the visit starts), or a version number that was really submitted.
 */
async function checkRefs(ctx: ThreadCtx, refs: Ref[]): Promise<Ref[]> {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const r of refs) {
    const k = `${r.type}:${r.id}`;
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  const bad = (m: string) => AppError.badRequest(m, [{ path: 'refs', message: m }]);
  const photos = out.filter((r) => r.type === 'PHOTO').map((r) => r.id);
  const boards = out.filter((r) => r.type === 'BOARD').map((r) => r.id);
  const versions = out.filter((r) => r.type === 'VERSION').map((r) => r.id);
  // The shop is one document: its photos, versions and boards are all read from it in one go.
  const own = ctx.sub && (photos.length || boards.length || versions.length)
    ? await RecceSubmission.findById(ctx.sub._id).select('photos._id photos.state versions.version versions.mediaItems.key').lean()
    : null;
  if (photos.length) {
    if (photos.some((id) => !/^[a-f\d]{24}$/i.test(id)) || !ctx.sub) throw bad('A referenced photo does not belong to this shop');
    const known = new Set((own?.photos ?? []).filter((p) => ctx.side !== 'REVIEW' || p.state !== 'DRAFT').map((p) => String(p._id)));
    if (photos.some((id) => !known.has(id.toLowerCase()))) throw bad('A referenced photo does not belong to this shop');
  }
  if (boards.length) {
    const keys = new Set<string>(ctx.sub ? (ctx.sub.mediaItems ?? []).map((i) => i.mediaKey ?? i.key ?? '') : (seedItems(ctx.site) as MediaItem[]).map((i) => i.key));
    for (const v of own?.versions ?? []) for (const i of v.mediaItems ?? []) keys.add(i.key);
    if (boards.some((k) => !keys.has(k))) throw bad('A referenced board item does not exist in this shop');
  }
  if (versions.length) {
    if (versions.some((v) => !/^\d{1,4}$/.test(v)) || !ctx.sub) throw bad('A referenced version does not exist in this shop');
    const have = new Set((own?.versions ?? []).map((v) => v.version));
    if (versions.map(Number).some((n) => !have.has(n))) throw bad('A referenced version does not exist in this shop');
  }
  return out.map((r) => (r.type === 'VERSION' ? { type: r.type, id: String(Number(r.id)) } : r));
}

/** Posts a person's message (text and / or one image, with optional refs), logs it on the timeline and tells the other side. */
export async function postThread(actor: Actor, ctx: ThreadCtx, input: ReturnType<typeof parsePost>, file?: UploadedFile) {
  await assertProjectOpen(ctx.site.project);
  if (!input.body && !file) throw new AppError(422, 'VALIDATION_ERROR', 'Write a message or attach a photo', [{ path: 'body', message: 'Write a message or attach a photo' }]);
  if (file) validateFiles('RECCE_SHOP_PHOTO', [file]); // one image only, same type, size and content checks as shop photos
  const refs = await checkRefs(ctx, input.refs);
  const out = await postShopMessage(ctx.site.project, ctx.site._id, actor, { body: input.body, refs, ...(file ? { file } : {}) });
  if (!out) throw AppError.conflict('The message could not be sent. Try again.');
  if (ctx.sub) await logEvent(actor, { submission: ctx.sub._id, project: ctx.site.project, site: ctx.site._id, type: 'COMMENT_ADDED', reason: (input.body || 'Photo').slice(0, 200), visibility: 'ALL' });
  await notifyMessage(actor, ctx, out.id, input.body || 'Sent a photo');
  return out;
}

/**
 * Field person writes: the reviewers of the stage waiting now (or of every stage when nothing is waiting). A reviewer writes: the person
 * doing the shop. Never the sender. The key is the message id, so a retry cannot notify twice.
 */
async function notifyMessage(actor: Actor, ctx: ThreadCtx, messageId: string, preview: string) {
  try {
    const project = await Project.findById(ctx.site.project).select('code client clientDetails').lean();
    let recipients: (Types.ObjectId | null | undefined)[];
    if (ctx.side === 'FIELD') {
      const stages = (ctx.sub?.pendingStage ? [ctx.sub.pendingStage] : (await getConfig()).stages) as ReviewStage[];
      recipients = (await Promise.all(stages.map((s) => stageRecipients(s, ctx.site.project, ctx.sub?.reviewers?.[s] ?? null)))).flat();
    } else recipients = [ctx.sub?.assignee ?? ctx.site.assignedTo];
    const who = (await User.findById(actor.id).select('name').lean())?.name ?? 'Someone';
    const clientName = project ? await clientNameFor(project) : null;
    await notify({
      recipients, kind: 'RECCE_MESSAGE', title: `New message: ${siteLabel(ctx.site)}`, body: `${who}: ${preview.slice(0, 140)}`, site: ctx.site._id, actorId: actor.id,
      ...(ctx.sub ? { path: reviewPath(ctx.sub._id) } : {}), ...(project ? { project: { _id: ctx.site.project, code: project.code, ...(clientName ? { clientName } : {}) } } : {}),
      dedupe: (r) => `recce-msg:${messageId}:${r}`,
    });
  } catch (e) {
    console.error('thread notification failed', e);
  }
}
