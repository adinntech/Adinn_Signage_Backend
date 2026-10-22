import nodemailer from 'nodemailer';
import { env } from '../../config/env';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  cc?: string[];
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}
export type MailSender = (mail: OutgoingMail) => Promise<void>;

let sender: MailSender | undefined;

/** Real SMTP sender, built from the SMTP_* settings on first use. */
function smtpSender(): MailSender {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST!,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  });
  return async (m) => {
    await transport.sendMail({
      from: env.MAIL_FROM!,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      ...(m.cc?.length ? { cc: m.cc } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    });
  };
}

export const mailAvailable = () => !!sender || env.mailEnabled;

export async function sendMail(mail: OutgoingMail): Promise<void> {
  sender ??= smtpSender();
  await sender(mail);
}

/** Tests inject a fake sender; pass undefined to go back to the configured SMTP server. */
export function setMailSenderForTests(s: MailSender | undefined) {
  sender = s;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Plain, brand-neutral message with a single call-to-action link. */
export function renderMail(title: string, body: string, link: string): Pick<OutgoingMail, 'subject' | 'text' | 'html'> {
  return {
    subject: title,
    text: `${title}\n\n${body}\n\nOpen in ADINN Recce CRM: ${link}\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#102449">
<h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5">${esc(body)}</p>
<p><a href="${esc(link)}" style="background:#2563EB;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px">Open in ADINN Recce CRM</a></p>
<p style="font-size:12px;color:#5b6b86;margin-top:24px">You received this because a project was assigned to you or changed in the Recce CRM.</p>
</div>`,
  };
}
