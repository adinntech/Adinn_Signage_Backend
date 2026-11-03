import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, htmlToText, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { footer, senderIdentities } from '../codeRequests/codeRequest.service';
import { readStoredFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { mailAvailable, sendMail } from '../notifications/mail.service';
import { Vendor } from './vendor.model';
import { getVendor, missingKycDocs } from './vendor.service';

const EMAIL = z.string().trim().toLowerCase().email();
export const registrationDraftBody = z.object({
  to: z.array(z.string().trim().toLowerCase().max(200)).max(20).default([]),
  cc: z.array(z.string().trim().toLowerCase().max(200)).max(20).default([]),
  bcc: z.array(z.string().trim().toLowerCase().max(200)).max(20).default([]),
  subject: z.string().max(250).default(''),
  body: z.string().max(50000).default(''),
});
export const registrationMailBody = z.object({
  bcc: z.array(EMAIL).max(20).default([]),
  to: z.array(EMAIL).min(1, 'Enter at least one recipient').max(20),
  cc: z.array(EMAIL).max(20).default([]),
  from: z.string().trim().max(200).optional(),
  subject: z.string().trim().min(1, 'Enter the email subject').max(250),
  body: z.string().min(1, 'Enter the email content').max(50000),
  requestKey: z.string().trim().min(8).max(80),
});

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const DOC_LABEL: Record<string, string> = { pan: 'PAN card', gst: 'GST certificate', bank: 'Bank proof', address: 'Address proof', other: 'Other document' };
const group = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/** One "Label: value" line. The editor keeps only simple tags (no tables), so details are plain lines. */
const row = (k: string, v?: string | null) => (v ? `<li>${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong></li>` : '');

/** The default registration request: vendor details, the details typed in the form, the documents attached and the ask for a vendor ID. */
function defaultContent(v: Awaited<ReturnType<typeof getVendor>>) {
  const bank = v.bank?.accountNo ? [v.bank.accountName, v.bank.accountNo, v.bank.ifsc].filter(Boolean).join(' / ') : '';
  const body =
    `<p>Hi Team,</p>` +
    `<p>Please register the new vendor below in Zoho Books and reply to this mail with the <strong>Vendor ID</strong>.</p>` +
    `<ul>` +
    row('Vendor / firm', v.name) + row('Type', v.typeName ?? (v.type === 'ORGANIZATION' ? 'Organization' : 'One-man / Freelancer')) + row('Contact person', v.contactPerson) +
    row('Mobile', [v.mobile, v.mobileAlt].filter(Boolean).join(' / ')) + row('Email', v.email) + row('Address', [v.address, v.district].filter(Boolean).join(', ')) +
    row('PAN', v.pan) + row('GST', v.gstin) + row('Bank', bank) + row('Service area', (v.serviceAreas ?? []).join(', ')) +
    `</ul>` +
    `<p>The KYC documents are attached to this mail.</p>` +
    `<p>Regards,</p>`;
  return { subject: `Vendor registration request: ${v.name} (${v.code})`, body };
}

/** What the mail composer opens with: recipients from the settings, the default text, the files that will be attached, and what was sent before. */
export async function registrationMailDraft(id: string) {
  const v = await getVendor(id);
  const d = defaultContent(v);
  const draft = v.registration?.draft;
  const kycFiles = (v.kycFiles ?? []) as unknown as (StoredFile & { docType: string })[];
  return {
    mail: { enabled: mailAvailable(), identities: senderIdentities() },
    vendorType: v.type,
    groups: group(env.VENDOR_REGISTRATION_RECIPIENTS),
    to: draft?.to?.length ? draft.to : group(env.VENDOR_REGISTRATION_RECIPIENTS),
    cc: draft?.cc ?? [],
    bcc: draft?.bcc ?? [],
    subject: draft?.subject || d.subject,
    body: draft?.body || d.body,
    defaults: { subject: d.subject, body: d.body },
    hasDraft: !!draft?.savedAt,
    missing: missingKycDocs(v).map((k) => DOC_LABEL[k]),
    attachments: kycFiles.map((f) => ({ fileId: String(f.fileId), name: f.name ?? 'file', size: f.size ?? 0, docType: f.docType })),
    registration: v.registration ?? null,
    zohoVendorNo: v.zohoVendorNo ?? null,
    history: [...(v.mails ?? [])].reverse().map((m) => ({ _id: m._id, to: m.to, cc: m.cc, subject: m.subject, status: m.status, error: m.error, attachmentNames: m.attachmentNames, sentAt: m.sentAt })),
  };
}

/** Save as Draft / autosave: keeps the mail being written until it is sent. Addresses are checked only when it is sent. */
export async function saveRegistrationDraft(id: string, input: z.infer<typeof registrationDraftBody>, actor: Actor) {
  const r = await Vendor.updateOne({ _id: id, deletedAt: null }, { $set: { 'registration.draft': { ...input, body: sanitizeHtml(input.body), savedAt: new Date() }, updatedBy: actor.id } });
  if (!r.matchedCount) throw AppError.notFound('Vendor not found');
  return { savedAt: new Date().toISOString() };
}

/**
 * Sends the registration request with every uploaded KYC file attached, and stores exactly what was sent. A repeated click
 * with the same request key returns the first send instead of mailing again. Without SMTP the record says SKIPPED (never a fake "sent").
 */
export async function sendRegistrationMail(id: string, input: z.infer<typeof registrationMailBody>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null });
  if (!v) throw AppError.notFound('Vendor not found');
  const again = v.mails.find((m) => m.requestKey === input.requestKey);
  if (again) return registrationMailDraft(id);
  const missing = missingKycDocs(v.toObject() as never);
  if (missing.length) throw AppError.conflict(`Upload the required documents first: ${missing.map((k) => DOC_LABEL[k]).join(', ')}`);
  const identities = senderIdentities();
  if (input.from && !identities.includes(input.from)) throw new AppError(422, 'VALIDATION_ERROR', 'Choose one of the configured sender identities', [{ path: 'from', message: 'Choose one of the configured sender identities' }]);

  const stored = v.kycFiles as unknown as StoredFile[];
  const total = stored.reduce((n, f) => n + (f.size ?? 0), 0);
  if (total > MAX_TOTAL_BYTES) throw AppError.badRequest('The attached documents are over 25 MB together. Remove or compress some files');
  const body = sanitizeHtml(input.body);
  let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT';
  let error: string | undefined;
  if (!mailAvailable()) {
    status = 'SKIPPED';
    error = 'Email is not configured on the server (SMTP), so nothing was sent';
  } else {
    try {
      const files = await Promise.all(stored.map((f) => readStoredFile(f)));
      await sendMail({
        to: input.to.join(', '),
        cc: input.cc,
        ...(input.bcc.length ? { bcc: input.bcc } : {}),
        ...(input.from ? { from: input.from } : {}),
        subject: input.subject,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#102449">${body}${footer()}</div>`,
        text: htmlToText(body),
        attachments: files.map((f) => ({ filename: f.name, content: f.content, contentType: f.mimeType })),
      });
    } catch (e) {
      status = 'FAILED';
      error = e instanceof Error ? e.message.slice(0, 500) : 'Sending failed';
    }
  }
  // One push per request key: a parallel second click matches nothing.
  const r = await Vendor.updateOne(
    { _id: v._id, 'mails.requestKey': { $ne: input.requestKey } },
    {
      $push: { mails: { to: input.to, cc: input.cc, bcc: input.bcc, from: input.from ?? env.MAIL_FROM ?? '', subject: input.subject, body, status, error, requestKey: input.requestKey, attachmentNames: stored.map((f) => f.name ?? 'file'), sentBy: actor.id, sentAt: new Date() } },
      ...(status === 'SENT' ? { $set: { 'registration.mailSentAt': new Date(), updatedBy: actor.id }, $unset: { 'registration.draft': '' } } : {}),
    },
  );
  if (r.modifiedCount) await recordAudit({ actor, action: 'EMAIL_SENT', entity: 'Vendor', entityId: v._id, reason: `Registration request ${status.toLowerCase()} to ${input.to.join(', ')}` });
  return registrationMailDraft(id);
}
