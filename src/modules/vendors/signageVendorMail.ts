import { AppError } from '../../common/errors';
import { env } from '../../config/env';
import { postSignageMail } from '../codeRequests/signageCodeMail';

/**
 * The vendor registration request through the cPanel PHP mail API (`mailtype: "vendor"`, template
 * signage_vendor_registration_request.php), the same service the code requests use. The PHP side renders the branded
 * mail around the text written in the CRM mail screen and attaches the real files.
 */
export interface SignageVendorMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** The VND code: shown as the request ID and used in the default subject. */
  requestId: string;
  requestDate: string;
  replyTo?: string | undefined;
  vendor: { vendorName: string; vendorType?: string | undefined; vendorCode: string };
  /** The mail text written on screen (already cleaned to simple tags). */
  bodyHtml: string;
  attachments: { filename: string; content: Buffer; label?: string | undefined }[];
}

/** Limits of the PHP API: at most 8 files, 8 MB each, and the whole request under 18 MB (base64 adds a third). */
export const SIGNAGE_MAX_FILES = 8;
export const SIGNAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The PHP script accepts about 13 MB of files; SIGNAGE_MAIL_MAX_TOTAL_MB lowers it to what the web server in front of it accepts. */
export const signageMaxTotalBytes = () => Math.round((env.SIGNAGE_MAIL_MAX_TOTAL_MB ?? 12) * 1024 * 1024);

/** Clear message instead of a PHP 422 after the upload. Returns null when the files fit. */
export function signageAttachmentProblem(files: { name?: string | null | undefined; size?: number | null | undefined }[]): string | null {
  if (files.length > SIGNAGE_MAX_FILES) return `At most ${SIGNAGE_MAX_FILES} documents can be attached to the mail (there are ${files.length}). Delete some documents.`;
  const big = files.find((f) => (f.size ?? 0) > SIGNAGE_MAX_FILE_BYTES);
  if (big) return `${big.name ?? 'A document'} is over 8 MB. Replace it with a smaller file.`;
  const limit = signageMaxTotalBytes();
  if (files.reduce((n, f) => n + (f.size ?? 0), 0) > limit) return `The documents are over ${Math.round((limit / 1048576) * 10) / 10} MB together, the most the mail service takes. Remove or compress some files.`;
  return null;
}

/** The PHP API wants a plain file name with an allowed extension, 160 characters at most. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document';
  const cleaned = base.replace(/[\r\n\t]/g, ' ').trim() || 'document';
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 150 - ext.length) + ext;
}

export function buildSignageVendorPayload(m: SignageVendorMail): Record<string, unknown> {
  return {
    mailtype: 'vendor',
    toEmail: m.to,
    ccEmail: m.cc ?? [],
    ...(m.bcc?.length ? { bccEmail: m.bcc } : {}),
    subject: m.subject,
    requestId: m.requestId,
    requestDate: m.requestDate,
    source: 'Operations Team',
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    vendor: m.vendor,
    bodyHtml: m.bodyHtml,
    attachments: m.attachments.map((a) => ({ filename: safeFileName(a.filename), base64: a.content.toString('base64'), ...(a.label ? { label: a.label } : {}) })),
  };
}

/** Turns the PHP API's short refusals into what the person can do about them. */
export function explainSignageError(message: string, m: Pick<SignageVendorMail, 'attachments'>): string {
  const mb = Math.round((m.attachments.reduce((n, a) => n + a.content.length, 0) / 1048576) * 10) / 10;
  if (/unsupported attachment filename/i.test(message)) {
    const names = m.attachments.map((a) => a.filename).join(', ');
    return `The mail service did not accept one of the files (${names}). It takes PDF, PNG, JPG, WEBP, XLS/XLSX, DOC/DOCX, ZIP, CSV, TXT. If a WEBP or another newer type was refused, the cPanel copy of index_signage.php is older than this CRM: upload the latest one, or use PNG / JPG. (${message})`;
  }
  if (/413|payload too large|request too large|entity too large/i.test(message)) {
    return `The mail service refused the size of this mail (${mb} MB of documents). The web server in front of it allows less than the CRM: raise its upload limit (nginx client_max_body_size / PHP post_max_size), or attach fewer or smaller documents, or set SIGNAGE_MAIL_MAX_TOTAL_MB lower. (${message})`;
  }
  return message;
}

export async function sendSignageVendorMail(m: SignageVendorMail) {
  const problem = signageAttachmentProblem(m.attachments.map((a) => ({ name: a.filename, size: a.content.length })));
  if (problem) throw AppError.badRequest(problem);
  try {
    return await postSignageMail(buildSignageVendorPayload(m));
  } catch (e) {
    throw new Error(explainSignageError(e instanceof Error ? e.message : 'Sending failed', m));
  }
}
