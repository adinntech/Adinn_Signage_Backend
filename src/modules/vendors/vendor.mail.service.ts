import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, htmlToText, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { footer, senderIdentities } from '../codeRequests/codeRequest.service';
import { signageMailAvailable } from '../codeRequests/signageCodeMail';
import { readStoredFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { routingOf } from '../mailSettings/mailRouting.service';
import { newRequestId, subjectWithId } from '../mailSettings/requestId';
import { mailAvailable, sendMail } from '../notifications/mail.service';
import { User } from '../users/user.model';
import { Vendor } from './vendor.model';
import { sendSignageVendorMail, signageAttachmentProblem } from './signageVendorMail';
import { getVendor, missingKycDocs, requiredKycDocs } from './vendor.service';

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
const DOC_LABEL: Record<string, string> = { pan: 'PAN card', gst: 'GST certificate', bank: 'Cancelled cheque', aadhaar: 'Aadhaar card', address: 'Address proof', other: 'Other document' };
/** Aadhaar number with only the last four digits shown (the full scan is attached). */
const maskAadhaar = (a?: string | null) => (a ? `XXXX XXXX ${a.slice(-4)}` : '');
/** "Name <a@b.com>" or "a@b.com" to the bare address (the reply-to of the PHP mail). */
const addressOf = (s?: string) => (s ? (/<([^>]+)>/.exec(s)?.[1] ?? s).trim() : undefined);
/** One "Label: value" line. The editor keeps only simple tags (no tables), so details are plain lines. */
const row = (k: string, v?: string | null) => (v ? `<li>${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong></li>` : '');

/** The default registration request: vendor details, the details typed in the form, the documents attached and the ask for a vendor ID. */
function defaultContent(v: Awaited<ReturnType<typeof getVendor>>) {
  const bank = v.bank?.accountNo ? [v.bank.accountName, v.bank.accountNo, v.bank.ifsc].filter(Boolean).join(' / ') : '';
  const body =
    `<p>Hi Team,</p>` +
    `<p>Please register the new vendor below in Zoho Books and reply to this mail with the <strong>Vendor ID</strong>.</p>` +
    `<ul>` +
    row('Vendor / firm', v.name) + row('Type', v.typeName ?? (v.type === 'ORGANIZATION' ? 'Organization' : 'One-man / Freelancer')) + row('Contact person', [v.contactPerson, v.designation].filter(Boolean).join(', ')) +
    row('Mobile', [v.mobile, v.mobileAlt].filter(Boolean).join(' / ')) + row('Email', v.email) + row('Address', [v.address, v.district, v.state, v.pincode].filter(Boolean).join(', ')) +
    row('PAN', v.pan) + row('GST', v.gstin ?? (v.hasGst === false ? 'Not registered for GST' : null)) + row('Aadhaar', maskAadhaar(v.aadhaar)) + row('Bank', bank) + row('Service area', (v.serviceAreas ?? []).join(', ')) +
    `</ul>` +
    `<p>The KYC documents are attached to this mail.</p>` +
    `<p>Regards,</p>`;
  return { subject: `Vendor registration request: ${v.name} (${v.code})`, body };
}

/** The vendor's data for the PHP mail template (data only: the template decides the wording and layout). */
function signageVendorData(v: Awaited<ReturnType<typeof getVendor>>) {
  return {
    vendorName: v.name,
    vendorType: v.typeName ?? (v.type === 'ORGANIZATION' ? 'Organization' : 'One-man / Freelancer'),
    vendorCode: v.code,
    contactPerson: v.contactPerson ?? undefined,
    designation: v.designation ?? undefined,
    mobile: [v.mobile, v.mobileAlt].filter(Boolean).join(' / ') || undefined,
    email: v.email ?? undefined,
    address: v.address ?? undefined,
    district: v.district ?? undefined,
    state: v.state ?? undefined,
    pincode: v.pincode ?? undefined,
    pan: v.pan ?? undefined,
    gstin: v.gstin ?? undefined,
    hasGst: v.hasGst ?? undefined,
    aadhaar: maskAadhaar(v.aadhaar) || undefined,
    bank: v.bank?.accountNo ? { accountName: v.bank.accountName ?? undefined, accountNo: v.bank.accountNo, ifsc: v.bank.ifsc ?? undefined } : undefined,
    serviceAreas: v.serviceAreas?.length ? v.serviceAreas : undefined,
  };
}

/** Names for the people ids that appear in the mail records. */
async function namesOf(ids: unknown[]) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  const users = list.length ? await User.find({ _id: { $in: list } }).select('name').lean() : [];
  const map = new Map(users.map((u) => [String(u._id), u.name]));
  return (id: unknown) => (id ? map.get(String(id)) ?? null : null);
}

/**
 * What the mail screen opens with: the saved draft (or the default text), the recipients from the settings, the files that
 * will be attached, and every mail sent before with who wrote and sent it and when it was created, last edited and sent.
 */
export async function registrationMailDraft(id: string) {
  const v = await getVendor(id);
  const d = defaultContent(v);
  const routing = await routingOf('VENDOR_REGISTRATION');
  const draft = v.registration?.draft;
  const mails = v.mails ?? [];
  const name = await namesOf([draft?.createdBy, draft?.savedBy, ...mails.flatMap((m) => [m.sentBy, m.writtenBy])]);
  const kycFiles = (v.kycFiles ?? []) as unknown as (StoredFile & { docType: string })[];
  return {
    mail: { enabled: mailAvailable() || signageMailAvailable(), identities: senderIdentities() },
    vendorType: v.type,
    hasGst: v.hasGst ?? null,
    /** The documents this vendor must have before the mail can go (the attachment slots mark these Required). */
    required: requiredKycDocs(v),
    groups: routing.to,
    /** Admin panel > Mail settings: used until a draft of this mail is saved. */
    routing: { to: routing.to, cc: routing.cc, bcc: routing.bcc },
    to: draft?.to?.length ? draft.to : routing.to,
    cc: draft?.savedAt ? (draft.cc ?? []) : routing.cc,
    bcc: draft?.savedAt ? (draft.bcc ?? []) : routing.bcc,
    subject: draft?.subject || d.subject,
    body: draft?.body || d.body,
    defaults: { subject: d.subject, body: d.body },
    hasDraft: !!draft?.savedAt,
    draft: draft?.savedAt ? { subject: draft.subject || d.subject, createdAt: draft.createdAt ?? draft.savedAt, createdBy: name(draft.createdBy), updatedAt: draft.savedAt, updatedBy: name(draft.savedBy) } : null,
    missing: missingKycDocs(v).map((k) => DOC_LABEL[k]),
    attachments: kycFiles.map((f) => ({ fileId: String(f.fileId), name: f.name ?? 'file', size: f.size ?? 0, docType: f.docType })),
    registration: v.registration ?? null,
    zohoVendorNo: v.zohoVendorNo ?? null,
    history: [...mails].reverse().map((m) => ({
      _id: m._id, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc ?? [], subject: m.subject, requestId: m.requestId ?? null, body: m.body, status: m.status, error: m.error, attachmentNames: m.attachmentNames,
      writtenAt: m.writtenAt ?? m.sentAt, writtenBy: name(m.writtenBy), lastEditedAt: m.lastEditedAt ?? m.sentAt, sentAt: m.sentAt, sentBy: name(m.sentBy),
    })),
  };
}

/** Save as Draft / autosave: keeps the mail being written until it is sent, with who first saved it and who last saved it. Addresses are checked only when it is sent. */
export async function saveRegistrationDraft(id: string, input: z.infer<typeof registrationDraftBody>, actor: Actor) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null }).select('registration.draft.createdAt registration.draft.createdBy').lean();
  if (!v) throw AppError.notFound('Vendor not found');
  const now = new Date();
  const first = v.registration?.draft;
  await Vendor.updateOne({ _id: id }, { $set: { 'registration.draft': { ...input, body: sanitizeHtml(input.body), createdAt: first?.createdAt ?? now, createdBy: first?.createdBy ?? actor.id, savedAt: now, savedBy: actor.id }, updatedBy: actor.id } });
  return { savedAt: now.toISOString() };
}

/** Throws the draft away (the mail returns to the default text). */
export async function discardRegistrationDraft(id: string, actor: Actor) {
  const r = await Vendor.updateOne({ _id: id, deletedAt: null }, { $unset: { 'registration.draft': '' }, $set: { updatedBy: actor.id } });
  if (!r.matchedCount) throw AppError.notFound('Vendor not found');
  return registrationMailDraft(id);
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
  const routing = await routingOf('VENDOR_REGISTRATION');
  const requestId = await newRequestId('VENDOR_REGISTRATION');
  const subject = subjectWithId(input.subject, requestId);
  // The PHP mail service (same as the code requests) is used when it is configured, otherwise plain SMTP.
  const viaPhp = signageMailAvailable();
  if (viaPhp) {
    const problem = signageAttachmentProblem(stored);
    if (problem) throw AppError.badRequest(problem);
  }
  let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT';
  let error: string | undefined;
  if (!viaPhp && !mailAvailable()) {
    status = 'SKIPPED';
    error = 'Email is not configured on the server (the PHP mail service or SMTP), so nothing was sent';
  } else {
    try {
      const files = await Promise.all(stored.map((f) => readStoredFile(f)));
      if (viaPhp) {
        const labelOf = (i: number) => DOC_LABEL[(stored[i] as unknown as { docType?: string }).docType ?? ''] ?? undefined;
        await sendSignageVendorMail({
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject,
          requestId,
          requestDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
          replyTo: routing.replyTo ?? addressOf(input.from ?? env.MAIL_FROM),
          vendor: signageVendorData(v.toObject() as never),
          // The PHP template writes the mail from the data above. Only a note the person changed on screen is sent as text.
          bodyHtml: sanitizeHtml(defaultContent(v.toObject() as never).body) === body ? undefined : body,
          attachments: files.map((f, i) => ({ filename: f.name, content: f.content, label: labelOf(i) })),
        });
      } else await sendMail({
        to: input.to.join(', '),
        cc: input.cc,
        ...(input.bcc.length ? { bcc: input.bcc } : {}),
        ...(input.from ? { from: input.from } : {}),
        subject,
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
      $push: { mails: { writtenAt: v.registration?.draft?.createdAt ?? new Date(), writtenBy: v.registration?.draft?.createdBy ?? actor.id, lastEditedAt: v.registration?.draft?.savedAt ?? new Date(), to: input.to, cc: input.cc, bcc: input.bcc, from: input.from ?? env.MAIL_FROM ?? '', subject, body, status, error, requestKey: input.requestKey, requestId, attachmentNames: stored.map((f) => f.name ?? 'file'), sentBy: actor.id, sentAt: new Date() } },
      ...(status === 'SENT' ? { $set: { 'registration.mailSentAt': new Date(), updatedBy: actor.id }, $unset: { 'registration.draft': '' } } : {}),
    },
  );
  if (r.modifiedCount) await recordAudit({ actor, action: 'EMAIL_SENT', entity: 'Vendor', entityId: v._id, reason: `Registration request ${status.toLowerCase()} to ${input.to.join(', ')}` });
  return registrationMailDraft(id);
}
