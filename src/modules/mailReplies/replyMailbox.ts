import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { processReply, type ReplyOutcome } from './mailReply.service';
import { htmlToText } from './replyParser';

/** The check that is running now: a second request (Get reply while the timer is reading) waits for it and gets the same result. */
let inflight: Promise<CheckResult> | null = null;
let lastCheckedAt: Date | null = null;
/** When the mailbox was last read to the end, and whether a read is running now. */
export const replyCheckState = () => ({ lastCheckedAt, running: inflight !== null });
const LOOKBACK_DAYS = 14;

export interface CheckResult {
  checked: number;
  /** Replies that belong to a request of ours, by what happened to them. */
  outcomes: Partial<Record<ReplyOutcome, number>>;
  /** Mails that matched the search (before skipping our own sent requests and mails already read). */
  found?: number;
}

/** Out-of-office and bounce mails must never be read as an answer. */
const automatic = (headers: Map<string, unknown>, subject: string) => {
  const auto = String(headers.get('auto-submitted') ?? '').toLowerCase();
  return (
    (auto && auto !== 'no') ||
    headers.has('x-autoreply') ||
    /^(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status)/i.test(
      subject.trim(),
    )
  );
};

/**
 * Reads the mails of the last 14 days whose subject carries a request ID from the reply mailbox (IMAP) and hands each reply to
 * processReply (which ignores one it has already read). Other mail in the mailbox is never touched.
 */
export async function checkReplies(opts: { fresh?: boolean } = {}): Promise<CheckResult> {
  if (inflight) {
    if (!opts.fresh) return inflight;
    // A person's Get reply: the running read may have started before their reply arrived, so one more read follows it.
    const running = inflight;
    const first = await running.catch(() => null);
    if (inflight && inflight !== running) return inflight; // another click already started the next read: join it
    const next = await checkReplies();
    return first ? { checked: first.checked + next.checked, outcomes: merge(first.outcomes, next.outcomes) } : next;
  }
  inflight = readMailbox().finally(() => { inflight = null; });
  return inflight;
}

const merge = (a: CheckResult['outcomes'], b: CheckResult['outcomes']) => {
  const out: CheckResult['outcomes'] = { ...a };
  for (const [k, v] of Object.entries(b) as [ReplyOutcome, number][]) out[k] = (out[k] ?? 0) + v;
  return out;
};

async function readMailbox(): Promise<CheckResult> {
  const result = await readBoxes({ subject: '-Signage-' });
  lastCheckedAt = new Date();
  return result;
}

/** Message ids already handed to processReply in this server run: not downloaded again (processReply would skip them anyway). */
const handled = new Set<string>();
const HANDLED_MAX = 5000;

/**
 * Get reply for given requests (e.g. one order's project code request IDs): only the mails whose subject carries one of
 * these IDs are read (usually one or two), so it answers in seconds. When the subject was changed, the reply body is
 * searched for the ID instead. Runs beside the timer's full read (both skip a mail already read).
 */
export async function checkRequestReplies(requestIds: string[], opts: { auto?: boolean } = {}): Promise<CheckResult> {
  const ids = [...new Set(requestIds.map((x) => x.trim()).filter(Boolean))].slice(0, 20);
  if (!ids.length) return checkReplies({ fresh: true });
  const key = [...ids].sort().join(',');
  const last = recent.get(key);
  // The screen's automatic check (every 30 s while the Codes step is open): the same requests read in the last 20 s (by
  // another open screen, or a read still running) give that result, so many open screens never load the mailbox.
  // A click (Get reply) always reads again.
  if (opts.auto && last && Date.now() - last.at < AUTO_REUSE_MS) return last.result;
  const result = readRequests(ids);
  recent.set(key, { at: Date.now(), result });
  result.catch(() => recent.delete(key));
  if (recent.size > 500) for (const [k, v] of recent) if (Date.now() - v.at >= AUTO_REUSE_MS) recent.delete(k);
  return result;
}

const AUTO_REUSE_MS = 20_000;
const recent = new Map<string, { at: number; result: Promise<CheckResult> }>();

async function readRequests(ids: string[]): Promise<CheckResult> {
  const bySubject = await readBoxes({ ids, where: 'subject' });
  return bySubject.found ? bySubject : readBoxes({ ids, where: 'body', inboxOnly: true });
}

/**
 * Reads the mails of the last 14 days that match (`subject`: a subject part, or `ids` in the subject / body) and hands each
 * reply to processReply. Only the envelope is fetched first: our own sent requests (not answers), automatic subjects and
 * mails already read are skipped without downloading them (sent requests carry the attachments).
 */
async function readBoxes(q: { subject?: string; ids?: string[]; where?: 'subject' | 'body'; inboxOnly?: boolean }): Promise<CheckResult> {
  if (!env.imapEnabled)
    throw AppError.conflict(
      'The reply mailbox is not configured on the server (IMAP_HOST, IMAP_USER, IMAP_PASS).',
    );
  const client = new ImapFlow({
    host: env.IMAP_HOST!,
    port: env.IMAP_PORT,
    secure: env.IMAP_SECURE === 'true',
    auth: { user: env.IMAP_USER!, pass: env.IMAP_PASS! },
    logger: false,
  });
  const result: CheckResult = { checked: 0, outcomes: {} };
  try {
    await client.connect();
    const boxes = q.inboxOnly ? [env.IMAP_MAILBOX] : [env.IMAP_MAILBOX, env.IMAP_SENT_MAILBOX];
    for (const box of boxes.filter(Boolean)) {
      let lock;
      try {
        lock = await client.getMailboxLock(box);
      } catch (e) {
        if (box === env.IMAP_MAILBOX) throw e;
        continue;
      } // no Sent folder of that name: skip it
      try {
        // Not only unread: a person may open the reply in Gmail first. Repeats are safe, processReply skips a mail it already read.
        const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
        const searches = q.ids?.length ? q.ids.map((id) => (q.where === 'body' ? { since, body: id } : { since, subject: id })) : [{ since, subject: q.subject ?? '-Signage-' }];
        const uids = new Set<number>();
        for (const s of searches) for (const u of (await client.search(s, { uid: true })) || []) uids.add(u);
        result.found = (result.found ?? 0) + uids.size;
        if (!uids.size) continue;
        // Envelopes first (small); the full mail only for a new answer.
        const wanted: number[] = [];
        for await (const m of client.fetch([...uids].join(','), { envelope: true }, { uid: true })) {
          const subject = m.envelope?.subject ?? '';
          const id = m.envelope?.messageId ?? '';
          if (id && handled.has(id)) continue;
          if (!m.envelope?.inReplyTo && !/^\s*(re|fw|fwd)\s*:/i.test(subject)) continue; // our own sent request, not an answer
          if (/^(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status)/i.test(subject.trim())) continue;
          wanted.push(m.uid);
        }
        for (const uid of wanted) {
          const raw = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!raw || !raw.source) continue;
          const mail = await simpleParser(raw.source);
          result.checked += 1;
          const subject = mail.subject ?? '';
          if (automatic(mail.headers, subject)) continue;
          if (!mail.inReplyTo && !/^\s*(re|fw|fwd)\s*:/i.test(subject)) continue; // our own sent request, not an answer
          const outcome = await processReply({
            messageId: mail.messageId ?? `uid-${uid}`,
            from: (mail.from?.value ?? []).map((a) => a.address ?? '').filter(Boolean),
            subject,
            // An HTML-only reply is turned into text with its quoted history already removed.
            text: mail.text?.trim() ? mail.text : typeof mail.html === 'string' ? htmlToText(mail.html) : '',
            ...(mail.date ? { receivedAt: mail.date } : {}),
          });
          result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
          // Read for good (saved, confirmed, a repeat, or not ours): not downloaded again in this run.
          if (mail.messageId && outcome !== 'unknown') {
            if (handled.size >= HANDLED_MAX) handled.clear();
            handled.add(mail.messageId);
          }
        }
      } finally {
        lock.release();
      }
    }
    await client.logout();
  } catch (e) {
    if (e instanceof AppError) throw e;
    client.close();
    throw new AppError(
      502,
      'MAILBOX_ERROR',
      `The reply mailbox could not be read: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`,
    );
  }
  return result;
}

/** Checks the mailbox on a timer (MAIL_REPLY_POLL_SECONDS). Does nothing when the mailbox is not configured. */
export function startReplyPoller() {
  if (!env.imapEnabled || env.MAIL_REPLY_POLL_SECONDS <= 0) return;
  const run = () =>
    void checkReplies().catch((e) =>
      console.error('reply mailbox check failed:', e instanceof Error ? e.message : e),
    );
  setTimeout(run, 15_000).unref();
  setInterval(run, env.MAIL_REPLY_POLL_SECONDS * 1000).unref();
  console.log(`Reply mailbox: checked every ${env.MAIL_REPLY_POLL_SECONDS}s`);
}
