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
export async function checkReplies(): Promise<CheckResult> {
  if (inflight) return inflight;
  inflight = readMailbox().finally(() => { inflight = null; });
  return inflight;
}

async function readMailbox(): Promise<CheckResult> {
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
    for (const box of [env.IMAP_MAILBOX, env.IMAP_SENT_MAILBOX].filter(Boolean)) {
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
        const uids = (await client.search({ since, subject: '-Signage-' }, { uid: true })) || [];
        for (const uid of uids) {
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
  lastCheckedAt = new Date();
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
