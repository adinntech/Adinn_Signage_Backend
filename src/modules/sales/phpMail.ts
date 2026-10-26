import { env } from '../../config/env';

/** Client emails go through the company's PHP mail service when PHP_MAIL_URL is set. */
export const phpMailAvailable = () => env.phpMailEnabled;

export interface PhpMail {
  from?: string | undefined;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  /** Files are passed as links (signed URLs), not as file content. */
  attachments: { name: string; url: string }[];
}

/**
 * POSTs one email as JSON to the PHP mail service. Throws when the service is unreachable or reports a failure,
 * so the caller records the email as FAILED with the reason.
 *
 * The JSON field names below are provisional: align `payload` with the PHP service's JSON contract once it is shared.
 */
export async function sendViaPhpMail(m: PhpMail) {
  if (!env.PHP_MAIL_URL) throw new Error('PHP mail service is not configured (PHP_MAIL_URL)');
  const payload = {
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    html: m.html,
    text: m.text,
    attachments: m.attachments,
  };
  let res: Response;
  try {
    res = await fetch(env.PHP_MAIL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(env.PHP_MAIL_KEY ? { 'X-Api-Key': env.PHP_MAIL_KEY } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`PHP mail service could not be reached: ${e instanceof Error ? e.message : 'network error'}`);
  }
  const raw = await res.text();
  type Reply = { success?: boolean; status?: string | boolean; message?: string; error?: string };
  let body: Reply | null;
  try {
    body = JSON.parse(raw) as Reply;
  } catch {
    body = null; // plain-text reply
  }
  const failed = !res.ok || body?.success === false || body?.status === false || (typeof body?.status === 'string' && /^(error|fail)/i.test(body.status));
  if (failed) throw new Error((body?.message ?? body?.error ?? (raw.slice(0, 200) || `PHP mail service returned HTTP ${res.status}`)).slice(0, 500));
}
