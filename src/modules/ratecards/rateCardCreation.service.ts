import { Types } from 'mongoose';
import type { z } from 'zod';
import { COMPANY } from '../../config/company';
import { nextSeq } from '../../common/counter.model';
import { AppError } from '../../common/errors';
import { escapeRegex, pageMeta, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { clientDetailsFromZoho, latestClient, type ClientDetails } from '../clients/clientDetails';
import { discardStoredFiles, storeEmbeddedFile, storedFileUrl } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { User } from '../users/user.model';
import { getZohoClient } from '../zoho/zoho.customers';
import { renderQuotationPdf } from './quotation.pdf';
import { DEFAULT_TERMS, prepareRevision, todayIst, type Snapshot } from './quotation.service';
import { revisionLabel } from './ratecard.model';
import { StandaloneRateCard } from './rateCardCreation.model';
import type { rateCardCreationBody, rateCardCreationListQuery } from './ratecard.validators';

/** Client Servicing sees the rate cards they created; Super Admin sees all. */
const scope = (actor: Actor): Record<string, unknown> => (actor.role === 'SUPER_ADMIN' ? {} : { createdBy: actor.id });

const nextRef = async () => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replaceAll('-', '');
  return `ADINN/RC/${day}/${await nextSeq(`rateCard:${day}`)}`;
};

type Card = { _id: Types.ObjectId; quotationRef: string; clientDetails?: unknown; rateCardArray?: unknown[]; currentRevision?: number | null };
const clientOfCard = (c: { clientDetails?: unknown }) => latestClient(c.clientDetails as ClientDetails[] | null | undefined);

export async function listRateCards(q: z.infer<typeof rateCardCreationListQuery>, actor: Actor) {
  const filter: Record<string, unknown> = { deletedAt: null, ...scope(actor) };
  if (q.q) {
    const re = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ quotationRef: re }, { 'clientDetails.name': re }, { 'clientDetails.zohoCustomerNo': re }, { 'clientDetails.gstin': re }];
  }
  const [rows, total] = await Promise.all([
    StandaloneRateCard.find(filter)
      .select('quotationRef clientDetails currentRevision createdBy updatedAt createdAt')
      .populate<{ createdBy: { name?: string } | null }>('createdBy', 'name')
      .sort({ updatedAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    StandaloneRateCard.countDocuments(filter),
  ]);
  const items = rows.map((r) => {
    const c = clientOfCard(r);
    return {
      _id: String(r._id),
      quotationRef: r.quotationRef,
      client: c ? { name: c.name, zohoCustomerNo: c.zohoCustomerNo ?? null } : null,
      label: r.currentRevision ? revisionLabel(r.currentRevision) : null,
      createdBy: r.createdBy?.name ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
  return { items, meta: pageMeta(q.page, q.limit, total) };
}

/** The editor state (same shape as an order's rate card), for a saved rate card or a new one (`card` null). */
async function editorState(card: Card | null, actor: Actor) {
  const revisions = [...((card?.rateCardArray ?? []) as { revision: number }[])].sort((a, b) => b.revision - a.revision).map((r) => ({ ...r, label: revisionLabel(r.revision) }));
  const latest = revisions[0] ?? null;
  const c = card ? clientOfCard(card) : null;
  const me = latest ? null : await User.findById(actor.id).select('name email phone').lean();
  return {
    orderId: card ? String(card._id) : '',
    orderNo: card?.quotationRef ?? 'New rate card',
    stage: 'RATE_CARD_CREATION',
    editable: true,
    lockedReason: null,
    leadStage: null,
    quotationRef: card?.quotationRef ?? 'Assigned on first save',
    company: COMPANY,
    clientName: c?.name ?? '',
    /** The selected Zoho client (Client Company (Zoho)). */
    client: c ? { zohoId: c.zohoId, name: c.name } : null,
    billTo: null,
    contacts: [],
    latest,
    draft: latest
      ? null
      : {
          clientName: '',
          clientAddress: '',
          contact: { name: '', designation: '', phone: '', email: '' },
          quotationDate: todayIst(),
          subject: 'Signage Rate Card',
          items: [],
          terms: DEFAULT_TERMS,
          regards: { name: me?.name ?? '', designation: 'Business Development Manager', mobile: me?.phone ?? '', email: me?.email ?? '' },
        },
    revisions,
    from: null,
    mailEnabled: false,
    emailDraft: null,
  };
}

async function liveCard(id: string, actor: Actor) {
  const card = await StandaloneRateCard.findOne({ _id: id, deletedAt: null, ...scope(actor) }).populate('rateCardArray.editedBy', 'name role').lean();
  if (!card) throw AppError.notFound('Rate card not found');
  return card;
}

export const newRateCard = (actor: Actor) => editorState(null, actor);
export const getRateCard = async (id: string, actor: Actor) => editorState((await liveCard(id, actor)) as unknown as Card, actor);

/**
 * Save: a new rate card (id null) or a new version of one. The quotation is validated and versioned like an order's
 * rate card (prepareRevision: master rates only read, override reasons, date = today in India for a changed version)
 * and every version gets its own PDF. The Zoho client is read fresh when it is chosen or changed.
 */
export async function saveRateCard(id: string | null, input: z.infer<typeof rateCardCreationBody>, actor: Actor) {
  const { zohoId, requestKey, ...body } = input;
  const card = id ? await StandaloneRateCard.findOne({ _id: id, deletedAt: null, ...scope(actor) }) : null;
  if (id && !card) throw AppError.notFound('Rate card not found');
  if (!card && requestKey) {
    const again = await StandaloneRateCard.findOne({ requestKey, ...scope(actor) }).select('_id rateCardArray').lean();
    if (again) {
      const last = again.rateCardArray.at(-1)!;
      return { saved: false, id: String(again._id), revision: { ...last, label: revisionLabel(last.revision) } };
    }
  }

  const current = card ? clientOfCard(card.toObject()) : null;
  let details: ClientDetails | null = null;
  if (!current || current.zohoId !== zohoId) {
    const z = await getZohoClient(zohoId);
    if (!z) throw new AppError(422, 'VALIDATION_ERROR', 'This customer is no longer in Zoho. Choose the client company again.', [{ path: 'zohoId', message: 'Not found in Zoho' }]);
    details = clientDetailsFromZoho(z, actor.id);
  }
  const clientName = (details ?? current)!.name;

  const latestDoc = card?.rateCardArray.at(-1) ?? null;
  const latest = (latestDoc ? latestDoc.toObject() : null) as (Snapshot & { revision: number }) | null;
  const { next, changes } = await prepareRevision(body, latest, true);
  if (details && current) changes.unshift({ field: 'Company', oldValue: current.name, newValue: details.name, changeType: 'UPDATED' });
  if (latest && !changes.length) return { saved: false, id: String(card!._id), revision: { ...latest, label: revisionLabel(latest.revision) } };

  const cardId = card?._id ?? new Types.ObjectId();
  const revision = (latest?.revision ?? 0) + 1;
  const quotationRef = card?.quotationRef ?? (await nextRef());
  const pdf = await renderQuotationPdf({ ...next, quotationRef, revisionLabel: revisionLabel(revision), clientName });
  const fileName = `${quotationRef.replace(/\//g, '-')}_${revisionLabel(revision)}.pdf`;
  // The route already checked the permission (Rate Card Creation), so the PDF is stored without sales:write.
  const pdfRef: StoredFile = await storeEmbeddedFile({
    category: 'SALES_RATE_CARD_PDF',
    clientName,
    folderKey: quotationRef.replace(/\//g, '-'),
    file: { originalname: fileName, mimetype: 'application/pdf', size: pdf.length, buffer: pdf },
    actor,
    owner: { entity: 'StandaloneRateCard', id: cardId },
    workflowAuthorized: true,
  });
  const entry = { ...next, _id: new Types.ObjectId(), revision, quotationRef, clientName, changes, pdf: pdfRef, phase: 'PREPARATION', editedBy: new Types.ObjectId(actor.id), createdAt: new Date() };
  try {
    if (!card) {
      await StandaloneRateCard.create({ _id: cardId, quotationRef, clientDetails: [details!], rateCardArray: [entry], currentRevision: revision, requestKey, createdBy: actor.id, updatedBy: actor.id });
    } else {
      // Appended only if nobody saved a newer version since it was read.
      const r = await StandaloneRateCard.updateOne(
        { _id: cardId, currentRevision: latest?.revision ?? 0 },
        { $push: { rateCardArray: entry, ...(details ? { clientDetails: details } : {}) }, $set: { currentRevision: revision, updatedBy: actor.id } },
      );
      if (!r.modifiedCount) throw AppError.conflict('Someone else saved this rate card at the same time. Reload to see the latest version.');
    }
  } catch (e) {
    await discardStoredFiles([pdfRef]); // the PDF of a version that was never saved
    if ((e as { code?: number }).code === 11000 && requestKey && !card) return saveRateCard(null, input, actor);
    throw e;
  }
  await recordAudit({ actor, action: 'RATE_CARD_SAVED', entity: 'StandaloneRateCard', entityId: cardId, reason: `Rate card ${quotationRef} ${revisionLabel(revision)} saved` });
  return { saved: true, id: String(cardId), revision: { ...entry, label: revisionLabel(revision) } };
}

/** Short-lived link to one of the rate card's version PDFs. */
export async function rateCardFileUrl(id: string, fileId: string, actor: Actor) {
  const card = await StandaloneRateCard.findOne({ _id: id, deletedAt: null, ...scope(actor) }).select('rateCardArray.pdf').lean();
  if (!card) throw AppError.notFound('Rate card not found');
  const file = card.rateCardArray.map((r) => r.pdf).find((f) => f && String(f.fileId) === fileId);
  if (!file) throw AppError.notFound('File not found');
  return storedFileUrl(file as StoredFile);
}
