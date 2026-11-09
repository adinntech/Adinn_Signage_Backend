import { AppError } from '../../common/errors';
import { CodeRequest, type CodeKind } from '../codeRequests/codeRequest.model';
import { confirmCode } from '../codeRequests/codeRequest.service';
import { listEmails } from '../sales/salesMail.service';
import { routingOf } from '../mailSettings/mailRouting.service';
import { Vendor } from '../vendors/vendor.model';
import { findClientCode, findProjectCode, findVendorNo, freshText, requestIdsIn, senderAllowed, snippetOf } from './replyParser';

/** One mail read from the reply mailbox (the mailbox reader hands over plain data, so this is testable without IMAP). */
export interface IncomingReply {
  messageId: string;
  from: string[];
  subject: string;
  text: string;
  receivedAt?: Date;
}

/**
 * What happened to a mail:
 * unknown   no request of ours is named in it (left alone in the mailbox)
 * rejected  it names a request but the sender is not one of the recipients (ignored, not saved)
 * saved     the reply and any code found are kept on the request for a person to verify
 * confirmed the code was confirmed automatically (auto-confirm is on for this mail type)
 * duplicate this exact mail was already read
 */
export type ReplyOutcome = 'unknown' | 'rejected' | 'saved' | 'confirmed' | 'duplicate';

export async function processReply(msg: IncomingReply): Promise<ReplyOutcome> {
  const ids = requestIdsIn(`${msg.subject}\n${msg.text}`);
  const fresh = freshText(msg.text);
  const from = msg.from.map((f) => f.toLowerCase());
  const receivedAt = msg.receivedAt ?? new Date();
  let best: ReplyOutcome = 'unknown';
  const rank: ReplyOutcome[] = ['unknown', 'duplicate', 'rejected', 'saved', 'confirmed'];
  const keep = (o: ReplyOutcome) => { if (rank.indexOf(o) > rank.indexOf(best)) best = o; };

  for (const id of ids) {
    keep(id.startsWith('ADN-Signage-vnd-') ? await vendorReply(id, msg, fresh, from, receivedAt) : await codeReply(id, msg, fresh, from, receivedAt));
    if (best !== 'unknown') break; // the first request ID that belongs to us is the one answered
  }
  return best;
}

async function codeReply(requestId: string, msg: IncomingReply, fresh: string, from: string[], receivedAt: Date): Promise<ReplyOutcome> {
  const rows = await CodeRequest.find({ requestId });
  if (!rows.length) return 'unknown';
  const mail = (await listEmails(String(rows[0]!.order))).find((e) => String(e._id) === String(rows[0]!.mailRef));
  const recipients = [...(mail?.to ?? []), ...(mail?.cc ?? []), ...rows.flatMap((r) => r.bcc ?? [])];
  if (!recipients.length || !senderAllowed(from, recipients)) return 'rejected';
  if (rows.some((r) => r.reply?.messageId === msg.messageId)) return 'duplicate';

  let outcome: ReplyOutcome = 'saved';
  for (const row of rows) {
    if (!row.active || row.status !== 'PENDING_CONFIRMATION') continue; // already answered, rejected or failed
    const kind = row.kind as CodeKind;
    const found = kind === 'PROJECT_CODE' ? findProjectCode(fresh) : findClientCode(fresh);
    let autoConfirmError: string | undefined;
    const base = { messageId: msg.messageId, from: from[0] ?? '', receivedAt, snippet: snippetOf(fresh), ...(found.code ? { detectedCode: found.code } : {}) };
    await CodeRequest.updateOne({ _id: row._id }, { $set: { reply: base } });
    if (found.code && (await routingOf(kind === 'PROJECT_CODE' ? 'PROJECT_CODE' : 'CLIENT_CODE')).autoConfirm && row.sentBy) {
      try {
        // Confirmed in the name of the person who sent the request; the evidence note says it came from the reply.
        await confirmCode(String(row.order), { kind, code: found.code, evidenceNote: `Automatically from the reply of ${base.from}` }, [], { id: String(row.sentBy), role: 'CLIENT_SERVICING' });
        outcome = 'confirmed';
      } catch (e) {
        autoConfirmError = e instanceof AppError ? e.message : 'Could not confirm automatically';
        await CodeRequest.updateOne({ _id: row._id }, { $set: { 'reply.autoConfirmError': autoConfirmError } });
      }
    }
  }
  return outcome;
}

async function vendorReply(requestId: string, msg: IncomingReply, fresh: string, from: string[], receivedAt: Date): Promise<ReplyOutcome> {
  const v = await Vendor.findOne({ 'mails.requestId': requestId, deletedAt: null }).select('mails registration');
  if (!v) return 'unknown';
  const mail = v.mails.find((m) => m.requestId === requestId);
  const recipients = [...(mail?.to ?? []), ...(mail?.cc ?? []), ...(mail?.bcc ?? [])];
  if (!recipients.length || !senderAllowed(from, recipients)) return 'rejected';
  if (v.registration?.reply?.messageId === msg.messageId) return 'duplicate';
  if (v.registration?.vendorIdAt) return 'duplicate'; // the vendor ID is already saved
  const found = findVendorNo(fresh);
  await Vendor.updateOne({ _id: v._id }, { $set: { 'registration.reply': { messageId: msg.messageId, from: from[0] ?? '', receivedAt, snippet: snippetOf(fresh), ...(found.code ? { detectedVendorNo: found.code } : {}) } } });
  return 'saved';
}
