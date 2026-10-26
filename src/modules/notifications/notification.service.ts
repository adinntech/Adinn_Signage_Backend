import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { Client } from '../clients/client.model';
import { Project } from '../projects/project.model';
import { User } from '../users/user.model';
import { publish } from './notification.hub';
import { mailAvailable, renderMail, sendMail } from './mail.service';
import { pushAvailable, sendPush, subscriptionCount } from './push.service';
import { Notification, type NotificationKind } from './notification.model';

/** Kinds that need someone to act, so they are also emailed. The rest stay in the app to avoid inbox noise. */
const EMAIL_KINDS = new Set<NotificationKind>(['PROJECT_ASSIGNED', 'PROJECT_REASSIGNED', 'PROJECT_CANCELLED', 'PROJECT_LOSS', 'APPROVAL_CORRECTION']);
const MAX_ATTEMPTS = 3;
const OPS_ROLES = new Set(['OPERATIONS', 'RECCE_COORDINATOR']);

export interface NotifySpec {
  recipients: (string | Types.ObjectId | null | undefined)[];
  kind: NotificationKind;
  title: string;
  body: string;
  project: { _id: Types.ObjectId | string; code: string; clientName?: string | undefined };
  actorId?: string | undefined;
  /** Stable key per recipient for this event; the same key never creates a second notification. */
  dedupe: (recipientId: string) => string;
}

const linkFor = (role: string, projectId: string, kind?: string) =>
  OPS_ROLES.has(role) ? `${env.webBaseUrl}/operations/projects/${projectId}${kind === 'DOCUMENTS_ADDED' ? '?tab=documents' : ''}` : role === 'BD' ? `${env.webBaseUrl}/bd/dashboard?view=${projectId}` : `${env.webBaseUrl}/dashboard`;

/**
 * Records a notification for each recipient (never the person who caused the event) and starts email delivery.
 * It never throws: a notification problem must not fail the business action that triggered it.
 */
export async function notify(spec: NotifySpec): Promise<void> {
  try {
    const ids = [...new Set(spec.recipients.filter(Boolean).map(String))].filter((id) => id !== spec.actorId);
    if (!ids.length) return;
    const users = await User.find({ _id: { $in: ids }, isActive: true, deletedAt: null }).select('email role').lean();
    for (const u of users) {
      const wantsEmail = EMAIL_KINDS.has(spec.kind);
      const skipReason = !wantsEmail ? undefined : !u.email ? 'No email address on the account' : !mailAvailable() ? 'Email is not configured on the server' : undefined;
      const now = new Date();
      const delivery: { channel: 'EMAIL' | 'PUSH'; status: 'QUEUED' | 'SKIPPED'; to?: string | undefined; attempts: number; lastError?: string | undefined; updatedAt: Date }[] = [];
      if (wantsEmail) delivery.push({ channel: 'EMAIL', status: skipReason ? 'SKIPPED' : 'QUEUED', to: u.email, attempts: 0, lastError: skipReason, updatedAt: now });
      // Browser push goes out for every event, to every browser this person allowed notifications in.
      const pushSkip = !pushAvailable() ? 'Browser push is not configured on the server' : (await subscriptionCount(String(u._id))) === 0 ? 'No browser has allowed notifications yet' : undefined;
      if (spec.kind !== 'ADMIN_ACTIVITY') delivery.push({ channel: 'PUSH', status: pushSkip ? 'SKIPPED' : 'QUEUED', attempts: 0, lastError: pushSkip, updatedAt: now });
      try {
        const doc = await Notification.create({
          recipient: u._id,
          actor: spec.actorId,
          kind: spec.kind,
          title: spec.title,
          body: spec.body,
          project: spec.project._id,
          projectCode: spec.project.code,
          clientName: spec.project.clientName,
          dedupeKey: spec.dedupe(String(u._id)),
          deliveries: delivery,
        });
        publish(String(u._id), 'notification', toItem(doc.toObject() as never));
        if (delivery.some((d) => d.channel === 'EMAIL' && d.status === 'QUEUED')) void deliverEmail(String(doc._id));
        if (delivery.some((d) => d.channel === 'PUSH' && d.status === 'QUEUED')) void deliverPush(String(doc._id), u.role);
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e; // 11000: already notified for this event
      }
    }
  } catch (e) {
    console.error('notification failed', e);
  }
}

/**
 * Notifies the person on the other side of a project: the Operations assignee, or the BD owner who created it.
 * Does nothing when that person does not exist yet (e.g. a draft with no assignee) or is the one acting.
 */
export async function notifyProjectParty(
  projectId: string | Types.ObjectId,
  to: 'assignee' | 'owner',
  spec: Pick<NotifySpec, 'kind' | 'title' | 'body' | 'dedupe'>,
  actorId?: string,
): Promise<void> {
  try {
    const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('code client owner createdBy assignedTo').lean();
    if (!p) return;
    const recipient = to === 'assignee' ? p.assignedTo : (p.owner ?? p.createdBy);
    if (!recipient) return;
    const client = await Client.findById(p.client).select('name').lean();
    await notify({ ...spec, recipients: [recipient], project: { _id: p._id, code: p.code, clientName: client?.name }, actorId });
  } catch (e) {
    console.error('notification failed', e);
  }
}

/** Pushes one notification to the person's browsers and records whether any accepted it. */
export async function deliverPush(notificationId: string, role: string): Promise<void> {
  const n = await Notification.findById(notificationId);
  const d = n?.deliveries.find((x) => x.channel === 'PUSH');
  if (!n || !d || d.status === 'SENT' || d.status === 'SKIPPED') return;
  d.attempts = (d.attempts ?? 0) + 1;
  d.updatedAt = new Date();
  try {
    const r = await sendPush(String(n.recipient), { title: n.title, body: n.body, url: linkFor(role, String(n.project), n.kind), tag: String(n._id) });
    if (r.sent > 0) {
      d.status = 'SENT';
      d.sentAt = new Date();
      d.lastError = undefined as never;
    } else {
      d.status = 'FAILED';
      d.lastError = r.error ?? 'No browser accepted the notification';
    }
  } catch (e) {
    d.status = 'FAILED';
    d.lastError = e instanceof Error ? e.message.slice(0, 300) : 'Push failed';
  }
  await n.save();
}

/** Sends (or retries) the email for one notification and records the outcome. */
export async function deliverEmail(notificationId: string): Promise<void> {
  const n = await Notification.findById(notificationId);
  const d = n?.deliveries.find((x) => x.channel === 'EMAIL');
  if (!n || !d || !d.to || d.status === 'SENT' || d.status === 'SKIPPED') return;
  const user = await User.findById(n.recipient).select('role').lean();
  d.attempts = (d.attempts ?? 0) + 1;
  d.updatedAt = new Date();
  try {
    const mail = renderMail(n.title, n.body, linkFor(user?.role ?? '', String(n.project), n.kind));
    await sendMail({ to: d.to, ...mail });
    d.status = 'SENT';
    d.sentAt = new Date();
    d.lastError = undefined as never;
  } catch (e) {
    d.status = 'FAILED';
    d.lastError = e instanceof Error ? e.message.slice(0, 300) : 'Send failed';
  }
  await n.save();
}

/** Retries emails that failed (up to MAX_ATTEMPTS) or were queued but never finished, e.g. after a restart. */
export async function retryPendingEmails(): Promise<number> {
  const stale = new Date(Date.now() - 2 * 60_000);
  const rows = await Notification.find({
    deliveries: {
      $elemMatch: {
        channel: 'EMAIL',
        $or: [{ status: 'FAILED', attempts: { $lt: MAX_ATTEMPTS } }, { status: 'QUEUED', updatedAt: { $lt: stale } }],
      },
    },
  })
    .select('_id')
    .limit(50)
    .lean();
  for (const r of rows) await deliverEmail(String(r._id));
  return rows.length;
}

export function startNotificationRetry(everyMs = 5 * 60_000) {
  const t = setInterval(() => void retryPendingEmails().catch((e) => console.error('email retry failed', e)), everyMs);
  t.unref();
  return t;
}

/**
 * Deletes notifications that were read more than NOTIFICATION_READ_RETENTION_DAYS ago, which keeps the collection small
 * under heavy use. Unread notifications are never removed. Returns how many were deleted (0 when retention is off).
 */
export async function purgeReadNotifications(days = env.NOTIFICATION_READ_RETENTION_DAYS, now = new Date()): Promise<number> {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const r = await Notification.deleteMany({ readAt: { $ne: null, $lt: cutoff } });
  return r.deletedCount ?? 0;
}

export function startNotificationCleanup(everyHours = env.NOTIFICATION_CLEANUP_INTERVAL_HOURS) {
  const run = () => void purgeReadNotifications().then((n) => n && console.log(`Removed ${n} read notification(s) older than ${env.NOTIFICATION_READ_RETENTION_DAYS} day(s)`)).catch((e) => console.error('notification clean-up failed', e));
  run();
  const t = setInterval(run, everyHours * 60 * 60_000);
  t.unref();
  return t;
}

/* ------------------------------- reading ------------------------------- */

const WEB_KIND: Record<NotificationKind, string> = {
  PROJECT_ASSIGNED: 'assigned',
  PROJECT_REASSIGNED: 'assigned',
  DOCUMENTS_ADDED: 'documents',
  SHOPS_IMPORTED: 'imported',
  STAGE_CHANGED: 'stage',
  APPROVAL_CORRECTION: 'approval',
  PROJECT_CANCELLED: 'cancelled',
  COST_APPROVAL: 'approval',
  PROJECT_LOSS: 'cancelled',
  SHOPS_ADDED: 'imported',
  ACTIVITY: 'activity',
  ADMIN_ACTIVITY: 'activity',
};

type NotificationRow = {
  _id: unknown;
  kind: string;
  title: string;
  body: string;
  createdAt: Date;
  project?: unknown;
  projectCode?: string | null | undefined;
  clientName?: string | null | undefined;
  readAt?: Date | null | undefined;
};

/** The shape the web app shows, both in the list and in a live push. */
export function toItem(n: NotificationRow) {
  return {
    id: String(n._id),
    kind: WEB_KIND[n.kind as NotificationKind],
    title: n.title,
    text: n.body,
    at: n.createdAt.toISOString(),
    projectId: String(n.project),
    projectCode: n.projectCode ?? '',
    client: n.clientName ?? '',
    read: !!n.readAt,
  };
}

export async function listNotifications(actor: Actor, limit = 50) {
  const [rows, unread] = await Promise.all([
    Notification.find({ recipient: actor.id }).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ recipient: actor.id, readAt: null }),
  ]);
  const items = rows.map(toItem);
  return { items, unread };
}

export async function markRead(actor: Actor, id: string) {
  const r = await Notification.updateOne({ _id: id, recipient: actor.id, readAt: null }, { readAt: new Date() });
  if (!r.matchedCount && !(await Notification.exists({ _id: id, recipient: actor.id }))) throw AppError.notFound('Notification not found');
  return { ok: true };
}

export async function markAllRead(actor: Actor) {
  await Notification.updateMany({ recipient: actor.id, readAt: null }, { readAt: new Date() });
  return { ok: true };
}

/** Who was told about a project, when, whether they opened it, and the email outcome. For BD and admins. */
export async function projectNotificationLog(projectId: string) {
  const rows = await Notification.find({ project: projectId })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate<{ recipient: { name: string; role: string; email: string } }>('recipient', 'name role email')
    .lean();
  return rows.map((n) => ({
    id: String(n._id),
    kind: WEB_KIND[n.kind as NotificationKind],
    title: n.title,
    at: (n as unknown as { createdAt: Date }).createdAt.toISOString(),
    recipient: n.recipient ? { name: n.recipient.name, role: n.recipient.role, email: n.recipient.email } : null,
    readAt: n.readAt ?? null,
    deliveries: n.deliveries.map((d) => ({ channel: d.channel, status: d.status, to: d.to, attempts: d.attempts, lastError: d.lastError ?? null, sentAt: d.sentAt ?? null })),
  }));
}
