import { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { htmlToText, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { listAudit, recordAudit } from '../audit/audit.service';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, storedFileUrl, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { SalesOrder } from '../sales/sales.model';
import { EmailTemplate, TEMPLATE_SEED, type TemplateKey } from './template.model';
import type { templateBody } from './template.validators';

const short = (s: string | null | undefined, n = 500) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? null));

/** The template row, created from the seed on first use. */
export async function ensureTemplate(key: TemplateKey) {
  const seed = TEMPLATE_SEED[key];
  await EmailTemplate.updateOne(
    { key },
    { $setOnInsert: { key, name: seed.name, subject: seed.subject, body: seed.body, defaultSubject: seed.subject, defaultBody: seed.body, version: 1 } },
    { upsert: true },
  );
  const t = await EmailTemplate.findOne({ key }).populate('updatedBy', 'name role').lean();
  return t!;
}

/** Template plus the sender address the CRM sends from (display only). */
export async function getTemplate(key: TemplateKey) {
  const t = await ensureTemplate(key);
  return { ...t, fromEmail: env.MAIL_FROM ?? null, mailEnabled: env.mailEnabled };
}

async function saveChanges(key: TemplateKey, set: Record<string, unknown>, changes: { field: string; oldValue: unknown; newValue: unknown }[], actor: Actor, reason?: string) {
  const t = await ensureTemplate(key);
  if (!changes.length) return getTemplate(key);
  await EmailTemplate.updateOne({ _id: t._id }, { ...set, updatedBy: actor.id, $inc: { version: 1 } });
  await recordAudit({ actor, action: 'UPDATE', entity: 'EmailTemplate', entityId: t._id, changes, reason });
  return getTemplate(key);
}

export async function updateTemplate(key: TemplateKey, input: z.infer<typeof templateBody>, actor: Actor) {
  const t = await ensureTemplate(key);
  const body = sanitizeHtml(input.body);
  if (!htmlToText(body)) throw new AppError(422, 'VALIDATION_ERROR', 'Enter the email content', [{ path: 'body', message: 'Enter the email content' }]);
  const changes = [];
  if (input.subject !== t.subject) changes.push({ field: 'Email Subject', oldValue: t.subject, newValue: input.subject });
  if (body !== t.body) changes.push({ field: 'Email Content', oldValue: short(htmlToText(t.body)), newValue: short(htmlToText(body)) });
  return saveChanges(key, { subject: input.subject, body }, changes, actor);
}

export async function restoreDefault(key: TemplateKey, actor: Actor) {
  const t = await ensureTemplate(key);
  const changes = [];
  if (t.subject !== t.defaultSubject) changes.push({ field: 'Email Subject', oldValue: t.subject, newValue: t.defaultSubject });
  if (t.body !== t.defaultBody) changes.push({ field: 'Email Content', oldValue: short(htmlToText(t.body)), newValue: short(htmlToText(t.defaultBody)) });
  return saveChanges(key, { subject: t.defaultSubject, body: t.defaultBody }, changes, actor, 'Restored default');
}

/**
 * The template no longer points at `old`: erase it from storage unless an email used it. Sent emails keep their
 * attachment (history and Resend), so such a file stays in storage.
 */
async function releasePdf(old: StoredFile | null | undefined, templateId: Types.ObjectId, actor: Actor) {
  if (!old?.fileId) return;
  if (await SalesOrder.exists({ 'salesprofile.attachments.fileId': old.fileId })) return;
  await eraseStoredFile(old, actor, { entity: 'EmailTemplate', id: templateId });
}

/** Upload or replace the attached PDF. The previous file is erased, unless it was already emailed. */
export async function setTemplatePdf(key: TemplateKey, file: UploadedFile | undefined, actor: Actor) {
  if (!file) throw AppError.badRequest('Choose a PDF file to upload');
  if (!/\.pdf$/i.test(file.originalname)) throw AppError.badRequest('The company profile must be a PDF file');
  const t = await ensureTemplate(key);
  const pdf = await storeEmbeddedFile({ category: 'TEMPLATE_COMPANY_PROFILE', clientName: 'Template', folderKey: key, file, actor, owner: { entity: 'EmailTemplate', id: t._id } });
  let saved;
  try {
    saved = await saveChanges(key, { pdf }, [{ field: 'Company Profile PDF', oldValue: t.pdf?.name ?? null, newValue: pdf.name }], actor, t.pdf ? 'Replaced PDF' : 'Uploaded PDF');
  } catch (e) {
    await discardStoredFiles([pdf]);
    throw e;
  }
  await releasePdf(t.pdf, t._id, actor);
  return saved;
}

/** Removes the PDF from the template; the file is erased from storage unless it was already emailed. */
export async function removeTemplatePdf(key: TemplateKey, actor: Actor) {
  const t = await ensureTemplate(key);
  if (!t.pdf) return getTemplate(key);
  const saved = await saveChanges(key, { pdf: null }, [{ field: 'Company Profile PDF', oldValue: t.pdf.name ?? null, newValue: null }], actor, 'Removed PDF');
  await releasePdf(t.pdf, t._id, actor);
  return saved;
}

/** Signed link to open the current template PDF. */
export async function templatePdfUrl(key: TemplateKey) {
  const t = await ensureTemplate(key);
  if (!t.pdf?.fileId) throw AppError.notFound('No PDF is attached to this template');
  return storedFileUrl(t.pdf);
}

export async function templateHistory(key: TemplateKey) {
  const t = await ensureTemplate(key);
  const logs = await listAudit({ entity: 'EmailTemplate', entityId: t._id }, 200);
  return logs.flatMap((l) =>
    (l.changes ?? []).map((c, i) => ({
      id: `${String(l._id)}-${i}`,
      templateName: t.name,
      field: c.field,
      oldValue: c.oldValue ?? null,
      newValue: c.newValue ?? null,
      reason: l.reason ?? null,
      changedBy: (l.user as unknown as { name?: string } | null)?.name ?? '',
      role: l.role ?? '',
      at: l.at,
    })),
  );
}
