import { AppError } from '../../common/errors';
import { CodeRequest, type CodeKind } from '../codeRequests/codeRequest.model';
import { confirmCode } from '../codeRequests/codeRequest.service';
import { listEmails } from '../sales/salesMail.service';
import { routingOf } from '../mailSettings/mailRouting.service';
import { SalesOrder } from '../sales/sales.model';
import { notify } from '../notifications/notification.service';
import { User } from '../users/user.model';
import { Vendor } from '../vendors/vendor.model';
import { VendorRateApproval } from '../vendors/vendorRateApproval.model';
import { decideRateApproval } from '../vendors/vendorPrice.service';
import { findClientCode, findDecision, findEstimates, findProjectCode, findVendorNo, freshText, requestIdsIn, senderAllowed, snippetOf } from './replyParser';

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
    keep(id.startsWith('ADN-Signage-vnd-') ? await vendorReply(id, msg, fresh, from, receivedAt) : id.startsWith('ADN-Signage-vap-') ? await rateApprovalReply(id, msg, fresh, from, receivedAt) : await codeReply(id, msg, fresh, from, receivedAt));
    if (best !== 'unknown') break; // the first request ID that belongs to us is the one answered
  }
  return best;
}

async function codeReply(requestId: string, msg: IncomingReply, fresh: string, from: string[], receivedAt: Date): Promise<ReplyOutcome> {
  const rows = await CodeRequest.find({ requestId });
  if (!rows.length) return salesProjectReply(requestId, msg, fresh, from, receivedAt); // the project code request sent from the Recce / Project Assign screen
  const mail = (await listEmails(String(rows[0]!.order))).find((e) => String(e._id) === String(rows[0]!.mailRef));
  const recipients = [...(mail?.to ?? []), ...(mail?.cc ?? []), ...rows.flatMap((r) => r.bcc ?? [])];
  if (!recipients.length || !senderAllowed(from, recipients)) return 'rejected';
  if (rows.some((r) => r.reply?.messageId === msg.messageId || r.replyHistory?.some((h) => h.messageId === msg.messageId))) return 'duplicate';

  let outcome: ReplyOutcome = 'saved';
  for (const row of rows) {
    if (!row.active || row.status !== 'PENDING_CONFIRMATION') continue; // already answered, rejected or failed
    const kind = row.kind as CodeKind;
    const found = kind === 'PROJECT_CODE' ? findProjectCode(fresh) : findClientCode(fresh);
    let autoConfirmError: string | undefined;
    const estimates = kind === 'PROJECT_CODE' ? findEstimates(fresh) : [];
    const base = { messageId: msg.messageId, from: from[0] ?? '', receivedAt, snippet: snippetOf(fresh), ...(found.code ? { detectedCode: found.code } : {}), ...(estimates.length ? { estimates } : {}) };
    // A later reply on the same thread overwrites the one shown (a corrected code); every reply stays in the history with its time.
    const newest = row.reply?.receivedAt;
    const isNewest = !newest || receivedAt >= newest;
    await CodeRequest.updateOne({ _id: row._id }, { ...(isNewest ? { $set: { reply: base } } : {}), $push: { replyHistory: { ...base, at: new Date() } } });
    if (found.code && (await routingOf(kind === 'PROJECT_CODE' ? 'PROJECT_CODE' : 'CLIENT_CODE')).autoConfirm && row.sentBy) {
      try {
        // Confirmed in the name of the person who sent the request; the evidence note says it came from the reply.
        await confirmCode(String(row.order), { kind, code: found.code, evidenceNote: `Automatically from the reply of ${base.from}${estimates.length ? `. Estimates: ${estimates.join(', ')}` : ''}` }, [], { id: String(row.sentBy), role: 'CLIENT_SERVICING' });
        outcome = 'confirmed';
      } catch (e) {
        autoConfirmError = e instanceof AppError ? e.message : 'Could not confirm automatically';
        await CodeRequest.updateOne({ _id: row._id }, { $set: { 'reply.autoConfirmError': autoConfirmError } });
      }
    }
  }
  return outcome;
}

/**
 * The project code request mail sent from Project Assign (Recce): its reply gives the project code and the estimate numbers,
 * saved on the order for the Codes step to fill in (a person still checks and saves them). A later reply overwrites the one
 * shown; every reply stays in the history. Nothing is saved as the project code on its own.
 */
async function salesProjectReply(requestId: string, msg: IncomingReply, fresh: string, from: string[], receivedAt: Date): Promise<ReplyOutcome> {
  const o = await SalesOrder.findOne({ 'salesprofile.requestId': requestId, deletedAt: null }).select('salesprofile recce');
  if (!o) return 'unknown';
  const mail = o.salesprofile.find((e) => e.requestId === requestId);
  const recipients = [...(mail?.to ?? []), ...(mail?.cc ?? [])];
  if (!recipients.length || !senderAllowed(from, recipients)) return 'rejected';
  const seen = o.recce?.codeReply?.messageId === msg.messageId || o.recce?.codeReplyHistory?.some((h) => h.messageId === msg.messageId);
  if (seen) return 'duplicate';
  const found = findProjectCode(fresh);
  const estimates = findEstimates(fresh);
  const entry = { requestId, messageId: msg.messageId, from: from[0] ?? '', receivedAt, snippet: snippetOf(fresh), ...(found.code ? { detectedCode: found.code } : {}), ...(estimates.length ? { estimates } : {}) };
  const newest = o.recce?.codeReply?.receivedAt;
  const isNewest = !newest || receivedAt >= newest;
  const logged = { ...entry, at: new Date() };
  // An order without a recce section yet gets it created whole (a field cannot be set inside a null).
  if (!o.recce) await SalesOrder.updateOne({ _id: o._id }, { $set: { recce: { codeReply: entry, codeReplyHistory: [logged] } } });
  else await SalesOrder.updateOne({ _id: o._id }, { ...(isNewest ? { $set: { 'recce.codeReply': entry } } : {}), $push: { 'recce.codeReplyHistory': logged } });
  return 'saved';
}

/** A reply arrived: the login that sent the request is told, and every Super Admin gets the same in the app. One per mail (the key holds the message id). */
async function notifyReply(requester: unknown, kind: 'ACTIVITY' | 'COST_APPROVAL', title: string, body: string, key: string, path?: string) {
  const admins = await User.find({ role: 'SUPER_ADMIN', isActive: true, deletedAt: null }).select('_id').lean();
  await notify({ recipients: [requester as string], kind, title, body, path, dedupe: (r) => `${key}:${r}` });
  // An admin who is also the requester already got the message above: not told twice.
  await notify({ recipients: admins.map((x) => x._id).filter((x) => String(x) !== String(requester ?? '')), kind: 'ADMIN_ACTIVITY', title, body, path, dedupe: (r) => `admin-${key}:${r}` });
}

async function vendorReply(requestId: string, msg: IncomingReply, fresh: string, from: string[], receivedAt: Date): Promise<ReplyOutcome> {
  const v = await Vendor.findOne({ 'mails.requestId': requestId, deletedAt: null }).select('mails registration name code');
  if (!v) return 'unknown';
  const mail = v.mails.find((m) => m.requestId === requestId);
  const recipients = [...(mail?.to ?? []), ...(mail?.cc ?? []), ...(mail?.bcc ?? [])];
  if (!recipients.length || !senderAllowed(from, recipients)) return 'rejected';
  if (v.registration?.reply?.messageId === msg.messageId || v.registration?.replyHistory?.some((h) => h.messageId === msg.messageId)) return 'duplicate';
  const found = findVendorNo(fresh);
  const entry = { messageId: msg.messageId, from: from[0] ?? '', receivedAt, snippet: snippetOf(fresh), ...(found.code ? { detectedVendorNo: found.code } : {}) };
  // A later reply on the same thread overwrites the one shown (a corrected ID), but every reply stays in the history with its time.
  // An older mail read late never replaces a newer one. A saved vendor ID is only changed by a person (the screen shows the correction).
  const newest = v.registration?.reply?.receivedAt;
  const isNewest = !newest || receivedAt >= newest;
  const note = found.code ? (v.registration?.vendorIdAt ? 'Read after the ID was saved' : undefined) : found.ambiguous.length ? 'More than one number, check the mail' : 'No vendor ID found';
  await Vendor.updateOne({ _id: v._id }, {
    ...(isNewest ? { $set: { 'registration.reply': entry } } : {}),
    $push: { 'registration.replyHistory': { ...entry, at: new Date(), ...(note ? { note } : {}) } },
  });
  // The login that sent the registration request is told a reply came (in the app, as push, never twice for one mail).
  await notifyReply(mail?.sentBy, 'ACTIVITY', `Vendor registration reply: ${v.name} (${v.code})`, found.code ? `${entry.from} replied with Vendor ID ${found.code}. Open the vendor to check and save it.` : `${entry.from} replied. ${note ?? 'Open the vendor to read it.'}`, `vendor-reg-reply:${msg.messageId}`, `/vendors/registration?idFor=${v._id}`);
  return 'saved';
}

/** The approver answered a vendor amount approval request: APPROVED applies the typed cost, NOT APPROVED applies the company rate. */
async function rateApprovalReply(requestId: string, msg: IncomingReply, fresh: string, from: string[], receivedAt: Date): Promise<ReplyOutcome> {
  const a = await VendorRateApproval.findOne({ requestId }).lean();
  if (!a) return 'unknown';
  if (!senderAllowed(from, [...(a.to ?? []), ...(a.cc ?? []), ...(a.bcc ?? [])])) return 'rejected';
  if (a.reply?.messageId === msg.messageId || a.history?.some((h) => h.messageId === msg.messageId)) return 'duplicate';
  const reply = { messageId: msg.messageId, from: from[0] ?? '', receivedAt, snippet: snippetOf(fresh) };
  const log = async (outcome: string) => {
    await VendorRateApproval.updateOne({ _id: a._id }, { $push: { history: { ...reply, at: new Date(), outcome } } });
    // The login that asked for the approval is told what the reply did.
    await notifyReply(a.requestedBy, 'COST_APPROVAL', 'Vendor amount approval reply', `${reply.from}: ${outcome}`, `vendor-rate-reply:${msg.messageId}`);
  };
  // Already answered: the first clear answer stands. A later mail is only logged, so nobody is surprised by a changed cost.
  // Already answered: a clear answer in a NEWER mail than the one that decided (a corrected reply: "sorry, not approved") changes it; the history keeps both.
  if (a.status !== 'PENDING') {
    const decided = findDecision(fresh);
    const base = a.decidedBy?.includes('(manual)') ? a.decidedAt : (a.reply?.receivedAt ?? a.decidedAt);
    if (!decided) { await log(`Not clear, kept as ${a.status}`); return 'saved'; }
    if (decided === a.status) { await log(`Same answer again (${a.status})`); return 'duplicate'; }
    if (base && receivedAt <= base) { await log(`Older mail, kept as ${a.status}`); return 'duplicate'; }
    const changed = await decideRateApproval(requestId, decided, reply.from, reply, { redo: true });
    await log(changed ? `Changed from ${a.status} to ${decided}` : `Ignored: a newer request took over (${a.status})`);
    return changed ? 'confirmed' : 'duplicate';
  }
  const decision = findDecision(fresh);
  if (!decision) {
    // Neither a clear yes nor a clear no: kept for a person, still waiting; a later clear reply decides.
    await VendorRateApproval.updateOne({ _id: a._id }, { $set: { reply } });
    await log('Not clear, still waiting');
    return 'saved';
  }
  const done = await decideRateApproval(requestId, decision, reply.from, reply);
  await log(done ? `Decided: ${decision}` : 'Ignored: already answered');
  return done ? 'confirmed' : 'duplicate';
}
