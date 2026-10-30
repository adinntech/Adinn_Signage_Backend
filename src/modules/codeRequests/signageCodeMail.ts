import { env } from '../../config/env';

/**
 * Sends the Client / Project / Combined code request email through the cPanel PHP API
 * (signage_email_api/index_signage.php), which renders the branded HTML template itself.
 * Same idea as the Roadshow campaign mailer: build a structured payload, POST it, throw on failure
 * so the caller can record the email as FAILED.
 */
export type SignageMailType = 'combined' | 'client' | 'project';

export interface SignageCodeMail {
  mailType: SignageMailType;
  to: string[];
  cc?: string[];
  subject?: string;
  requestId: string;
  requestDate?: string;
  source?: string;
  message?: string;
  replyTo?: string;
  client: { clientName?: string; clientCode?: string; contactPerson?: string; email?: string; phone?: string; gstNumber?: string; panNumber?: string; address?: string };
  project?: { projectName?: string; projectType?: string; location?: string; startDate?: string; endDate?: string; businessUnit?: string; remarks?: string };
  /** Real file bytes; the PHP API attaches them (PDF, XLS/XLSX, DOCX, PNG, JPG, ZIP; max 8 files, 8 MB each). */
  attachments?: { filename: string; content: Buffer }[];
}

export const signageMailAvailable = () => env.signageMailEnabled;

export async function sendSignageCodeMail(m: SignageCodeMail) {
  if (!env.SIGNAGE_MAIL_URL || !env.SIGNAGE_MAIL_KEY) throw new Error('Signage mail API is not configured (SIGNAGE_MAIL_URL / SIGNAGE_MAIL_KEY)');
  const payload = {
    mailtype: m.mailType,
    toEmail: m.to,
    ccEmail: m.cc ?? [],
    ...(m.subject ? { subject: m.subject } : {}),
    requestId: m.requestId,
    requestDate: m.requestDate,
    source: m.source ?? 'Client Servicing Team',
    message: m.message,
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    client: m.client,
    ...(m.project ? { project: m.project } : {}),
    attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, base64: a.content.toString('base64') })),
  };
  let res: Response;
  try {
    res = await fetch(env.SIGNAGE_MAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': env.SIGNAGE_MAIL_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`Signage mail API could not be reached: ${e instanceof Error ? e.message : 'network error'}`);
  }
  const raw = await res.text();
  let body: { status?: string; message?: string } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON reply */
  }
  if (!res.ok || body?.status !== 'success') throw new Error((body?.message ?? (raw.slice(0, 200) || `Signage mail API returned HTTP ${res.status}`)).slice(0, 500));
  return body;
}
