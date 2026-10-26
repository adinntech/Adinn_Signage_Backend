import type { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { eraseStoredFile, storeEmbeddedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { User } from '../users/user.model';
import { renderOnboardingPdf, type OnboardingPerson } from './onboarding.pdf';
import { phpMailAvailable } from './phpMail';
import { deliver } from './salesMail.service';
import { SalesOrder } from './sales.model';
import type { onboardingBody, sendEmailBody } from './sales.validators';

type Form = z.infer<typeof onboardingBody>;
const person = (p?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null } | null): OnboardingPerson | null =>
  p ? { name: p.name ?? undefined, designation: p.designation ?? undefined, mobile: p.phone ?? undefined, email: p.email ?? undefined } : null;

async function leadOrder(id: string) {
  // Lean: the stored file records are passed on as plain objects (attachments, storage look-ups).
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null }).select('orderNo client clientType lead onboardingPdf onboardingPdfAt onboardingPdfBy').populate('onboardingPdfBy', 'name').lean();
  if (!o) throw AppError.notFound('Order not found');
  if (!o.lead) throw AppError.notFound('This order is not a lead yet');
  return o;
}

async function clientOf(id: unknown) {
  const c = await Client.findOne({ _id: id, deletedAt: null }).lean();
  if (!c) throw AppError.notFound('Client not found');
  return c;
}

/** Saved form, or one prefilled from the client record (address, GST, primary contact as key management). */
function formOf(c: Awaited<ReturnType<typeof clientOf>>) {
  if (c.onboarding?.savedAt) {
    const { savedAt: _a, savedBy: _b, ...form } = c.onboarding;
    return { form, saved: true };
  }
  const primary = c.contacts?.find((k) => k.isPrimary) ?? c.contacts?.[0];
  return {
    saved: false,
    form: {
      registered: { road: c.address ?? undefined, city: c.city ?? undefined, district: c.district ?? undefined, state: c.state ?? undefined, pincode: c.pincode ?? undefined },
      keyManagement: primary ? [person(primary)] : [],
      accounts: null,
      finance: null,
    },
  };
}

/** Client Registered: the form, the latest PDF and an email draft addressed to the primary contact. */
export async function getOnboarding(id: string, actor: Actor) {
  const o = await leadOrder(id);
  const [c, me] = await Promise.all([clientOf(o.client), User.findById(actor.id).select('name').lean()]);
  const primary = c.contacts?.find((k) => k.isPrimary) ?? c.contacts?.[0];
  const { form, saved } = formOf(c);
  const greeting = escapeHtml(primary?.name ?? 'Sir/Madam');
  return {
    client: { _id: c._id, name: c.name, email: c.email ?? null, gstin: c.gstin ?? null },
    form,
    saved,
    pdf: o.onboardingPdf ?? null,
    pdfAt: o.onboardingPdfAt ?? null,
    pdfBy: (o.onboardingPdfBy as unknown as { name?: string } | null)?.name ?? null,
    mailEnabled: phpMailAvailable(),
    from: env.MAIL_FROM ?? null,
    draft: {
      to: [primary?.email ?? c.email].filter(Boolean) as string[],
      cc: [],
      subject: `Customer Onboarding Form - ${c.name}`,
      body:
        `<p>Dear ${greeting},</p>` +
        `<p>Thank you for choosing ADINN Advertising Services Ltd. Please find the Customer Onboarding Form for <b>${escapeHtml(c.name)}</b> attached.</p>` +
        `<p>Kindly verify the details and let us know if anything needs to be corrected.</p>` +
        `<p>Regards,<br>${escapeHtml(me?.name ?? '')}</p>`,
    },
  };
}

/** Is this file attached to an email that was already sent? (then it must be kept for the history) */
const usedByEmail = (orderId: unknown, fileId: unknown) => SalesOrder.exists({ _id: orderId, 'salesprofile.attachments.fileId': fileId });

/** Saves the form on the client (reused by later orders) and generates a fresh PDF for this order. */
export async function saveOnboarding(id: string, input: Form, actor: Actor) {
  const o = await leadOrder(id);
  if (o.lead?.status === 'CLOSED') throw AppError.conflict('This lead is closed. Reopen it to continue.');
  const c = await clientOf(o.client);
  const onboarding = { ...input, savedAt: new Date(), savedBy: actor.id };
  await Client.updateOne({ _id: c._id }, { $set: { onboarding, updatedBy: actor.id } });

  const buffer = await renderOnboardingPdf({
    ...input,
    orderNo: o.orderNo,
    date: new Date(),
    companyName: c.name,
    companyEmail: c.email,
    gstin: c.gstin,
    keyManagement: input.keyManagement,
  });
  const safeName = c.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'Client';
  const stamp = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replaceAll('/', '.');
  const pdf = await storeEmbeddedFile({
    category: 'LEAD_ONBOARDING_FORM',
    clientName: c.name,
    folderKey: o.orderNo,
    file: { originalname: `Customer_Onboarding_Form_${safeName}_${stamp}.pdf`, mimetype: 'application/pdf', size: buffer.length, buffer },
    actor,
    owner: { entity: 'SalesOrder', id: o._id },
  });
  const previous = o.onboardingPdf as StoredFile | null;
  await SalesOrder.updateOne({ _id: o._id }, { $set: { onboardingPdf: pdf, onboardingPdfAt: new Date(), onboardingPdfBy: actor.id, updatedBy: actor.id } });
  if (previous?.fileId && !(await usedByEmail(o._id, previous.fileId))) await eraseStoredFile(previous, actor, { entity: 'SalesOrder', id: o._id });
  await recordAudit({ actor, action: 'UPDATE', entity: 'Client', entityId: c._id, reason: `Customer onboarding form saved (${o.orderNo})` });
  return getOnboarding(id, actor);
}

/** Emails the latest onboarding PDF (as a link) through the PHP mail service and records it in the email history. */
export async function sendOnboarding(id: string, input: z.infer<typeof sendEmailBody>, actor: Actor) {
  const o = await leadOrder(id);
  if (o.lead?.status === 'CLOSED') throw AppError.conflict('This lead is closed. Reopen it to continue.');
  const pdf = o.onboardingPdf as StoredFile | null;
  if (!pdf?.fileId) throw AppError.conflict('Save the onboarding form to generate its PDF before emailing it');
  return deliver({
    order: o._id,
    client: o.client as never,
    kind: 'ONBOARDING',
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: sanitizeHtml(input.body),
    attachments: [{ ...pdf, mimeType: pdf.mimeType ?? 'application/pdf' }],
    requestKey: input.requestKey,
    actor,
  });
}
