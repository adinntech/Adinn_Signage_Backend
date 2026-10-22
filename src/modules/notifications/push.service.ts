import { z } from 'zod';
import webpush from 'web-push';
import { env } from '../../config/env';
import { PushSubscription } from './pushSubscription.model';

export const subscriptionBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(500) }),
});

export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking the notification should open. */
  url: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: PushPayload) => Promise<PushResult>;

let sender: PushSender | undefined;
let configured = false;

export const pushAvailable = () => !!sender || env.pushEnabled;
export const vapidPublicKey = () => env.VAPID_PUBLIC_KEY ?? null;

const webPushSender: PushSender = async (sub, payload) => {
  if (!configured) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
    return { ok: true };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    // 404/410: the browser revoked or uninstalled; the subscription can never work again.
    return { ok: false, gone: status === 404 || status === 410, error: e instanceof Error ? e.message.slice(0, 200) : 'Push failed' };
  }
};

/** Tests inject a fake sender; pass undefined to use the real push service. */
export function setPushSenderForTests(s: PushSender | undefined) {
  sender = s;
}

export async function saveSubscription(userId: string, sub: z.infer<typeof subscriptionBody>, userAgent?: string) {
  // The same browser may re-subscribe (or a different person may sign in on it): the endpoint is the identity.
  await PushSubscription.findOneAndUpdate({ endpoint: sub.endpoint }, { user: userId, keys: sub.keys, userAgent: userAgent?.slice(0, 200), failures: 0 }, { upsert: true });
  return { ok: true };
}

export async function removeSubscription(userId: string, endpoint: string) {
  await PushSubscription.deleteOne({ endpoint, user: userId });
  return { ok: true };
}

export const subscriptionCount = (userId: string) => PushSubscription.countDocuments({ user: userId });

/** Sends to every browser this person has allowed. Returns how many accepted it; dead subscriptions are removed. */
export async function sendPush(userId: string, payload: PushPayload): Promise<{ sent: number; error?: string }> {
  const subs = await PushSubscription.find({ user: userId }).lean();
  let sent = 0;
  let error: string | undefined;
  const send = sender ?? webPushSender;
  for (const s of subs) {
    const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.keys!.p256dh, auth: s.keys!.auth } }, payload);
    if (r.ok) {
      sent++;
      await PushSubscription.updateOne({ _id: s._id }, { lastSuccessAt: new Date(), failures: 0 });
    } else {
      error = r.error;
      if (r.gone) await PushSubscription.deleteOne({ _id: s._id });
      else await PushSubscription.updateOne({ _id: s._id }, { $inc: { failures: 1 } });
    }
  }
  return error ? { sent, error } : { sent };
}
