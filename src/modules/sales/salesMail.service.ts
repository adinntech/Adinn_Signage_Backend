import { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, htmlToText, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { readStoredFile, storedFileUrl } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { mailAvailable, sendMail } from '../notifications/mail.service';
import { latestRevision } from '../ratecards/quotation.service';
import { revisionLabel } from '../ratecards/ratecard.model';
import { ensureTemplate } from '../templates/template.service';
import { User } from '../users/user.model';
import { ORDER_STAGES, SalesOrder, type OrderStage } from './sales.model';
import { liveOrder, orderArray } from './order.service';
import { sendSignageCodeMail, signageMailAvailable, type SignageCodeMailInput } from '../codeRequests/signageCodeMail';
import { phpMailAvailable, sendViaPhpMail } from './phpMail';
import type { sendEmailBody } from './sales.validators';

/** The full file record is copied into the sent email, so history and Resend never depend on the template or rate card. */
type Attachment = StoredFile;
export type Kind = 'COMPANY_PROFILE' | 'RATE_CARD' | 'ONBOARDING' | 'PROJECT_CODE_REQUEST' | 'CLIENT_CODE_REQUEST' | 'COMBINED_CODE_REQUEST';
const KIND_LABEL: Record<Kind, string> = { COMPANY_PROFILE: 'Company profile', RATE_CARD: 'Rate card', ONBOARDING: 'Customer onboarding form', PROJECT_CODE_REQUEST: 'Project code request', CLIENT_CODE_REQUEST: 'Client code request', COMBINED_CODE_REQUEST: 'Client code and project code request' };

const reached = (stage: string, min: OrderStage) => ORDER_STAGES.indexOf(stage as OrderStage) >= ORDER_STAGES.indexOf(min);
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));

/**
 * Sends one email and stores exactly what was sent. Customer onboarding emails go through the PHP mail service (the
 * PDF as a link); the others through SMTP. When the transport is not configured the record says SKIPPED (never a
 * fake "sent"); a failure is stored as FAILED with the reason.
 */
export async function deliver(rec: {
  order: Types.ObjectId;
  client: Types.ObjectId;
  kind: Kind;
  to: string[];
  cc: string[];
  bcc?: string[] | undefined;
  from?: string | undefined;
  subject: string;
  body: string;
  attachments: Attachment[];
  rateCardRevision?: number | undefined;
  requestKey?: string | undefined;
  resentFrom?: Types.ObjectId | undefined;
  /** Code request emails: structured fields sent to the signage PHP API (it renders the branded mail). Falls back to SMTP when the API is not configured. */
  signage?: SignageCodeMailInput | undefined;
  actor: Actor;
}) {
  const sentWithKey = async () => {
    const o = await orderArray(String(rec.order), 'salesprofile', ['sentBy']);
    return (o.salesprofile ?? []).find((e) => e.requestKey === rec.requestKey) ?? null;
  };
  if (rec.requestKey) {
    const again = await sentWithKey();
    if (again) return again;
  }
  let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT';
  let error: string | undefined;
  const php = rec.kind === 'ONBOARDING';
  const viaSignage = !!rec.signage && signageMailAvailable();
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#102449">${rec.body}</div>`;
  if (viaSignage ? false : php ? !phpMailAvailable() : !mailAvailable()) {
    status = 'SKIPPED';
    error = php ? 'The PHP mail service is not configured on the server (PHP_MAIL_URL), so nothing was sent' : 'Email is not configured on the server (SMTP), so nothing was sent';
  } else {
    try {
      if (viaSignage) {
        const files = await Promise.all(rec.attachments.map((a) => readStoredFile(a)));
        await sendSignageCodeMail({ ...rec.signage!, to: rec.to, cc: rec.cc, ...(rec.bcc?.length ? { bcc: rec.bcc } : {}), subject: rec.subject, attachments: files.map((f) => ({ filename: f.name, content: f.content })) });
      } else if (php) {
        const links = await Promise.all(rec.attachments.map(async (a) => ({ name: a.name ?? 'attachment.pdf', url: (await storedFileUrl(a)).url })));
        await sendViaPhpMail({ from: env.MAIL_FROM, to: rec.to, cc: rec.cc, subject: rec.subject, html, text: htmlToText(rec.body), attachments: links });
      } else {
        const files = await Promise.all(rec.attachments.map((a) => readStoredFile(a)));
        await sendMail({
          to: rec.to.join(', '),
          cc: rec.cc,
          ...(rec.bcc?.length ? { bcc: rec.bcc } : {}),
          ...(rec.from ? { from: rec.from } : {}),
          subject: rec.subject,
          html,
          text: htmlToText(rec.body),
          attachments: files.map((f) => ({ filename: f.name, content: f.content, contentType: f.mimeType })),
        });
      }
    } catch (e) {
      status = 'FAILED';
      error = e instanceof Error ? e.message.slice(0, 500) : 'Sending failed';
    }
  }
  const emailId = new Types.ObjectId();
  const entry = {
    _id: emailId,
    kind: rec.kind,
    from: rec.from ?? env.MAIL_FROM ?? '',
    to: rec.to,
    cc: rec.cc,
    subject: rec.subject,
    body: rec.body,
    attachments: rec.attachments,
    rateCardRevision: rec.rateCardRevision,
    status,
    error,
    requestKey: rec.requestKey,
    resentFrom: rec.resentFrom,
    sentBy: new Types.ObjectId(rec.actor.id),
    sentAt: new Date(),
  };
  // Append once per request key: a second click with the same key matches nothing and returns the first send.
  const filter = rec.requestKey ? { _id: rec.order, 'salesprofile.requestKey': { $ne: rec.requestKey } } : { _id: rec.order };
  const r = await SalesOrder.updateOne(filter, { $push: { salesprofile: entry } });
  if (!r.modifiedCount && rec.requestKey) return sentWithKey();
  await recordAudit({ actor: rec.actor, action: 'EMAIL_SENT', entity: 'SalesOrder', entityId: rec.order, reason: `${KIND_LABEL[rec.kind]} email ${status.toLowerCase()} to ${rec.to.join(', ')}` });
  const o = await orderArray(String(rec.order), 'salesprofile', ['sentBy']);
  return (o.salesprofile ?? []).find((e) => String(e._id) === String(emailId)) ?? null;
}

/** Company Profile email prefilled from the latest saved master template (the template itself is not changed). */
export async function companyProfileDraft(orderId: string, actor: Actor) {
  const o = await liveOrder(orderId);
  const [client, me, t] = await Promise.all([Client.findById(o.client).lean(), User.findById(actor.id).select('name').lean(), ensureTemplate('COMPANY_PROFILE')]);
  const primary = client?.contacts?.find((c) => c.isPrimary) ?? client?.contacts?.[0];
  const vars = { companyName: escapeHtml(client?.name ?? ''), contactName: escapeHtml(primary?.name ?? 'Sir/Madam'), senderName: escapeHtml(me?.name ?? '') };
  return {
    from: env.MAIL_FROM ?? null,
    mailEnabled: mailAvailable(),
    to: [primary?.email ?? client?.email].filter(Boolean) as string[],
    cc: [],
    subject: fill(t.subject, { ...vars, companyName: client?.name ?? '' }),
    body: fill(t.body, vars),
    templateVersion: t.version,
    pdf: t.pdf ?? null,
  };
}

export async function sendCompanyProfile(orderId: string, input: z.infer<typeof sendEmailBody>, actor: Actor) {
  const o = await liveOrder(orderId);
  if (!reached(o.stage, 'COMPANY_PROFILE')) throw AppError.conflict('Move the order to Company Profile before sending the company profile');
  const t = await ensureTemplate('COMPANY_PROFILE');
  if (!t.pdf?.fileId) throw AppError.conflict('No Company Profile PDF is attached to the template. Upload it in Email Templates first.');
  return deliver({
    order: o._id,
    client: o.client,
    kind: 'COMPANY_PROFILE',
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: sanitizeHtml(input.body),
    attachments: [t.pdf],
    requestKey: input.requestKey,
    actor,
  });
}

/** Sends the latest saved rate card revision's PDF. */
export async function sendRateCard(orderId: string, input: z.infer<typeof sendEmailBody>, actor: Actor) {
  const o = await liveOrder(orderId);
  const latest = await latestRevision(orderId);
  if (!latest?.pdf?.fileId) throw AppError.conflict('Save the rate card before emailing it');
  return deliver({
    order: o._id,
    client: o.client,
    kind: 'RATE_CARD',
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: sanitizeHtml(input.body),
    attachments: [{ ...latest.pdf, mimeType: latest.pdf.mimeType ?? 'application/pdf' }],
    rateCardRevision: latest.revision,
    requestKey: input.requestKey,
    actor,
  });
}

export async function listEmails(orderId: string, kind?: Kind) {
  const o = await orderArray(orderId, 'salesprofile', ['sentBy']);
  return (o.salesprofile ?? [])
    .filter((e) => !kind || e.kind === kind)
    .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0) || (String(b._id) > String(a._id) ? 1 : -1))
    .slice(0, 200)
    .map((r) => ({ ...r, revisionLabel: r.rateCardRevision ? revisionLabel(r.rateCardRevision) : null }));
}

/** Resend exactly the same content and attachment (the original PDF revision, not the latest). */
export async function resendEmail(emailId: string, actor: Actor) {
  const o = await SalesOrder.findOne({ 'salesprofile._id': emailId, deletedAt: null }).select('client salesprofile').lean();
  const e = o?.salesprofile?.find((x) => String(x._id) === emailId);
  if (!o || !e) throw AppError.notFound('Email not found');
  return deliver({
    order: o._id,
    client: o.client,
    kind: e.kind as Kind,
    to: e.to,
    cc: e.cc,
    subject: e.subject ?? '',
    body: e.body ?? '',
    attachments: (e.attachments ?? []).filter((a) => a.fileId) as Attachment[],
    rateCardRevision: e.rateCardRevision ?? undefined,
    resentFrom: e._id,
    actor,
  });
}
