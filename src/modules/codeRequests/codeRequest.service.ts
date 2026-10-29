import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, sanitizeHtml } from '../../common/html';
import { escapeRegex, pageMeta, type Actor } from '../../common/query';
import { AuditLog, type AuditInput } from '../audit/auditLog.model';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { discardStoredFiles, readStoredFile, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { mailAvailable } from '../notifications/mail.service';
import { Project } from '../projects/project.model';
import { liveOrder } from '../sales/order.service';
import { SalesOrder } from '../sales/sales.model';
import { deliver, listEmails, type Kind } from '../sales/salesMail.service';
import { User } from '../users/user.model';
import { CodeRequest, type CodeKind, type CodeStatus } from './codeRequest.model';
import { CODE_RULES, type alreadySentBody, type codeListQuery, type confirmBody, type draftBody, type mailBody, type rejectBody, type sendBody } from './codeRequest.validators';

/** Client Servicing works the requests of the orders handed to them (scoped upstream); Super Admin may work any. */
const ACTOR_ROLES = ['CLIENT_SERVICING', 'SUPER_ADMIN'];
export const assertCodeActor = (a: Actor) => {
  if (!ACTOR_ROLES.includes(a.role)) throw AppError.forbidden();
};

const LABEL: Record<CodeKind, string> = { CLIENT_CODE: 'Client code', PROJECT_CODE: 'Project code' };
const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);
const already = (message: string) => new AppError(409, 'ALREADY_REQUESTED', message);
const day = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

/** Sender identities Client Servicing may choose: MAIL_FROM plus the configured extras. */
export const senderIdentities = () => [...new Set([env.MAIL_FROM, ...(env.MAIL_FROM_IDENTITIES ?? '').split(';')].map((s) => s?.trim()).filter(Boolean) as string[])];
const group = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const mailKindOf = (kinds: CodeKind[]): Kind => (kinds.length === 2 ? 'COMBINED_CODE_REQUEST' : kinds[0] === 'CLIENT_CODE' ? 'CLIENT_CODE_REQUEST' : 'PROJECT_CODE_REQUEST');

/** Adinn footer (added after sanitising, so the logo survives). */
const footer = () =>
  `<hr style="border:0;border-top:1px solid #d6dff0;margin:18px 0 10px">` +
  (env.MAIL_LOGO_URL ? `<img src="${escapeHtml(env.MAIL_LOGO_URL)}" alt="Adinn" height="36" style="display:block;margin-bottom:6px">` : '') +
  `<div style="font-size:12px;color:#5b6b86">Adinn Advertising Services Ltd.</div>`;

/* ------------------------------ what exists already ------------------------------ */

async function confirmedCodeOf(kind: CodeKind, orderId: Types.ObjectId, client: { approvedCode?: string | null }, recceCode?: string | null) {
  if (kind === 'CLIENT_CODE') return client.approvedCode ?? null;
  const row = await CodeRequest.findOne({ order: orderId, kind, status: 'CONFIRMED' }).select('confirmedCode').lean();
  return row?.confirmedCode ?? recceCode ?? null;
}

/** The BD team's own project code request emails for this order (sent before or instead of Client Servicing). */
async function bdMails(orderId: string) {
  const adopted = new Set((await CodeRequest.find({ order: orderId, source: 'BD' }).select('mailRef').lean()).map((r) => String(r.mailRef)));
  return (await listEmails(orderId, 'PROJECT_CODE_REQUEST')).filter((e) => e.status !== 'FAILED' && !e.resentFrom && !adopted.has(String(e._id)) && !(e as { sentBy?: { role?: string } }).sentBy?.role?.includes('CLIENT_SERVICING'));
}

type Doc = Awaited<ReturnType<typeof liveOrder>>;

async function assertRequestable(o: Doc, client: { approvedCode?: string | null }, kind: CodeKind) {
  const code = await confirmedCodeOf(kind, o._id, client, o.recce?.projectCode);
  if (code) throw already(`${LABEL[kind]} ${code} already exists for this ${kind === 'CLIENT_CODE' ? 'client' : 'order'}. Nothing to request.`);
  const live = await CodeRequest.findOne({ order: o._id, kind, active: true }).select('sentAt status').lean();
  if (live) throw already(`A ${LABEL[kind].toLowerCase()} request is already ${live.status === 'CONFIRMED' ? 'confirmed' : 'waiting for confirmation'} (sent ${day(live.sentAt)}).`);
  if (kind === 'PROJECT_CODE') {
    const bd = (await bdMails(String(o._id)))[0];
    if (bd) throw already(`The BD team already emailed the project code request on ${day(bd.sentAt)}. Open the original mail and confirm the code when it arrives.`);
  }
}

/* ---------------------------------- overview ---------------------------------- */

const row = (r: string, v: string) => `${r}: <strong>${escapeHtml(v)}</strong>`;

function defaultDrafts(o: Doc, client: { name?: string | null; clientNo?: string | null; gstin?: string | null; onboarding?: { pan?: string | null } | null }, me: string) {
  const sig = `<p>Regards,<br>${escapeHtml(me)}<br>Client Servicing</p>`;
  const clientBlock =
    `<h3>Client Code Request</h3><p>Please create a client code for the client below.</p>` +
    `<p>${[row('Client', client.name ?? '-'), row('Client ID', client.clientNo ?? '-'), row('GST Number', client.gstin ?? '-'), row('PAN', client.onboarding?.pan ?? '-')].join('<br>')}</p>`;
  const projectBlock =
    `<h3>Project Code Request</h3><p>Please create a project code for the order below.</p>` +
    `<p>${[row('Client', client.name ?? '-'), row('Order No', o.orderNo)].join('<br>')}</p>`;
  const subj = (what: string) => `${what} - ${client.name ?? 'Client'} (${o.orderNo})`;
  const wrap = (blocks: string) => `<p>Dear Team,</p>${blocks}${sig}`;
  return {
    COMBINED: { subject: subj('Client Code & Project Code Request'), body: wrap(clientBlock + projectBlock) },
    CLIENT_CODE: { subject: subj('Client Code Request'), body: wrap(clientBlock) },
    PROJECT_CODE: { subject: subj('Project Code Request'), body: wrap(projectBlock) },
  };
}

async function present(rows: Awaited<ReturnType<typeof CodeRequest.find>>) {
  const emails = new Map<string, Awaited<ReturnType<typeof listEmails>>[number]>();
  for (const orderId of new Set(rows.map((r) => String(r.order)))) for (const e of await listEmails(orderId)) emails.set(String(e._id), e);
  const users = await User.find({ _id: { $in: rows.flatMap((r) => [r.sentBy, r.confirmedBy, r.rejectedBy]).filter(Boolean) } }).select('name').lean();
  const name = (id?: Types.ObjectId | null) => users.find((u) => String(u._id) === String(id))?.name ?? null;
  return rows.map((r) => {
    const m = r.mailRef ? emails.get(String(r.mailRef)) : undefined;
    const { bcc: _bcc, ...rest } = r.toObject();
    return {
      ...rest,
      sentByName: name(r.sentBy),
      confirmedByName: name(r.confirmedBy),
      rejectedByName: name(r.rejectedBy),
      mail: m ? { id: String(m._id), from: m.from, to: m.to, cc: m.cc, subject: m.subject, body: m.body, sentAt: m.sentAt, status: m.status, error: m.error, attachments: (m.attachments ?? []).map((a) => ({ name: a.name, size: a.size })) } : null,
    };
  });
}

export async function overview(orderId: string, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  const [client, me, rowsRaw, bd] = await Promise.all([
    Client.findById(o.client).select('name clientNo gstin onboarding.pan approvedCode approvedCodeAt contacts email gstCertificates').lean(),
    User.findById(actor.id).select('name').lean(),
    CodeRequest.find({ order: o._id }).sort({ createdAt: -1 }),
    bdMails(orderId),
  ]);
  if (!client) throw AppError.notFound('Client not found');
  const requests = await present(rowsRaw);
  const stateOf = async (kind: CodeKind) => {
    const code = await confirmedCodeOf(kind, o._id, client, o.recce?.projectCode);
    const rows = requests.filter((r) => r.kind === kind);
    const live = rows.find((r) => r.active);
    const latest = rows[0];
    const bdSent = kind === 'PROJECT_CODE' && bd.length > 0;
    const state = code ? 'CONFIRMED' : live ? 'PENDING' : bdSent ? 'BD_SENT' : latest?.status === 'FAILED' ? 'FAILED' : latest?.status === 'DRAFT' ? 'DRAFT' : 'NOT_REQUESTED';
    return {
      state,
      code,
      /** Project code kept from the BD flow (not a Client Servicing confirmation). */
      fromBd: kind === 'PROJECT_CODE' && !!code && !rows.some((r) => r.status === 'CONFIRMED'),
      canRequest: !code && !live && !bdSent,
      requestId: live ? String(live._id) : null,
      bdMail: bdSent ? { id: String(bd[0]!._id), to: bd[0]!.to, cc: bd[0]!.cc, subject: bd[0]!.subject, body: bd[0]!.body, sentAt: bd[0]!.sentAt, status: bd[0]!.status, sentBy: (bd[0] as { sentBy?: { name?: string } }).sentBy?.name ?? null } : null,
    };
  };
  const primary = client.contacts?.find((c) => c.isPrimary) ?? client.contacts?.[0];
  return {
    order: { _id: String(o._id), orderNo: o.orderNo },
    client: {
      _id: String(client._id),
      name: client.name,
      clientNo: client.clientNo ?? null,
      gstin: client.gstin ?? null,
      pan: client.onboarding?.pan ?? null,
      approvedCode: client.approvedCode ?? null,
      primaryEmail: primary?.email ?? client.email ?? null,
      documents: (client.gstCertificates ?? []).map((f) => ({ fileId: f.fileId, name: f.name, size: f.size })),
    },
    kinds: { CLIENT_CODE: await stateOf('CLIENT_CODE'), PROJECT_CODE: await stateOf('PROJECT_CODE') },
    requests,
    mail: {
      enabled: mailAvailable(),
      from: env.MAIL_FROM ?? null,
      identities: senderIdentities(),
      groups: { CLIENT_CODE: group(env.CODE_REQUEST_CLIENT_RECIPIENTS), PROJECT_CODE: group(env.CODE_REQUEST_PROJECT_RECIPIENTS) },
    },
    defaults: defaultDrafts(o, client, me?.name ?? 'Client Servicing'),
    drafts: rowsRaw.filter((r) => r.status === 'DRAFT' && r.draft).map((r) => ({ kind: r.kind, ...r.draft })),
  };
}

/* ------------------------------------ drafts ----------------------------------- */

export async function saveDraft(orderId: string, input: z.infer<typeof draftBody>, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  for (const m of input.mails) {
    for (const kind of m.kinds) {
      const draft = { to: m.to ?? [], cc: m.cc ?? [], bcc: m.bcc ?? [], from: m.from, subject: m.subject ?? '', body: sanitizeHtml(m.body ?? '') };
      try {
        await CodeRequest.updateOne({ order: o._id, kind, status: 'DRAFT' }, { $set: { draft, client: o.client, createdBy: actor.id }, $setOnInsert: { status: 'DRAFT', active: false } }, { upsert: true });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    }
  }
  return overview(orderId, actor);
}

/* ------------------------------------- send ------------------------------------ */

const audit = (actor: Actor, id: Types.ObjectId, o: Doc, action: string, reason: string, changes?: AuditInput['changes']) =>
  recordAudit({ actor, action, entity: 'CodeRequest', entityId: id, reason: `${o.orderNo}: ${reason}`, ...(changes ? { changes } : {}) });

const fingerprint = (name: string, size: number) => `${name.trim().toLowerCase()}|${size}`;

/** Uploaded files plus the chosen client documents, each file once. */
async function gatherFiles(client: { gstCertificates?: StoredFile[] }, uploads: UploadedFile[], docIds: string[]) {
  const seen = new Set<string>();
  const out: UploadedFile[] = [];
  const add = (f: UploadedFile) => {
    const k = fingerprint(f.originalname, f.size);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  };
  uploads.forEach(add);
  for (const id of docIds) {
    const doc = (client.gstCertificates ?? []).find((f) => String(f.fileId) === id);
    if (!doc) throw invalid('includeClientDocs', 'That client document no longer exists');
    const f = await readStoredFile(doc);
    add({ originalname: f.name, mimetype: f.mimeType ?? 'application/pdf', size: f.content.length, buffer: f.content });
  }
  return out;
}

async function setSent(rows: Types.ObjectId[], entry: { _id: Types.ObjectId; status: string; error?: string | null; sentAt?: Date | null }, actor: Actor) {
  const failed = entry.status === 'FAILED';
  const status: CodeStatus = failed ? 'FAILED' : 'PENDING_CONFIRMATION';
  try {
    await CodeRequest.updateMany(
      { _id: { $in: rows } },
      { $set: { status, active: !failed, mailRef: entry._id, mailStatus: entry.status, mailError: failed ? (entry.error ?? 'Sending failed') : null, sentAt: entry.sentAt ?? new Date(), sentBy: actor.id, draft: null } },
    );
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw already('Another request for this code was sent at the same time. Reload the page.');
    throw e;
  }
}

export async function sendRequests(orderId: string, input: z.infer<typeof sendBody>, uploads: UploadedFile[], actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  const client = await Client.findById(o.client).select('name approvedCode gstCertificates').lean();
  if (!client) throw AppError.notFound('Client not found');
  const keyOf = (i: number) => `${input.requestKey}-${i}`;

  // Same submit again (double click / retry): answer with what the first one did.
  const done = await CodeRequest.exists({ order: o._id, requestKey: { $in: input.mails.map((_, i) => keyOf(i)) }, status: { $ne: 'DRAFT' } });
  if (done) return overview(orderId, actor);

  const allowed = senderIdentities();
  for (const [i, m] of input.mails.entries()) if (m.from && !allowed.includes(m.from)) throw invalid(`mails.${i}.from`, 'Choose one of the configured sender identities');
  for (const m of input.mails) for (const kind of m.kinds) await assertRequestable(o, client, kind);

  const files = await gatherFiles(client, uploads, input.includeClientDocs);
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await storeEmbeddedFile({ category: 'CODE_REQUEST_ATTACHMENT', clientName: client.name ?? 'Client', folderKey: o.orderNo, file: f, actor, owner: { entity: 'SalesOrder', id: o._id } }));
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }

  const multi = input.mails.length > 1;
  for (const [i, m] of input.mails.entries()) {
    const mailBatchId = randomUUID();
    const mode = m.kinds.length === 2 ? ('COMBINED' as const) : multi ? ('SEPARATE' as const) : ('SINGLE' as const);
    const rowIds: Types.ObjectId[] = [];
    for (const kind of m.kinds) {
      const set = { client: o.client, mailBatchId, mode, requestKey: keyOf(i), bcc: m.bcc, source: 'CS' as const, createdBy: actor.id };
      const r =
        (await CodeRequest.findOneAndUpdate({ order: o._id, kind, status: 'DRAFT' }, { $set: set }, { returnDocument: 'after' })) ??
        (await CodeRequest.findOneAndUpdate({ order: o._id, kind, requestKey: keyOf(i) }, { $set: set }, { returnDocument: 'after' })) ??
        (await CodeRequest.create({ order: o._id, kind, status: 'DRAFT', ...set }));
      rowIds.push(r._id);
    }
    const entry = await deliver({
      order: o._id,
      client: o.client,
      kind: mailKindOf(m.kinds),
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      from: m.from,
      subject: m.subject,
      body: sanitizeHtml(m.body) + footer(),
      attachments: stored,
      requestKey: keyOf(i),
      actor,
    });
    if (!entry) throw new AppError(500, 'INTERNAL', 'The email record could not be saved');
    await setSent(rowIds, entry, actor);
    for (const [j, kind] of m.kinds.entries()) await audit(actor, rowIds[j]!, o, 'CODE_REQUEST_SENT', `${LABEL[kind]} request ${entry.status === 'FAILED' ? 'failed' : entry.status === 'SKIPPED' ? 'recorded (email not configured)' : 'sent'} to ${m.to.join(', ')}${m.kinds.length === 2 ? ' (combined email)' : ''}`);
  }
  return overview(orderId, actor);
}

/** "Skip, already sent": the request went out outside the CRM, so just wait for the code. No email is sent. */
export async function markAlreadySent(orderId: string, input: z.infer<typeof alreadySentBody>, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  const client = await Client.findById(o.client).select('approvedCode').lean();
  if (!client) throw AppError.notFound('Client not found');
  for (const kind of input.kinds) await assertRequestable(o, client, kind);
  const mailBatchId = randomUUID();
  for (const kind of input.kinds) {
    const set = { client: o.client, mailBatchId, mode: 'MANUAL' as const, source: 'CS' as const, status: 'PENDING_CONFIRMATION' as const, active: true, sentAt: new Date(), sentBy: actor.id, evidenceNote: input.note, draft: null, createdBy: actor.id };
    try {
      const r = (await CodeRequest.findOneAndUpdate({ order: o._id, kind, status: 'DRAFT' }, { $set: set }, { returnDocument: 'after' })) ?? (await CodeRequest.create({ order: o._id, kind, ...set }));
      await audit(actor, r._id, o, 'CODE_REQUEST_MARKED_SENT', `${LABEL[kind]} request marked as already sent: ${input.note}`);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw already('Another request for this code was recorded at the same time. Reload the page.');
      throw e;
    }
  }
  return overview(orderId, actor);
}

/** Sends a failed email again (same content and files). Both codes of a combined email move together. */
export async function retryBatch(orderId: string, mailBatchId: string, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  const rows = await CodeRequest.find({ order: o._id, mailBatchId, status: 'FAILED' });
  if (!rows.length) throw AppError.conflict('There is no failed email to retry for this request.');
  for (const r of rows) {
    const live = await CodeRequest.exists({ order: o._id, kind: r.kind, active: true });
    if (live) throw already(`A ${LABEL[r.kind].toLowerCase()} request is already pending. Open it instead.`);
  }
  const prior = (await listEmails(orderId)).find((e) => String(e._id) === String(rows[0]!.mailRef));
  if (!prior) throw AppError.notFound('The original email was not found');
  const entry = await deliver({
    order: o._id,
    client: o.client,
    kind: prior.kind as Kind,
    to: prior.to,
    cc: prior.cc,
    bcc: rows[0]!.bcc,
    subject: prior.subject ?? '',
    body: prior.body ?? '',
    attachments: (prior.attachments ?? []).filter((a) => a.fileId) as StoredFile[],
    resentFrom: prior._id,
    actor,
  });
  if (!entry) throw new AppError(500, 'INTERNAL', 'The email record could not be saved');
  await setSent(rows.map((r) => r._id), entry, actor);
  for (const r of rows) await audit(actor, r._id, o, 'CODE_REQUEST_RETRY', `${LABEL[r.kind]} email retried: ${entry.status.toLowerCase()}`);
  return overview(orderId, actor);
}

/* ------------------------------ confirmation / rejection ------------------------------ */

/** The request being confirmed. If the BD emailed the project code request, that mail is picked up as the request. */
async function liveRequest(o: Doc, kind: CodeKind, actor: Actor) {
  const live = await CodeRequest.findOne({ order: o._id, kind, active: true, status: 'PENDING_CONFIRMATION' });
  if (live) return live;
  if (await CodeRequest.exists({ order: o._id, kind, status: 'CONFIRMED' })) throw already(`${LABEL[kind]} is already confirmed.`);
  const bd = kind === 'PROJECT_CODE' ? (await bdMails(String(o._id)))[0] : undefined;
  if (!bd) throw AppError.conflict(`Request the ${LABEL[kind].toLowerCase()} first: there is no request waiting for confirmation.`);
  try {
    return await CodeRequest.create({ order: o._id, client: o.client, kind, status: 'PENDING_CONFIRMATION', active: true, source: 'BD', mode: 'BD', mailRef: bd._id, mailStatus: bd.status, sentAt: bd.sentAt, createdBy: actor.id });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw already('This request was picked up at the same time. Reload the page.');
    throw e;
  }
}

export async function confirmCode(orderId: string, input: z.infer<typeof confirmBody>, actor: Actor) {
  assertCodeActor(actor);
  const { kind, code } = input;
  const rule = CODE_RULES[kind];
  if (!rule.regex.test(code)) throw invalid('code', rule.message);
  const o = await liveOrder(orderId);
  const client = await Client.findById(o.client).select('approvedCode').lean();
  if (!client) throw AppError.notFound('Client not found');

  // The code must be new: not on another client / order / project.
  if (kind === 'CLIENT_CODE') {
    if (client.approvedCode && client.approvedCode !== code) throw AppError.conflict(`This client already has the confirmed code ${client.approvedCode}. It is never overwritten here.`);
    const other = await Client.findOne({ _id: { $ne: o.client }, approvedCode: code, deletedAt: null }).select('name').lean();
    if (other) throw invalid('code', `Client code ${code} already belongs to ${other.name}`);
  } else {
    if (await Project.exists({ code })) throw invalid('code', `Project code ${code} already exists on a project`);
    const used = await SalesOrder.findOne({ _id: { $ne: o._id }, deletedAt: null, 'recce.projectCode': code }).select('orderNo').lean();
    if (used) throw invalid('code', `Project code ${code} is already used by order ${used.orderNo}`);
    if (o.recce?.projectCode && o.recce.projectCode !== code) throw AppError.conflict(`This order already has the project code ${o.recce.projectCode}.`);
  }
  if (await CodeRequest.exists({ kind, confirmedCode: code, order: { $ne: o._id } })) throw invalid('code', `${LABEL[kind]} ${code} is already confirmed on another order`);

  const req = await liveRequest(o, kind, actor);
  try {
    const r = await CodeRequest.updateOne(
      { _id: req._id, status: 'PENDING_CONFIRMATION' },
      { $set: { status: 'CONFIRMED', confirmedCode: code, confirmedAt: new Date(), confirmedBy: actor.id, evidenceNote: input.evidenceNote } },
    );
    if (!r.matchedCount) throw AppError.conflict('This request was already handled. Reload the page.');
    if (kind === 'CLIENT_CODE') {
      const c = await Client.updateOne({ _id: o.client, $or: [{ approvedCode: null }, { approvedCode: { $exists: false } }, { approvedCode: code }] }, { $set: { approvedCode: code, approvedCodeAt: new Date(), approvedCodeBy: actor.id } });
      if (!c.matchedCount) throw AppError.conflict('This client was given a different code meanwhile. Reload the page.');
    }
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw invalid('code', `${LABEL[kind]} ${code} was just used elsewhere`);
    throw e;
  }
  await audit(actor, req._id, o, 'CODE_CONFIRMED', `${LABEL[kind]} confirmed: ${code}${input.evidenceNote ? ` (${input.evidenceNote})` : ''}`, [{ field: 'confirmedCode', oldValue: null, newValue: code }]);
  return overview(orderId, actor);
}

export async function rejectRequest(orderId: string, input: z.infer<typeof rejectBody>, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  const req = await liveRequest(o, input.kind, actor);
  const r = await CodeRequest.updateOne({ _id: req._id, status: 'PENDING_CONFIRMATION' }, { $set: { status: 'REJECTED', active: false, rejectedReason: input.reason, rejectedAt: new Date(), rejectedBy: actor.id } });
  if (!r.matchedCount) throw AppError.conflict('This request was already handled. Reload the page.');
  await audit(actor, req._id, o, 'CODE_REJECTED', `${LABEL[input.kind]} request rejected: ${input.reason}`);
  return overview(orderId, actor);
}

/* ------------------------------- lists and history ------------------------------- */

/** Requests across the orders this person may work (Confirmation page), with counts per status. */
export async function listRequests(q: z.infer<typeof codeListQuery>, actor: Actor) {
  assertCodeActor(actor);
  const scope: Record<string, unknown> = { deletedAt: null };
  if (actor.role === 'CLIENT_SERVICING') scope.csAssignee = new Types.ObjectId(actor.id);
  const orderIds = (await SalesOrder.find(scope).select('_id').lean()).map((o) => o._id);
  const base: Record<string, unknown> = { order: { $in: orderIds } };
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    const [orders, clients] = await Promise.all([SalesOrder.find({ _id: { $in: orderIds }, orderNo: re }).select('_id').lean(), Client.find({ $or: [{ name: re }, { clientNo: re }] }).select('_id').limit(200).lean()]);
    base.$or = [{ order: { $in: orders.map((o) => o._id) } }, { client: { $in: clients.map((c) => c._id) } }, { confirmedCode: re }];
  }
  const filter = { ...base, ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}) };
  const [rows, total, counts] = await Promise.all([
    CodeRequest.find(filter).sort({ updatedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    CodeRequest.countDocuments(filter),
    CodeRequest.aggregate<{ _id: string; n: number }>([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const [orders, clients] = await Promise.all([
    SalesOrder.find({ _id: { $in: rows.map((r) => r.order) } }).select('orderNo').lean(),
    Client.find({ _id: { $in: rows.map((r) => r.client) } }).select('name clientNo').lean(),
  ]);
  const items = (await present(rows)).map((r, i) => ({
    ...r,
    order: orders.find((o) => String(o._id) === String(rows[i]!.order)) ?? null,
    client: clients.find((c) => String(c._id) === String(rows[i]!.client)) ?? null,
  }));
  return { items, meta: { ...pageMeta(q.page, q.limit, total), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) } };
}

export async function history(orderId: string, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  const ids = (await CodeRequest.find({ order: o._id }).select('_id').lean()).map((r) => r._id);
  const logs = await AuditLog.find({ entity: 'CodeRequest', entityId: { $in: ids } }).sort({ at: -1 }).limit(100).populate('user', 'name').lean();
  return logs.map((l) => ({ id: String(l._id), action: l.action, reason: l.reason ?? '', at: l.at, by: (l.user as unknown as { name?: string } | null)?.name ?? null }));
}

export type MailInput = z.infer<typeof mailBody>;
