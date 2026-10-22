import { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { htmlToText, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { discardStoredFiles, storeEmbeddedFile } from '../files/file.service';
import { mailAvailable } from '../notifications/mail.service';
import { orderArray } from '../sales/order.service';
import { SalesOrder, WITHOUT_ARRAYS } from '../sales/sales.model';
import { User } from '../users/user.model';
import { normKey } from '../sites/site.fields';
import { renderQuotationPdf } from './quotation.pdf';
import { RATE_UNIT_LABELS, revisionLabel } from './ratecard.model';
import { masterRatesById } from './rateItem.service';
import type { quotationBody } from './ratecard.validators';

const EDITABLE_STAGES = ['RATE_CARD', 'CLIENT_APPROVAL'];

export const DEFAULT_TERMS = [
  '<ol>',
  '<li>Rates are exclusive of GST (18%).</li>',
  '<li>Artwork/design shall be provided by the client or will be charged extra.</li>',
  '<li>Installation, scaffolding and electrical work (if required) will be charged separately.</li>',
  '<li>This quotation is valid for 30 days from the date of issue.</li>',
  '<li>Payment terms: 50% advance, 50% before installation.</li>',
  '</ol>',
].join('');

/** ORD-2026-0001 -> ADINN/QTN/2026/0001 (stable across revisions). */
const quotationRefOf = (orderNo: string) => {
  const m = /^ORD-(\d{4})-(\d+)$/.exec(orderNo);
  return m ? `ADINN/QTN/${m[1]}/${m[2]}` : `ADINN/QTN/${orderNo}`;
};

const addressOf = (c: { address?: string | null; city?: string | null; district?: string | null; state?: string | null; pincode?: string | null }) =>
  [c.address, c.city, c.district, c.state].filter(Boolean).join(', ') + (c.pincode ? ` - ${c.pincode}` : '');

async function orderWithClient(orderId: string) {
  const order = await SalesOrder.findOne({ _id: orderId, deletedAt: null }).select(WITHOUT_ARRAYS).lean();
  if (!order) throw AppError.notFound('Order not found');
  const client = await Client.findById(order.client).lean();
  if (!client) throw AppError.notFound('Client not found');
  return { order, client };
}

/** Latest saved revision of an order (last item of rateCardArray; revisions are only ever appended). */
export async function latestRevision(orderId: string | Types.ObjectId) {
  const o = await SalesOrder.findById(orderId).select('currentRevision').slice('rateCardArray', -1).lean();
  return o?.rateCardArray?.[0] ?? null;
}

type Line = { masterItem?: unknown; particulars: string; specifications?: string | null; unit: string; masterRate?: number | null; quotedRate: number; overrideReason?: string | null };
type Snapshot = {
  clientAddress?: string | null;
  contact?: { name?: string | null; designation?: string | null; phone?: string | null; email?: string | null } | null;
  quotationDate: Date;
  subject: string;
  items: Line[];
  terms?: string | null;
  regards?: { name?: string | null; designation?: string | null; mobile?: string | null; email?: string | null } | null;
};
type Change = { field: string; oldValue: unknown; newValue: unknown; changeType: 'ADDED' | 'UPDATED' | 'REMOVED' };

const lineKey = (l: Line) => (l.masterItem ? `m:${String(l.masterItem)}` : `p:${normKey(l.particulars)}`);
const n = (v: unknown) => (v === undefined || v === '' ? null : v);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** One quotation line as readable text, e.g. "LED Glow Sign · Acrylic 3D letters · Sq.ft · Rs. 450". */
const describeLine = (l: Line) =>
  [l.particulars, l.specifications, RATE_UNIT_LABELS[l.unit as keyof typeof RATE_UNIT_LABELS] ?? l.unit, `Rs. ${l.quotedRate}`].filter(Boolean).join(' · ') +
  (l.overrideReason ? ` (reason: ${l.overrideReason})` : '');

/** First save: every filled-in field and item is listed as added, with its value. */
function initialChanges(next: Snapshot): Change[] {
  const add = (field: string, v: unknown): Change[] => (n(v) === null ? [] : [{ field, oldValue: null, newValue: n(v), changeType: 'ADDED' }]);
  return [
    ...add('Subject', next.subject),
    ...add('Quotation Date', day(next.quotationDate)),
    ...add('Contact Person', next.contact?.name),
    ...add('Client Address', next.clientAddress),
    ...next.items.map((l): Change => ({ field: `Item (${l.particulars})`, oldValue: null, newValue: describeLine(l), changeType: 'ADDED' })),
    ...add('Terms & Conditions', htmlToText(next.terms ?? '')),
    ...add('Regards Name', next.regards?.name),
  ];
}

/** Field-level changes between two saved versions (what the Edit History tab shows). */
export function quotationChanges(prev: Snapshot | null, next: Snapshot): Change[] {
  if (!prev) return initialChanges(next);
  const out: Change[] = [];
  const upd = (field: string, a: unknown, b: unknown) => {
    if (JSON.stringify(n(a)) !== JSON.stringify(n(b))) out.push({ field, oldValue: n(a), newValue: n(b), changeType: 'UPDATED' });
  };
  upd('Client Address', prev.clientAddress, next.clientAddress);
  upd('Contact Person', prev.contact?.name, next.contact?.name);
  upd('Quotation Date', day(prev.quotationDate), day(next.quotationDate));
  upd('Subject', prev.subject, next.subject);
  upd('Terms & Conditions', htmlToText(prev.terms ?? ''), htmlToText(next.terms ?? ''));
  upd('Regards Name', prev.regards?.name, next.regards?.name);
  upd('Regards Designation', prev.regards?.designation, next.regards?.designation);
  upd('Regards Mobile', prev.regards?.mobile, next.regards?.mobile);
  upd('Regards Email', prev.regards?.email, next.regards?.email);

  const before = new Map(prev.items.map((l) => [lineKey(l), l]));
  const after = new Map(next.items.map((l) => [lineKey(l), l]));
  for (const [k, l] of after) {
    const o = before.get(k);
    if (!o) {
      out.push({ field: `Added Item (${l.particulars})`, oldValue: null, newValue: describeLine(l), changeType: 'ADDED' });
      continue;
    }
    upd(`Signage Particulars (${o.particulars})`, o.particulars, l.particulars);
    upd(`Specifications (${l.particulars})`, o.specifications, l.specifications);
    upd(`Rate Unit (${l.particulars})`, o.unit, l.unit);
    upd(`Quoted Rate (${l.particulars})`, o.quotedRate, l.quotedRate);
    upd(`Override Reason (${l.particulars})`, o.overrideReason, l.overrideReason);
  }
  for (const [k, l] of before) if (!after.has(k)) out.push({ field: `Removed Item (${l.particulars})`, oldValue: describeLine(l), newValue: null, changeType: 'REMOVED' });
  return out;
}

/** Editor state for an order: latest saved version (or prefilled defaults), contacts to pick from, and all revisions. */
export async function getQuotation(orderId: string, actor: Actor) {
  const { order, client } = await orderWithClient(orderId);
  const revisions = [...((await orderArray(orderId, 'rateCardArray', ['editedBy'])).rateCardArray ?? [])].sort((a, b) => b.revision - a.revision);
  // Every revision carries its display label (v1.0, v1.1...), including the latest one shown in the editor header.
  const labelled = revisions.map((r) => ({ ...r, label: revisionLabel(r.revision) }));
  const latest = labelled[0] ?? null;
  const me = await User.findById(actor.id).select('name email phone').lean();
  const primary = client.contacts?.find((c) => c.isPrimary) ?? client.contacts?.[0];
  const draft = latest
    ? null
    : {
        clientName: client.name,
        clientAddress: addressOf(client),
        contact: primary ? { name: primary.name, designation: primary.designation ?? '', phone: primary.phone ?? '', email: primary.email ?? '' } : { name: '', designation: '', phone: '', email: '' },
        quotationDate: new Date(),
        subject: `Signage Solutions for ${client.name}`,
        items: [],
        terms: DEFAULT_TERMS,
        regards: { name: me?.name ?? '', designation: 'Business Development Manager', mobile: me?.phone ?? '', email: me?.email ?? '' },
      };
  return {
    orderId: String(order._id),
    orderNo: order.orderNo,
    stage: order.stage,
    editable: EDITABLE_STAGES.includes(order.stage) && order.approvalStatus !== 'COMPLETED',
    quotationRef: quotationRefOf(order.orderNo),
    clientName: client.name,
    contacts: client.contacts ?? [],
    latest,
    draft,
    revisions: labelled,
    from: env.MAIL_FROM ?? null,
    mailEnabled: mailAvailable(),
    emailDraft: latest
      ? {
          to: latest.contact?.email ? [latest.contact.email] : [],
          cc: [],
          subject: `Signage Rate Card ${quotationRefOf(order.orderNo)} - ${client.name}`,
          body: `<p>Dear ${latest.contact?.name ?? 'Sir/Madam'},</p><p>Please find attached our signage rate card (${revisionLabel(latest.revision)}) for ${client.name}.</p><p>We look forward to your confirmation. Please feel free to reach out for any clarification.</p><p>Best regards,<br>${latest.regards?.name ?? ''}<br>${latest.regards?.designation ?? ''}<br>ADINN Signage</p>`,
        }
      : null,
  };
}

/**
 * Save Changes: validates, records what changed as a new revision with its own PDF. Master rates are only read
 * (to snapshot the master rate on copied lines); this never writes to the master rate card.
 */
export async function saveQuotation(orderId: string, input: z.infer<typeof quotationBody>, actor: Actor) {
  const { order, client } = await orderWithClient(orderId);
  if (!EDITABLE_STAGES.includes(order.stage)) throw AppError.conflict('The rate card can be edited once the order reaches the Rate Card stage');
  if (order.approvalStatus === 'COMPLETED') throw AppError.conflict('Client approval is complete; the rate card is locked');

  // Copied lines must point at a real master item; the master rate snapshot comes from the request (taken at copy time).
  const ids = input.items.map((i) => i.masterItemId).filter((x): x is string => !!x);
  const masters = await masterRatesById(ids);
  input.items.forEach((l, i) => {
    if (l.masterItemId && !masters.has(l.masterItemId)) throw new AppError(422, 'VALIDATION_ERROR', 'A copied item no longer exists in the master rate card', [{ path: `items.${i}.masterItemId`, message: 'Master item not found' }]);
  });

  const latest = await latestRevision(orderId);
  const next: Snapshot & { items: Line[] } = {
    clientAddress: input.clientAddress ?? null,
    contact: { name: input.contact.name, designation: input.contact.designation ?? null, phone: input.contact.phone ?? null, email: input.contact.email ?? null },
    quotationDate: input.quotationDate,
    subject: input.subject,
    items: input.items.map((l) => ({
      masterItem: l.masterItemId ? new Types.ObjectId(l.masterItemId) : undefined,
      particulars: l.particulars,
      specifications: l.specifications ?? null,
      unit: l.unit,
      masterRate: l.masterItemId ? (l.masterRate ?? null) : null,
      quotedRate: l.quotedRate,
      overrideReason: l.overrideReason ?? null,
    })),
    terms: sanitizeHtml(input.terms),
    regards: input.regards,
  };
  const changes = quotationChanges(latest as Snapshot | null, next);
  if (latest && !changes.length) return { saved: false, revision: { ...latest, label: revisionLabel(latest.revision) } };

  const revision = (latest?.revision ?? 0) + 1;
  const quotationRef = quotationRefOf(order.orderNo);
  const pdf = await renderQuotationPdf({ ...next, quotationRef, revisionLabel: revisionLabel(revision), clientName: client.name });
  const fileName = `${quotationRef.replace(/\//g, '-')}_${revisionLabel(revision)}.pdf`;
  const pdfRef = await storeEmbeddedFile({
    category: 'SALES_RATE_CARD_PDF',
    clientName: client.name,
    folderKey: order.orderNo,
    file: { originalname: fileName, mimetype: 'application/pdf', size: pdf.length, buffer: pdf },
    actor,
    owner: { entity: 'SalesOrder', id: order._id },
  });
  const revisionId = new Types.ObjectId();
  // Appended only if nobody saved a newer revision since we read the latest one.
  const prevNo = latest?.revision ?? 0;
  const r = await SalesOrder.updateOne(
    { _id: order._id, $or: [{ currentRevision: prevNo }, ...(prevNo === 0 ? [{ currentRevision: { $exists: false } }] : [])] },
    {
      $push: {
        rateCardArray: { ...next, _id: revisionId, revision, quotationRef, clientName: client.name, changes, pdf: pdfRef, editedBy: actor.id, createdAt: new Date() },
      },
      $set: { currentRevision: revision, rateCardPdf: pdfRef, updatedBy: actor.id },
    },
  ).catch(async (e: unknown) => {
    await discardStoredFiles([pdfRef]);
    throw e;
  });
  if (!r.modifiedCount) {
    await discardStoredFiles([pdfRef]); // the PDF of a revision that was never saved
    throw AppError.conflict('Someone else saved this rate card at the same time. Reload to see the latest version.');
  }
  await recordAudit({ actor, action: 'RATE_CARD_SAVED', entity: 'SalesOrder', entityId: order._id, reason: `Rate card ${revisionLabel(revision)} saved` });
  const saved = (await orderArray(orderId, 'rateCardArray', ['editedBy'])).rateCardArray?.find((x) => String(x._id) === String(revisionId));
  return { saved: true, revision: { ...saved!, label: revisionLabel(revision) } };
}

