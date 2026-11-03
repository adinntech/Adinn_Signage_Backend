import { Types } from 'mongoose';
import type { z } from 'zod';
import { COMPANY } from '../../config/company';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { htmlToText, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { clientOf } from '../clients/clientDetails';
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

/**
 * Why the rate card cannot be edited now (null = editable). A completed client approval always locks it. An order in
 * Lead Management is edited only in Rate Card Preparation and Negotiation, while the lead is open. A Client Servicing
 * order with the Rate Card step is never locked (updated at any time; each change is a new version).
 */
const lockedReason = (order: { approvalStatus?: string | null; lead?: { stage?: string | null; status?: string | null } | null; recce?: { rateCardRequired?: boolean | null } | null }) => {
  if (order.recce?.rateCardRequired) return null;
  if (order.approvalStatus === 'COMPLETED') return 'Client approval is complete; the rate card is locked';
  const l = order.lead;
  if (!l) return null;
  if (l.status === 'CLOSED') return 'This lead is closed. Reopen it to edit the rate card.';
  if (l.stage !== 'RATE_CARD' && l.stage !== 'NEGOTIATION') return 'The rate card is edited in Rate Card Preparation and Negotiation. Move the lead back to change it.';
  return null;
};
const isEditable = (order: Parameters<typeof lockedReason>[0]) => !lockedReason(order);

/** ADINN's standard rate card terms (one per numbered row in the PDF). */
export const DEFAULT_TERMS = `<ol>${[
  'The Design Should Be Provided By The Client.',
  'Purchase Order (PO) Should Be Issued In The Name Of “ADINN ADVERTISING SERVICES LIMITED”.',
  'Any Specific Clamp Charges Will Be Charged Extra.',
  'Scaffolding Charges, If Required, Will Be Charged Extra.',
  'Rates May Vary Depending On The Quantity And Location.',
]
  .map((t) => `<li>${t}</li>`)
  .join('')}</ol>`;

/** 20261025ORD#1 -> ADINN/QTN/20261025/1, ORD-2026-0001 -> ADINN/QTN/2026/0001 (stable across revisions). */
export const quotationRefOf = (orderNo: string) => {
  const m = /^(\d{8})ORD#(\d+)$/.exec(orderNo) ?? /^ORD-(\d{4})-(\d+)$/.exec(orderNo);
  return m ? `ADINN/QTN/${m[1]}/${m[2]}` : `ADINN/QTN/${orderNo}`;
};

const addressOf = (c: { address?: string | null; city?: string | null; district?: string | null; state?: string | null; pincode?: string | null }) =>
  [c.address, c.city, c.district, c.state].filter(Boolean).join(', ') + (c.pincode ? ` - ${c.pincode}` : '');

/**
 * Full address as Create Project shows the Zoho client: the street, then city / state / PIN when the street does not
 * already contain them (Zoho's street often ends with them), no empty parts.
 */
const fullAddressOf = (c: { address?: string | null; city?: string | null; state?: string | null; pincode?: string | null }) => {
  const street = c.address?.trim() ?? '';
  const rest = [c.city, c.state, c.pincode].map((p) => p?.trim()).filter((p): p is string => !!p && !street.toLowerCase().includes(p.toLowerCase()));
  return [street, ...rest].filter(Boolean).join(', ');
};

async function orderWithClient(orderId: string) {
  const order = await SalesOrder.findOne({ _id: orderId, deletedAt: null }).select(WITHOUT_ARRAYS).lean();
  if (!order) throw AppError.notFound('Order not found');
  // The Client record, or the client kept on the order (Client Servicing).
  const client = await clientOf(order);
  if (!client) throw AppError.notFound('Client not found');
  return { order, client };
}

/** Latest saved revision of an order (last item of rateCardArray; revisions are only ever appended). */
export async function latestRevision(orderId: string | Types.ObjectId) {
  const o = await SalesOrder.findById(orderId).select('currentRevision').slice('rateCardArray', -1).lean();
  return o?.rateCardArray?.[0] ?? null;
}

export type Line = { masterItem?: unknown; particulars: string; specifications?: string | null; unit: string; masterRate?: number | null; quotedRate: number; overrideReason?: string | null };
export type Snapshot = {
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
/** Today in India (Asia/Kolkata) as a date (UTC midnight of that day, as a typed date input is stored). */
export const todayIst = () => new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** One quotation line as readable text, e.g. "LED Glow Sign · Acrylic 3D letters · Sq.ft · Rs. 450". */
const describeLine = (l: Line) =>
  [l.particulars, l.specifications, RATE_UNIT_LABELS[l.unit as keyof typeof RATE_UNIT_LABELS] ?? l.unit, `Rs. ${l.quotedRate}`].filter(Boolean).join(' · ') +
  (l.overrideReason ? ` (reason: ${l.overrideReason})` : '');

/**
 * First save: every filled-in field and item is listed as added, with its value. A line copied from the master rate card
 * whose quoted rate differs from the master rate it was copied at also gets that change (master -> quoted, and the
 * reason), so the first version shows it like later edits do.
 */
function initialChanges(next: Snapshot): Change[] {
  const add = (field: string, v: unknown): Change[] => (n(v) === null ? [] : [{ field, oldValue: null, newValue: n(v), changeType: 'ADDED' }]);
  const fromMaster = (l: Line): Change[] =>
    l.masterItem && l.masterRate != null && l.quotedRate !== l.masterRate
      ? [
          { field: `Quoted Rate (${l.particulars}) vs master`, oldValue: l.masterRate, newValue: l.quotedRate, changeType: 'UPDATED' },
          ...(l.overrideReason ? [{ field: `Override Reason (${l.particulars})`, oldValue: null, newValue: l.overrideReason, changeType: 'ADDED' as const }] : []),
        ]
      : [];
  return [
    ...add('Subject', next.subject),
    ...add('Quotation Date', day(next.quotationDate)),
    ...add('Contact Person', next.contact?.name),
    ...add('Client Address', next.clientAddress),
    ...next.items.flatMap((l): Change[] => [{ field: `Item (${l.particulars})`, oldValue: null, newValue: describeLine(l), changeType: 'ADDED' }, ...fromMaster(l)]),
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
  // Rate Card step (Client Servicing): Bill To is the full address; elsewhere the city, as on the ADINN rate card.
  const fullAddress = fullAddressOf(client);
  const step = !!order.recce?.rateCardRequired;
  const draft = latest
    ? null
    : {
        clientName: client.name,
        // "Bill To" shows the city under the company name, as on the ADINN rate card.
        clientAddress: step ? fullAddress || client.city || '' : client.city || addressOf(client),
        contact: primary ? { name: primary.name, designation: primary.designation ?? '', phone: primary.phone ?? '', email: primary.email ?? '' } : { name: '', designation: '', phone: '', email: '' },
        quotationDate: new Date(),
        subject: 'Signage Rate Card',
        items: [],
        terms: DEFAULT_TERMS,
        regards: { name: me?.name ?? '', designation: 'Business Development Manager', mobile: me?.phone ?? '', email: me?.email ?? '' },
      };
  return {
    orderId: String(order._id),
    orderNo: order.orderNo,
    stage: order.stage,
    editable: isEditable(order),
    lockedReason: lockedReason(order),
    /** Lead stage (RATE_CARD / NEGOTIATION / ...) or null for an order outside Lead Management. */
    leadStage: order.lead?.stage ?? null,
    quotationRef: quotationRefOf(order.orderNo),
    company: COMPANY,
    clientName: client.name,
    /** Rate Card step: the client's full address, and its city (a saved Bill To equal to the city was the old default). */
    billTo: step ? { full: fullAddress || null, city: client.city ?? null } : null,
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
 * The next version of a quotation (an order's rate card, or a Rate Card Creation one) and what changed against
 * `latest`. Master rates are only read (copied lines must still exist); nothing is written to the master rate card.
 * `autoDate`: the date is not typed: today in India for a version with changes, else the saved version's date.
 */
export async function prepareRevision(input: z.infer<typeof quotationBody>, latest: Snapshot | null, autoDate: boolean) {
  // Copied lines must point at a real master item; the master rate snapshot comes from the request (taken at copy time).
  const ids = input.items.map((i) => i.masterItemId).filter((x): x is string => !!x);
  const masters = await masterRatesById(ids);
  input.items.forEach((l, i) => {
    if (l.masterItemId && !masters.has(l.masterItemId)) throw new AppError(422, 'VALIDATION_ERROR', 'A copied item no longer exists in the master rate card', [{ path: `items.${i}.masterItemId`, message: 'Master item not found' }]);
  });

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
  if (autoDate) next.quotationDate = latest?.quotationDate ?? todayIst();
  let changes = quotationChanges(latest, next);
  if (autoDate && changes.length) {
    next.quotationDate = todayIst();
    changes = quotationChanges(latest, next);
  }
  return { next, changes };
}

/**
 * Save Changes: validates, records what changed as a new revision with its own PDF. Master rates are only read
 * (to snapshot the master rate on copied lines); this never writes to the master rate card. `workflowAuthorized`: the
 * caller already checked the actor (Client Servicing Rate Card step), so the PDF is stored without sales:write.
 * `autoDate` (same step): the quotation date is not typed; a new version is dated today in India and a save with no
 * other change keeps the saved version (and its date) as it is.
 */
export async function saveQuotation(orderId: string, input: z.infer<typeof quotationBody>, actor: Actor, opts: { workflowAuthorized?: boolean; autoDate?: boolean } = {}) {
  const { order, client } = await orderWithClient(orderId);
  const locked = lockedReason(order);
  if (locked) throw AppError.conflict(locked);

  const latest = await latestRevision(orderId);
  const { next, changes } = await prepareRevision(input, latest as Snapshot | null, !!opts.autoDate);
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
    workflowAuthorized: !!opts.workflowAuthorized,
  });
  const revisionId = new Types.ObjectId();
  // Appended only if nobody saved a newer revision since we read the latest one.
  const prevNo = latest?.revision ?? 0;
  const r = await SalesOrder.updateOne(
    { _id: order._id, $or: [{ currentRevision: prevNo }, ...(prevNo === 0 ? [{ currentRevision: { $exists: false } }] : [])] },
    {
      $push: {
        rateCardArray: {
          ...next,
          _id: revisionId,
          revision,
          quotationRef,
          clientName: client.name,
          changes,
          pdf: pdfRef,
          phase: order.lead?.stage === 'NEGOTIATION' ? 'NEGOTIATION' : 'PREPARATION',
          editedBy: actor.id,
          createdAt: new Date(),
        },
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

