import { env } from '../../config/env';
import type { StoredFile } from '../files/storedFile.schema';

/** The project code request email goes through the signage email API when its URL and key are set. */
export const signageMailAvailable = () => env.signageMailEnabled;

export interface SignageMail {
  to: string[];
  cc: string[];
  subject: string;
  requestId: string;
  /** Plain text of the edited message (the API's `message`); the HTML goes in `messageHtml`. */
  text: string;
  html: string;
  source: string;
  client: { clientName: string; clientCode: string };
  attachments: StoredFile[];
  /** Where each file comes from (by file id): ratecard, shoplist, so, communication, upload, gst. */
  docTypes?: Record<string, string> | undefined;
}

/** "03 Nov 2026": today in India (Asia/Kolkata). */
export const requestDateIst = (d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(d);

const EXT_OF: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
};

/**
 * File name the API accepts (it refuses others: 422 "Unsupported attachment filename"): letters, digits, "-" and "_"
 * plus one lowercase extension, e.g. "ADINN-QTN-2026-1_v1.0.pdf" -> "ADINN-QTN-2026-1_v1_0.pdf",
 * "Shop list (12).xlsx" -> "Shop_list_12.xlsx". Names are made unique within the email.
 */
function safeNames(files: { name?: string | null; mimeType?: string | null }[]) {
  const used = new Set<string>();
  return files.map((f) => {
    const raw = (f.name ?? '').trim();
    const dot = raw.lastIndexOf('.');
    const typed = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const ext = typed || EXT_OF[f.mimeType ?? ''] || 'bin';
    const stem = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'attachment';
    let name = `${stem}.${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem}_${i}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** docType values the API knows (vendor mail: pan, gst, bank, other): the GST certificate as gst, the rest as other. */
const apiDocType = (source?: string) => (source === 'gst' ? 'gst' : 'other');

/**
 * The JSON body the API receives, also kept in Email History and used for Resend. Attachments go as references only,
 * like the vendor registration mail: { fileId, name, size, docType } (no file content, no base64); the mail service
 * takes the files from the stored files by their id.
 */
export function signagePayload(m: SignageMail) {
  const names = safeNames(m.attachments);
  return {
    mailtype: 'project',
    toEmail: m.to,
    ccEmail: m.cc,
    subject: m.subject,
    requestId: m.requestId,
    requestDate: requestDateIst(),
    source: m.source,
    message: m.text,
    messageHtml: m.html,
    client: m.client,
    // Required by the API (422 "project.projectName required"); the request is for the Recce assignment.
    project: { projectName: 'Recce Assign' },
    // Only these four fields per file, like the vendor registration mail.
    attachments: m.attachments.map((a, i) => ({ fileId: String(a.fileId), name: names[i]!, size: a.size ?? 0, docType: apiDocType(m.docTypes?.[String(a.fileId)]) })),
  };
}

type Reply = { success?: boolean | string; status?: string | boolean | number; message?: string; error?: string };

/**
 * POSTs one project code request to the signage email API. Resolves with the API's reply text only when the API
 * confirms it accepted the email (HTTP 2xx and a success flag in the reply); throws otherwise, so the caller records
 * the email as FAILED with the reason. The key is sent only in the header and never logged.
 */
export async function sendViaSignageMail(m: SignageMail): Promise<string> {
  if (!env.SIGNAGE_MAIL_API_URL || !env.SIGNAGE_MAIL_API_KEY) throw new Error('The signage email API is not configured (SIGNAGE_MAIL_API_URL / SIGNAGE_MAIL_API_KEY)');
  let res: Response;
  try {
    res = await fetch(env.SIGNAGE_MAIL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': env.SIGNAGE_MAIL_API_KEY },
      body: JSON.stringify(signagePayload(m)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`The signage email API could not be reached: ${e instanceof Error ? e.message : 'network error'}`);
  }
  const raw = (await res.text()).slice(0, 2000);
  let body: Reply | null;
  try {
    body = JSON.parse(raw) as Reply;
  } catch {
    body = null;
  }
  const flag = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^(true|1|ok|success|sent)$/i.test(v.trim()));
  const accepted = res.ok && !!body && (flag(body.success) || flag(body.status));
  if (!accepted) {
    const why = body?.message ?? body?.error ?? (raw || `HTTP ${res.status}`);
    throw new Error(`The signage email API did not confirm the email (HTTP ${res.status}): ${String(why).slice(0, 400)}`);
  }
  return raw;
}
