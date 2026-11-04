import { env } from '../../config/env';
import { readStoredFile, storedFileUrl } from '../files/file.service';
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
}

/** "03 Nov 2026": today in India (Asia/Kolkata). */
export const requestDateIst = (d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(d);

/**
 * The JSON body without file content: kept in Email History (what was sent, which files) and used for Resend.
 * Attachments are references (file id, name, type, size).
 */
export function signagePayload(m: SignageMail) {
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
    attachments: m.attachments.map((a) => ({ fileId: String(a.fileId), fileName: a.name ?? 'attachment', mimeType: a.mimeType ?? 'application/octet-stream', size: a.size ?? null })),
  };
}

/**
 * Files as the API receives them. The API's attachment contract is not documented yet (the sample sends `[]`): each
 * file goes as { fileName, mimeType, size } plus either `content` (base64, default) or `url` (a short-lived link),
 * chosen by SIGNAGE_MAIL_ATTACHMENTS. Align these names with the PHP service once its contract is confirmed.
 */
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
 * File name the API accepts (it refuses names with other characters: 422 "Unsupported attachment filename"): letters,
 * digits, "-" and "_" plus one lowercase extension, e.g. "Shop list (12 shops).xlsx" -> "Shop_list_12_shops.xlsx",
 * "ADINN-QTN-2026-1_v1.0.pdf" -> "ADINN-QTN-2026-1_v1_0.pdf". Names are made unique within the email.
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

async function serializeAttachments(files: StoredFile[]) {
  const names = safeNames(files);
  return Promise.all(
    files.map(async (a, i) => {
      // Both spellings of the name key, until the API's contract is confirmed.
      const base = { fileName: names[i]!, filename: names[i]!, mimeType: a.mimeType ?? 'application/octet-stream', size: a.size ?? null };
      if (env.SIGNAGE_MAIL_ATTACHMENTS === 'url') return { ...base, url: (await storedFileUrl(a)).url };
      const f = await readStoredFile(a);
      return { ...base, mimeType: f.mimeType ?? base.mimeType, content: Buffer.from(f.content).toString('base64') };
    }),
  );
}

type Reply = { success?: boolean | string; status?: string | boolean | number; message?: string; error?: string };

/**
 * POSTs one project code request to the signage email API. Resolves with the API's reply text only when the API
 * confirms it accepted the email (HTTP 2xx and a success flag in the reply); throws otherwise, so the caller records
 * the email as FAILED with the reason. The key is sent only in the header and never logged.
 */
export async function sendViaSignageMail(m: SignageMail): Promise<string> {
  if (!env.SIGNAGE_MAIL_API_URL || !env.SIGNAGE_MAIL_API_KEY) throw new Error('The signage email API is not configured (SIGNAGE_MAIL_API_URL / SIGNAGE_MAIL_API_KEY)');
  let attachments: Awaited<ReturnType<typeof serializeAttachments>>;
  try {
    attachments = await serializeAttachments(m.attachments);
  } catch (e) {
    throw new Error(`An attachment could not be read: ${e instanceof Error ? e.message : 'file error'}`);
  }
  const { messageHtml, ...payload } = signagePayload(m);
  let res: Response;
  try {
    res = await fetch(env.SIGNAGE_MAIL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': env.SIGNAGE_MAIL_API_KEY },
      body: JSON.stringify({ ...payload, messageHtml, attachments }),
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
