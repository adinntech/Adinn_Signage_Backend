import { Types } from 'mongoose';
import type { z } from 'zod';
import { COMPANY } from '../../config/company';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { escapeHtml, sanitizeHtml } from '../../common/html';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { clientOf, latestDetails } from '../clients/clientDetails';
import { CommunicationMessage } from '../communications/communication.model';
import { discardStoredFiles, storeEmbeddedFile, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { Project, Requirement } from '../projects/project.model';
import { assignProject, createProject } from '../projects/project.service';
import { projectCreate } from '../projects/project.validators';
import { latestRevision, saveQuotation } from '../ratecards/quotation.service';
import { revisionLabel } from '../ratecards/ratecard.model';
import type { quotationBody } from '../ratecards/ratecard.validators';
import { User } from '../users/user.model';
import { getZohoClient } from '../zoho/zoho.customers';
import { belongsTo, getZohoEstimate, listClientEstimates, type EstimateOwner } from '../zoho/zoho.estimates';
import { claimRoute, clientSnapshot, contactPersonsOf, exportShops, HANDOVER_TYPE_LABELS, handoverGaps, isCs, routeOf } from './handover.service';
import { leadLog, liveOrder, pipelineLog } from './order.service';
import { SalesOrder, type HandoverType } from './sales.model';
import { deliver, listEmails } from './salesMail.service';
import type { recceAssignBody, recceCodesBody, sendEmailBody } from './sales.validators';
import { safeNames, signageMailAvailable } from './signageMail';

/** Recce / Operations people a project can be assigned to (same rule as the projects module). */
export const recceUsers = () =>
  User.find({ role: { $in: ['OPERATIONS', 'RECCE_COORDINATOR'] }, isActive: true, deletedAt: null }).select('name email phone role').sort({ name: 1 }).lean();

const ownerOf = (id: Types.ObjectId) => ({ entity: 'SalesOrder' as const, id });

type OrderDoc = Awaited<ReturnType<typeof liveOrder>>;

/**
 * Client Servicing workflow: the Client Servicing person an order was handed to continues it with the same Recce steps
 * (request email, codes, Recce / Operations person). Their own progress lives in `recce`; the BD's handover, its
 * route and the completed lead stay as they are.
 */
const csMine = (o: { csAssignee?: unknown }, actor: Actor) => isCs(actor) && !!o.csAssignee && String(o.csAssignee) === actor.id;
/** "Send handover details" was on at assignment: the BD's handover details are used as they are (no step 1). */
const handoverReceived = (o: { handoverFull?: boolean | null }) => o.handoverFull !== false;
/** Update filter: the branch is still open for this actor. */
const branchFilter = (o: OrderDoc, actor: Actor): Record<string, unknown> =>
  csMine(o, actor) ? { _id: o._id, csAssignee: o.csAssignee, 'recce.assignee': null } : { _id: o._id, csAssignee: null, 'recce.assignee': null };
/** The BD's first save takes the Recce route; Client Servicing works after the BD's (Client Servicing) route. */
const claimRecce = (o: OrderDoc, actor: Actor) => (csMine(o, actor) ? Promise.resolve() : claimRoute(o, 'RECCE'));

/** Client Servicing may list Recce / Operations people only while one of their orders is still to be assigned. */
export async function assertCsHasOpenFlow(actor: Actor) {
  const mine = [{ csAssignee: actor.id }, { createdBy: actor.id, csAssignee: null }];
  if (!(await SalesOrder.exists({ $or: mine, 'recce.assignee': null, deletedAt: null }))) throw AppError.forbidden();
}

/** The Recce branch can be worked on only while the lead is open at Project Assign and nobody has the project yet. */
function assertBranchOpen(o: OrderDoc, actor: Actor) {
  // Client Servicing on a lead they created (active flow): the BD's Recce route rules below.
  if (isCs(actor) && !csMine(o, actor) && String(o.createdBy) !== actor.id) throw AppError.notFound('Order not found');
  if (csMine(o, actor)) {
    // Assigned to this Client Servicing person (handed over by the BD).
    if (o.recce?.assignee) throw AppError.conflict('This project is already assigned to the Recce team.');
    return;
  }
  if (o.csAssignee) throw AppError.conflict('This project is already assigned to Client Servicing.');
  if (o.recce?.assignee) throw AppError.conflict('This project is already assigned to the Recce team.');
  if (!(o.lead?.status === 'OPEN' && o.lead.stage === 'PROJECT_ASSIGN')) throw AppError.conflict('Assign the Recce team from the Project Assign stage in Lead Management.');
}

const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);

/**
 * Step 1 of the Recce route is done once a project code request email is recorded as sent, or as not sent only because
 * email is not configured on the server (SKIPPED). A failed send does not count.
 */
const EMAIL_DONE = ['SENT', 'SKIPPED'];
const emailDone = (orderId: Types.ObjectId) => SalesOrder.exists({ _id: orderId, salesprofile: { $elemMatch: { kind: 'PROJECT_CODE_REQUEST', status: { $in: EMAIL_DONE } } } });

/**
 * Client ID in Zoho for this client: saved on the client, else (Existing / Zoho clients) read from Zoho once and kept.
 * Null when it is not known (New clients until it is typed at Project Code; Zoho unreachable).
 */
async function zohoClientIdOf(c: { _id: unknown; zohoCustomerNo?: string | null; zohoId?: string | null; zohoContactId?: string | null; source?: string | null; code?: string | null } | null) {
  if (!c) return null;
  if (c.zohoCustomerNo) return c.zohoCustomerNo;
  // zohoId (Existing Client picker) or zohoContactId (Admin > Zoho Import): the same Zoho contact id.
  const zid = c.zohoId ?? c.zohoContactId;
  if (!zid) return null;
  const z = await getZohoClient(zid).catch(() => null);
  const no = z?.zohoCustomerNo ?? (c.source === 'ZOHO' && c.code && /^\d{2,8}$/.test(c.code) ? c.code : null);
  // Only a Client record keeps it; a client array (Client Servicing order) is never written to the clients collection.
  if (no && c._id) await Client.updateOne({ _id: c._id, $or: [{ zohoCustomerNo: null }, { zohoCustomerNo: '' }] } as Record<string, unknown>, { $set: { zohoCustomerNo: no } });
  return no;
}

/** Documents shared in the handover's Communication (not voice notes): they go with the project code request email. */
const chatDocuments = (o: { handoverMessagesArray?: { attachments?: unknown[] }[] | null }) =>
  ((o.handoverMessagesArray ?? []).flatMap((m) => (m.attachments ?? []) as StoredFile[])).filter((f, i, all) => all.findIndex((x) => String(x.fileId) === String(f.fileId)) === i);
/** SO only: the Additional Documents (not sent for the other types, though they stay saved). */
const soDocuments = (o: { handoverType?: string | null; handoverDocumentsArray?: { kind?: string | null; file?: unknown }[] | null }) =>
  o.handoverType === 'ASO' ? (o.handoverDocumentsArray ?? []).filter((d) => d.kind === 'SO_DOCUMENT').map((d) => d.file as StoredFile) : [];
const shopTypesList: readonly string[] = ['SHOP_DETAILS', 'SHOP_MEASUREMENT'];
/** New Client only (the branch saved on the order): the GST certificates go with the request, for creating the client ID. */
const newClientCertificates = (clientType: string | null | undefined, c: { gstCertificates?: unknown[] | null } | null) =>
  clientType === 'EXISTING' ? [] : ((c?.gstCertificates ?? []) as StoredFile[]);
/** One copy of each file. */
const uniqueFiles = (files: StoredFile[]) => files.filter((f, i, all) => all.findIndex((x) => String(x.fileId) === String(f.fileId)) === i);

type RateCardFlow = { rateCardRequired?: boolean | null; rateCardDoneAt?: Date | null; rateCardChoice?: string | null; rateCardRevision?: number | null } | null | undefined;
/** Rate Card step's choice: INCLUDED / SKIPPED, null until made. Orders done before the choice existed count as included. */
const rateCardChoiceOf = (r: RateCardFlow) => (r?.rateCardChoice as 'INCLUDED' | 'SKIPPED' | null | undefined) ?? (r?.rateCardDoneAt ? 'INCLUDED' : null);

/**
 * The saved rate card version that goes with the project code request email: only one explicitly included in this
 * flow (Save & Continue), never one that was skipped (its versions stay saved), never unsaved edits. Orders done before
 * the choice existed: their latest saved version, as before.
 */
async function includedRateCard(orderId: Types.ObjectId, r: RateCardFlow) {
  if (!r?.rateCardRequired || rateCardChoiceOf(r) !== 'INCLUDED') return null;
  if (!r.rateCardRevision) return latestRevision(orderId);
  const o = await SalesOrder.findOne({ _id: orderId }, { rateCardArray: { $elemMatch: { revision: r.rateCardRevision } } }).lean();
  return o?.rateCardArray?.[0] ?? null;
}

/** Recce branch for one order: codes, project code request emails, what is still missing, and the assignment. */
export async function getRecce(id: string, actor: Actor) {
  const o = await SalesOrder.findOne({ _id: id, deletedAt: null })
    .select('orderNo client clientDetails clientType lead recce csAssignee assignRoute handoverFull handoverType handoverUpdatedAt soContacts orderContacts shopList declaredShopTotal handoverMessagesArray.attachments handoverDocumentsArray salesprofile.kind salesprofile.status salesprofile.sentAt')
    .populate('recce.assignee', 'name email phone role')
    .populate('recce.assignedBy', 'name')
    .populate('recce.codesSavedBy', 'name')
    .populate('recce.project', 'code status')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  // The Client record, or the client kept on the order (Client Servicing).
  const client = await clientOf(o);
  const r = o.recce ?? null;
  const requests = (o.salesprofile ?? []).filter((e) => e.kind === 'PROJECT_CODE_REQUEST').sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
  const codes = r?.projectCode
    ? { projectCode: r.projectCode, estimationCode: r.estimationCode ?? '', clientId: r.clientId ?? null, savedAt: r.codesSavedAt ?? null, savedBy: (r.codesSavedBy as unknown as { name?: string } | null)?.name ?? null }
    : null;
  const existing = o.clientType === 'EXISTING';
  const zohoNo = existing ? await zohoClientIdOf(client) : (client?.zohoCustomerNo ?? null);
  // The client's contact persons, or this order's own when the Zoho client has none.
  const contacts = contactPersonsOf(client, o);
  // The Recce team always gets the full handover (there is no "client details only" option here).
  const handoverMissing = handoverGaps({ ...o, handoverFull: true });
  const sentOk = requests.some((e) => EMAIL_DONE.includes(e.status));
  // Step 1 is done when the BD confirmed it ("Continue"); orders from before the confirmation count once an email went.
  const cs = csMine(o, actor);
  // Client Servicing with the handover details received from the BD: there is no step 1 to confirm.
  const handoverDone = !!r?.handoverDoneAt || sentOk || (cs && handoverReceived(o));
  // Rate Card step (Client Servicing orders created with it): the latest saved version and its PDF.
  const rateCardRequired = !!r?.rateCardRequired;
  const rc = rateCardRequired ? await latestRevision(o._id) : null;
  const rateCardChoice = rateCardRequired ? rateCardChoiceOf(r) : null;
  // Only the version included in this flow goes with the email (none when skipped).
  const inc = await includedRateCard(o._id, r);
  const rcPdf = (inc?.pdf ?? null) as StoredFile | null;
  // Steps in order: handover details, the request email, the codes (+ Client ID for a New client), then the assignment.
  const missing = r?.assignee
    ? []
    : [
        ...handoverMissing,
        ...(handoverDone ? [] : ['Confirm Assign Type & Details (Continue)']),
        ...(rateCardRequired && !r?.rateCardDoneAt ? ['Save the Rate Card (Save & Continue) or skip it'] : []),
        ...(sentOk ? [] : ['Send the project code request email']),
        ...(codes ? [] : ['Enter the project code and estimation code']),
        ...(codes && !existing && !codes.clientId ? ['Enter the Client ID created in Zoho'] : []),
      ];
  const shopRows = o.handoverType && shopTypesList.includes(o.handoverType) ? (o.shopList?.total ?? 0) : 0;
  // Chat files and (SO) Additional Documents, one copy of each.
  const soDocs = soDocuments(o);
  const docs = uniqueFiles([...chatDocuments(o), ...soDocs]);
  const certs = newClientCertificates(o.clientType, client);
  // New Client only: custom fields go in the message (with the certificate) for the client ID creation.
  const custom = existing ? [] : (client?.customFields ?? []).filter((f) => f.label && f.value);
  const bd = await User.findById(actor.id).select('name').lean();
  // Active Client Servicing flow: their clients are all Zoho clients, shown as "Client" (no Existing / New flag).
  const csWording = isCs(actor) && existing;
  const typeLabel = o.handoverType ? HANDOVER_TYPE_LABELS[o.handoverType as HandoverType] : 'To be confirmed';
  const shops = shopRows ? `${shopRows} shop${shopRows === 1 ? '' : 's'}${o.handoverType === 'SHOP_MEASUREMENT' ? ' (with sizes)' : ''}` : o.handoverType === 'ASO' ? 'Shop details to be collected' : null;
  // Email body: plain headings, paragraphs and label / value tables (no attributes); the send adds the email styling.
  const esc = (v: string) => escapeHtml(v);
  const filled = (v: string | null | undefined): v is string => !!v && !!String(v).trim();
  /** Label / value rows; empty values are left out (no table when none is left). */
  const rows = (list: [string, string | null | undefined][]) => {
    const kept = list.filter((x): x is [string, string] => filled(x[1]));
    return kept.length ? `<table><tbody>${kept.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : '';
  };
  /** One row per person; a column nobody has a value for is left out. */
  const grid = <T,>(list: T[], cols: [string, (x: T) => string | null | undefined][]) => {
    const used = cols.filter(([, f]) => list.some((x) => filled(f(x))));
    if (!list.length || !used.length) return '';
    const head = `<tr>${used.map(([h]) => `<th>${esc(h)}</th>`).join('')}</tr>`;
    const body = list.map((x) => `<tr>${used.map(([, f]) => `<td>${filled(f(x)) ? esc(f(x)!) : '—'}</td>`).join('')}</tr>`).join('');
    return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  };
  const section = (title: string, inner: string) => (inner ? `<h3>${esc(title)}</h3>${inner}` : '');
  const mobile = (p?: string | null) => (p ? `+91 ${p}` : null);
  // Full address: the street, then city / state / PIN when the street does not already contain them.
  const street = client?.address?.trim() ?? '';
  const address = [street, ...[client?.city, client?.state, client?.pincode].map((p) => p?.trim()).filter((p): p is string => !!p && !street.toLowerCase().includes(p.toLowerCase()))]
    .filter(Boolean)
    .join(', ');
  // Attachments as the API names them (same order as the send: rate card, shop Excel, documents, GST certificates).
  const shopExcel = shopRows ? { name: `${o.orderNo.replace(/[^\w-]+/g, '_')}_shop_list.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } : null;
  const files = [
    ...(rcPdf ? [{ file: rcPdf, note: `Rate Card ${revisionLabel(inc!.revision)}` }] : []),
    ...(shopExcel ? [{ file: shopExcel, note: `Shop list, ${shops}` }] : []),
    ...docs.map((f) => ({ file: f, note: soDocs.some((x) => String(x.fileId) === String(f.fileId)) ? 'SO document' : null })),
    ...certs.map((f) => ({ file: f, note: 'GST certificate' })),
  ];
  const fileNames = safeNames(files.map((x) => x.file));
  const team = isCs(actor) ? 'Client Servicing Team' : 'Business Development Team';
  return {
    orderId: String(o._id),
    orderNo: o.orderNo,
    unlocked: cs ? !r?.assignee : o.lead?.status === 'OPEN' && o.lead.stage === 'PROJECT_ASSIGN' && !o.csAssignee,
    /** Client Servicing workflow on an order handed to this person: `handoverSent` = the BD sent the handover details (no step 1). */
    csFlow: cs ? { handoverSent: handoverReceived(o) } : null,
    handoverType: (o.handoverType ?? null) as HandoverType | null,
    /** Last save of any handover detail (the Handover Type & Details card). */
    handoverUpdatedAt: o.handoverUpdatedAt ?? null,
    /** Gaps of the full handover (step 1). */
    handoverMissing,
    codes,
    requests: { count: requests.length, lastSentAt: requests[0]?.sentAt ?? null, lastStatus: requests[0]?.status ?? null },
    /** Email step done: an email recorded as sent (or not sent only because mail is off). Unlocks the codes. */
    emailDone: sentOk,
    /** Handover Type & Details (step 1) complete: unlocks the request email. */
    handoverReady: handoverMissing.length === 0,
    /** Handover Type & Details confirmed with "Continue" (unlocks the request email). */
    handoverDone,
    /**
     * Rate Card step (null for orders created before it): done with Save & Continue (INCLUDED) or Skip (SKIPPED);
     * editable at any time. `includedLabel`: the version that goes with the request email.
     */
    rateCard: rateCardRequired
      ? {
          doneAt: r?.rateCardDoneAt ?? null,
          choice: rateCardChoice,
          includedLabel: inc ? revisionLabel(inc.revision) : null,
          label: rc ? revisionLabel(rc.revision) : null,
          updatedAt: rc?.createdAt ?? null,
          items: rc?.items?.length ?? 0,
        }
      : null,
    clientType: o.clientType,
    /** Client ID in Zoho: Existing clients have it from Zoho (read-only); New clients type it at Project Code. */
    zohoClientId: { value: codes?.clientId ?? zohoNo, fromZoho: existing },
    /** Sent automatically with every request email (besides the client details and contacts in the message). */
    autoAttachments: {
      shopExcel: shopRows ? { rows: shopRows, sized: o.handoverType === 'SHOP_MEASUREMENT' } : null,
      /** Rate Card step: the PDF of the version included in this flow (none when the rate card was skipped). */
      rateCard: rcPdf ? { fileId: String(rcPdf.fileId), name: rcPdf.name, size: rcPdf.size, mimeType: rcPdf.mimeType, label: revisionLabel(inc!.revision) } : null,
      documents: docs.map((f) => ({ fileId: String(f.fileId), name: f.name, size: f.size, mimeType: f.mimeType, so: soDocs.some((x) => String(x.fileId) === String(f.fileId)) })),
      /** New Client only: the client's GST certificates (they support the client ID creation). */
      gstCertificates: certs.map((f) => ({ fileId: String(f.fileId), name: f.name, size: f.size, mimeType: f.mimeType })),
    },
    /** Project Assign route: HANDOVER (Client Servicing), RECCE, or null until the first save. */
    route: await routeOf({ _id: o._id, assignRoute: o.assignRoute, csAssignee: o.csAssignee, recce: o.recce }),
    /** Contacts that can go on the operations project (name, mobile and email all present). */
    projectContacts: contacts.filter((k) => k.phone && k.email).length,
    assignee: r?.assignee ?? null,
    assignedAt: r?.assignedAt ?? null,
    assignedBy: (r?.assignedBy as unknown as { name?: string } | null)?.name ?? null,
    note: r?.note ?? null,
    project: r?.project ?? null,
    missing,
    // Sent through the signage email API (its URL and key on the server), not SMTP.
    mail: { enabled: signageMailAvailable(), from: env.MAIL_FROM ?? null },
    draft: {
      to: [] as string[],
      cc: [] as string[],
      // New client: its CRM Client ID is only a local reference, so the client code is requested with the project code.
      subject: existing ? `Project Code Request - ${client?.name ?? 'Client'} (${o.orderNo})` : `Client Code & Project Code Request - ${client?.name ?? 'Client'} (${o.orderNo})`,
      // Heading, greeting and request, client details, project details, contacts (SO contacts for SO), attachments,
      // closing and sign-off. Empty sections and fields are left out.
      body:
        `<h2>${existing ? 'Project &amp; Estimation Code Request' : 'Client ID, Project &amp; Estimation Code Request'}</h2>` +
        `<p>Dear Team,</p>` +
        (existing
          ? `<p>Kindly create the project code and estimation code for the following order under ${csWording ? '' : 'the existing '}Client ID <strong>${escapeHtml(zohoNo ?? '-')}</strong>.</p>`
          : `<p>This is a new client. Kindly create the <strong>client ID in Zoho</strong> for this client, and the <strong>project code and estimation code</strong> for the order below. The GST certificate and the client's details are included for the client ID.</p>`) +
        section(
          'Client Details',
          rows([
            ['Company Name', client?.name],
            // Existing: the Client ID is Zoho's customer number. New: requested here; the CRM number is only a temporary reference.
            ...(existing ? [['Client ID', zohoNo] as [string, string | null | undefined]] : [['Client ID', 'To be created in Zoho'] as [string, string], ['CRM Reference (temporary)', client?.clientNo] as [string, string | null | undefined]]),
            ...(csWording ? [] : [['Client Flag', existing ? 'Existing Client' : 'New Client'] as [string, string]]),
            ['Email', client?.email],
            ['Phone', client?.phone],
            ['GST Number', client?.gstin],
            ['Address', address],
            ...custom.map((f) => [f.label!, f.value!] as [string, string]),
          ]),
        ) +
        section('Project Details', rows([['Order Number', o.orderNo], ['Assign Type', typeLabel], ['Shops', shops]])) +
        section(
          'Contact Persons',
          grid(contacts, [
            ['Name', (k) => k.name],
            ['Designation', (k) => k.designation],
            ['Mobile', (k) => mobile(k.phone)],
            ['Email', (k) => k.email],
            ['Primary', (k) => (k.isPrimary ? 'Primary' : null)],
          ]),
        ) +
        (o.handoverType === 'ASO'
          ? section(
              'SO Contacts',
              grid(o.soContacts ?? [], [
                ['Name', (k) => k.name],
                ['Mobile', (k) => mobile(k.phone)],
                ['Email', (k) => k.email],
                ['Primary', (k) => (k.isPrimary ? 'Primary' : null)],
              ]),
            )
          : '') +
        section('Attachments', files.length ? `<ul>${files.map((x, i) => `<li>${esc(fileNames[i]!)}${x.note ? ` (${esc(x.note)})` : ''}</li>`).join('')}</ul>` : '') +
        `<p>Kindly share the generated codes to proceed with the Recce/Operations assignment.</p>` +
        `<p>Regards,<br><strong>${esc(bd?.name ?? team)}</strong><br>${team}<br>${esc(COMPANY.name)}</p>`,
    },
  };
}

/** Project code request email: To / CC / subject / message with optional attachments, recorded in the email history. */
/** Project code and estimation code saved: the request email can no longer be sent or resent. */
export const codesSavedError = () =>
  new AppError(409, 'CODES_SAVED', 'The project code and estimation code are saved: the request email can no longer be sent. Email History keeps what was sent.', [{ path: 'email', message: 'Codes already saved' }]);

export async function sendCodeRequest(id: string, input: z.infer<typeof sendEmailBody>, files: UploadedFile[], actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o, actor);
  // Same request sent twice (double click / retry): hand back the first one without storing the files again.
  if (input.requestKey) {
    const again = (await listEmails(id, 'PROJECT_CODE_REQUEST')).find((e) => e.requestKey === input.requestKey);
    if (again) return again;
  }
  // Codes saved: the request email is preview-only (no new send).
  if (o.recce?.codesSavedAt || o.recce?.projectCode) throw codesSavedError();
  // Steps in order: the handover details come first (the email carries them).
  const client = await clientOf(o);
  const gaps = handoverGaps({ ...o.toObject(), handoverFull: true });
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', `Complete Assign Type & Details first: ${gaps[0]}`, gaps.map((message) => ({ path: 'handover', message })));
  if (!o.recce?.handoverDoneAt && !(csMine(o, actor) && handoverReceived(o)) && !(await emailDone(o._id))) throw new AppError(422, 'HANDOVER_INCOMPLETE', 'Confirm Assign Type & Details first (Continue: Project Code Request Email).', [{ path: 'handover', message: 'Confirm Assign Type & Details first' }]);
  // Orders with the Rate Card step: the rate card is saved (Save & Continue) or skipped first. Only the version included
  // in this flow goes with the email; a skipped rate card never does, even when a version is saved.
  if (o.recce?.rateCardRequired && !o.recce.rateCardDoneAt) throw new AppError(422, 'RATE_CARD_INCOMPLETE', 'Save the Rate Card (Save & Continue) or skip it first.', [{ path: 'rateCard', message: 'Save or skip the Rate Card first' }]);
  const included = await includedRateCard(o._id, o.recce);
  const rateCardPdf = (included?.pdf ?? undefined) as StoredFile | undefined;
  // Signage email API: the company name and its business Client ID in Zoho (e.g. 30196), not the CRM CLI- number.
  const clientCode = o.recce?.clientId ?? (o.clientType === 'EXISTING' ? await zohoClientIdOf(client) : client?.zohoCustomerNo) ?? '';
  // The first email takes the Recce route (the Client Servicing route is then disabled).
  await claimRecce(o, actor);
  const stored: StoredFile[] = [];
  // Signage email API: where each file comes from (first source wins, like the de-duplication below).
  const docTypes: Record<string, string> = {};
  const tag = <T extends { fileId?: unknown }>(list: T[], type: string) => {
    for (const f of list) if (f.fileId) docTypes[String(f.fileId)] ??= type;
    return list;
  };
  // Assigned Client Servicing (checked by assertBranchOpen): the shop Excel and their added files are stored for the email.
  const store = (f: UploadedFile) => storeEmbeddedFile({ category: 'SALES_HANDOVER_DOCUMENT', clientName: client?.name ?? 'Client', folderKey: o.orderNo, file: f, actor, owner: ownerOf(o._id), workflowAuthorized: isCs(actor) });
  try {
    // Shop types: the shop table as it is now, as Excel (with sizes for Shop + Measurement).
    if (o.handoverType && shopTypesList.includes(o.handoverType) && o.shopList?.total) {
      const x = await exportShops(id);
      stored.push(...tag([await store({ originalname: x.name, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: x.buffer.length, buffer: x.buffer })], 'shoplist'));
    }
    for (const f of files) stored.push(...tag([await store(f)], 'upload'));
    // Documents shared in the handover Communication go as they are (no copy).
    // + New Client only: the client's GST certificates (as they are, no copy). One copy of each file.
    const attachments = uniqueFiles([
      ...tag(rateCardPdf ? [rateCardPdf] : [], 'ratecard'),
      ...stored,
      ...tag(chatDocuments(o.toObject()), 'communication'),
      ...tag(soDocuments(o.toObject()), 'so'),
      ...tag(newClientCertificates(o.clientType, client), 'gst'),
    ]);
    const sent = await deliver({
      order: o._id,
      client: o.client,
      kind: 'PROJECT_CODE_REQUEST',
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: sanitizeHtml(input.body),
      attachments,
      rateCardRevision: included?.revision ?? undefined,
      requestKey: input.requestKey,
      signage: { source: isCs(actor) ? 'Client Servicing Team' : 'Business Development Team', client: { clientName: client?.name ?? '', clientCode }, docTypes },
      actor,
    });
    const status = (sent as { status?: string }).status ?? 'SENT';
    await SalesOrder.updateOne(
      { _id: o._id },
      { $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, `Project code request email ${status === 'SENT' ? 'sent' : status === 'SKIPPED' ? 'recorded (mail off)' : 'failed'}`, { step: 'email', newValue: { to: input.to, subject: input.subject, status } }) } },
    );
    return sent;
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
}

/**
 * Rate Card step (Client Servicing orders created with it): saves the order's rate card with the existing quotation
 * save (same validation, version and PDF) and, the first time, completes the step, which unlocks the request email.
 * It stays editable afterwards (also after the codes and the assignment); each change is a new version with its PDF.
 */
/**
 * Assign Type & Details mandatory details (assign type; shop list without row errors for the shop types; an SO contact
 * for SO): every forward transition out of step 1 checks them (Continue, Skip: Rate Card, the first Rate Card save).
 */
function assertHandoverComplete(o: Awaited<ReturnType<typeof liveOrder>>) {
  const gaps = handoverGaps({ ...o.toObject(), handoverFull: true });
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', gaps[0]!, gaps.map((message) => ({ path: 'handover', message })));
}

export async function saveRateCard(id: string, input: z.infer<typeof quotationBody>, actor: Actor) {
  const o = await liveOrder(id);
  if (!o.recce?.rateCardRequired) throw AppError.conflict('This order has no Rate Card step.');
  if (isCs(actor) && !csMine(o, actor) && String(o.createdBy) !== actor.id) throw AppError.notFound('Order not found');
  const first = !o.recce.rateCardDoneAt;
  if (first && !o.recce.handoverDoneAt && !(csMine(o, actor) && handoverReceived(o)))
    throw new AppError(422, 'HANDOVER_INCOMPLETE', 'Confirm Assign Type & Details first (Continue: Rate Card).', [{ path: 'handover', message: 'Confirm Assign Type & Details first' }]);
  // First save completes the step: the mandatory details must still be complete (no bypass through a direct link).
  if (first && !(csMine(o, actor) && handoverReceived(o)) && !(await emailDone(o._id))) assertHandoverComplete(o);
  // The PDF is generated and stored before anything is marked done; a failed save leaves the step as it was.
  const result = await saveQuotation(id, input, actor, { workflowAuthorized: isCs(actor), autoDate: true });
  const label = result.revision.label;
  // Saving here includes the saved version in this flow (also a save with no changes: the saved version is included).
  const wasIncluded = rateCardChoiceOf(o.recce) === 'INCLUDED' && (!o.recce.rateCardRevision || o.recce.rateCardRevision === result.revision.revision);
  const now = new Date();
  const include = { 'recce.rateCardChoice': 'INCLUDED', 'recce.rateCardRevision': result.revision.revision, 'recce.rateCardChoiceAt': now, 'recce.rateCardChoiceBy': actor.id };
  if (first) {
    await SalesOrder.updateOne(
      { _id: o._id, 'recce.rateCardDoneAt': null },
      {
        $set: { 'recce.rateCardDoneAt': now, 'recce.rateCardDoneBy': actor.id, ...include },
        $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, `Rate Card ${label} saved · included in the request email · step completed`, { step: 'ratecard', newValue: { version: label, choice: 'INCLUDED' } }) },
      },
    );
  } else if (result.saved || !wasIncluded) {
    const what = result.saved ? `Rate Card ${label} saved` : `Rate Card ${label}`;
    await SalesOrder.updateOne(
      { _id: o._id },
      {
        $set: include,
        $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, `${what}${wasIncluded ? '' : ' · included in the request email'}`, { step: 'ratecard', newValue: { version: label, choice: 'INCLUDED' } }) },
      },
    );
  }
  return result;
}

/**
 * Skip Rate Card (Assign Type & Details > Skip: Rate Card, or inside the Rate Card step): the step is done without a
 * rate card, so the request email goes without one, even when a version is saved (versions and their history stay).
 * Saving the rate card later in this flow includes it again.
 */
export async function skipRateCard(id: string, actor: Actor) {
  const o = await liveOrder(id);
  if (!o.recce?.rateCardRequired) throw AppError.conflict('This order has no Rate Card step.');
  assertBranchOpen(o, actor);
  if (!o.recce.handoverDoneAt && !(csMine(o, actor) && handoverReceived(o)))
    throw new AppError(422, 'HANDOVER_INCOMPLETE', 'Confirm Assign Type & Details first.', [{ path: 'handover', message: 'Confirm Assign Type & Details first' }]);
  // Skip leaves out only the Rate Card, never the mandatory assignment details.
  if (!(csMine(o, actor) && handoverReceived(o)) && !(await emailDone(o._id))) assertHandoverComplete(o);
  if (rateCardChoiceOf(o.recce) !== 'SKIPPED') {
    const now = new Date();
    const r = await SalesOrder.updateOne(
      { ...branchFilter(o, actor), 'recce.rateCardRequired': true },
      {
        $set: {
          ...(o.recce.rateCardDoneAt ? {} : { 'recce.rateCardDoneAt': now, 'recce.rateCardDoneBy': actor.id }),
          'recce.rateCardChoice': 'SKIPPED',
          'recce.rateCardChoiceAt': now,
          'recce.rateCardChoiceBy': actor.id,
        },
        $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, 'Rate Card skipped · the request email goes without a rate card', { step: 'ratecard', newValue: { choice: 'SKIPPED' } }) },
      },
    );
    if (!r.matchedCount) throw AppError.conflict('This project was assigned meanwhile. Reload the page.');
  }
  return getRecce(id, actor);
}

/** Codes are unique across operations projects and other orders. */
async function assertCodesFree(orderId: Types.ObjectId, projectCode: string, estimationCode: string) {
  if (await Project.exists({ code: projectCode })) throw invalid('projectCode', `Project code ${projectCode} already exists`);
  const other = await SalesOrder.findOne({ _id: { $ne: orderId }, deletedAt: null, $or: [{ 'recce.projectCode': projectCode }, { 'recce.estimationCode': estimationCode }] })
    .select('orderNo recce.projectCode')
    .lean();
  if (other?.recce?.projectCode === projectCode) throw invalid('projectCode', `Project code ${projectCode} is already used by order ${other.orderNo}`);
  if (other) throw invalid('estimationCode', `Estimation code ${estimationCode} is already used by order ${other.orderNo}`);
}

/** Step 1 of the Recce route: the BD confirms Handover Type & Details ("Continue"), which unlocks the request email. */
export async function confirmHandover(id: string, actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o, actor);
  assertHandoverComplete(o);
  await claimRecce(o, actor);
  if (!o.recce?.handoverDoneAt) {
    const now = new Date();
    const r = await SalesOrder.updateOne(
      branchFilter(o, actor),
      {
        $set: o.recce ? { 'recce.handoverDoneAt': now, 'recce.handoverDoneBy': actor.id } : { recce: { handoverDoneAt: now, handoverDoneBy: actor.id } },
        $push: { leadLogsArray: leadLog(actor, 'STEP', null, null, 'Assign Type & Details completed (Recce route)', { step: 'handover' }) },
      },
    );
    if (!r.matchedCount) throw AppError.conflict('This project was assigned meanwhile. Reload the page.');
  }
  return getRecce(id, actor);
}

/** Whose Zoho estimates: an Existing client by its Zoho contact id; a New client by the Client ID created in Zoho (typed or saved). */
async function estimateOwnerOf(o: OrderDoc, typedClientId?: string): Promise<EstimateOwner> {
  const c = await clientOf(o);
  if (o.clientType === 'EXISTING') return { contactId: c?.zohoId ?? c?.zohoContactId ?? null, customerNo: await zohoClientIdOf(c) };
  return { contactId: null, customerNo: typedClientId || o.recce?.clientId || c?.zohoCustomerNo || null };
}

/**
 * Codes step: the client's Zoho estimates. Each row is one project code (reference_number) with its estimation code
 * (estimate_number); codes already used by a project or another order come back with usedBy.
 */
export async function recceEstimates(id: string, typedClientId: string | undefined, actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o, actor);
  const owner = await estimateOwnerOf(o, typedClientId);
  const rows = (await listClientEstimates(owner)).filter((e) => e.reference_number?.trim());
  const projectCodes = [...new Set(rows.map((e) => e.reference_number!.trim()))];
  const estCodes = [...new Set(rows.map((e) => (e.estimate_number ?? '').trim().toUpperCase()).filter(Boolean))];
  const [projects, orders] = await Promise.all([
    Project.find({ code: { $in: projectCodes } }).select('code').lean(),
    SalesOrder.find({ _id: { $ne: o._id }, deletedAt: null, $or: [{ 'recce.projectCode': { $in: projectCodes } }, { 'recce.estimationCode': { $in: estCodes } }] })
      .select('orderNo recce.projectCode recce.estimationCode')
      .lean(),
  ]);
  const usedBy = (pc: string, est: string) => {
    const ord = orders.find((x) => x.recce?.projectCode === pc || x.recce?.estimationCode === est);
    if (ord) return 'order ' + ord.orderNo;
    return projects.some((p) => p.code === pc) ? 'an existing project' : null;
  };
  const items = rows.map((e) => {
    const projectCode = e.reference_number!.trim();
    const estimationCode = (e.estimate_number ?? '').trim().toUpperCase();
    return {
      estimateId: e.estimate_id,
      projectCode,
      estimationCode,
      date: e.date ?? null,
      total: e.total ?? null,
      status: e.status_formatted || e.status || null,
      salesperson: e.salesperson_name ?? null,
      location: e.location_name ?? null,
      /** The codes the CRM accepts: 8-digit project code, EST- and 6 digits. */
      valid: /^\d{8}$/.test(projectCode) && /^EST-\d{6}$/.test(estimationCode),
      usedBy: usedBy(projectCode, estimationCode),
    };
  });
  return { clientId: owner.customerNo ?? null, searchedBy: owner.contactId ? 'ZOHO_CONTACT' : owner.customerNo ? 'CLIENT_ID' : null, items };
}

export async function saveCodes(id: string, input: z.infer<typeof recceCodesBody>, actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o, actor);
  await claimRecce(o, actor);
  if (!(await emailDone(o._id))) throw invalid('projectCode', 'Send the project code request email first');
  await assertCodesFree(o._id, input.projectCode, input.estimationCode);
  // The codes come only from the client's Zoho estimate: it is read again and must match.
  const est = await getZohoEstimate(input.zohoEstimateId);
  if (!belongsTo(est, await estimateOwnerOf(o, input.clientId))) throw invalid('projectCode', 'This Zoho estimate does not belong to this client. Choose the project code again.');
  if (est.reference_number?.trim() !== input.projectCode || (est.estimate_number ?? '').trim().toUpperCase() !== input.estimationCode)
    throw invalid('projectCode', 'The estimate changed in Zoho. Reload the project code list and choose again.');
  // Client ID in Zoho: an Existing client's comes from Zoho; a New client's is typed (created in Zoho after the email).
  const c = await clientOf(o);
  const fromZoho = o.clientType === 'EXISTING' ? await zohoClientIdOf(c) : null;
  const clientId = fromZoho ?? input.clientId;
  if (!clientId && o.clientType !== 'EXISTING') throw invalid('clientId', 'Enter the Client ID created in Zoho for this new client');
  if (clientId && o.clientType !== 'EXISTING') {
    const other = await Client.findOne({ _id: { $ne: o.client }, deletedAt: null, $or: [{ code: clientId }, { zohoCustomerNo: clientId }] }).select('name').lean();
    if (other) throw invalid('clientId', `Client code ${clientId} already belongs to ${other.name}`);
  }
  const previous = o.recce ? (o.recce as unknown as { toObject?: () => object }).toObject?.() ?? o.recce : {};
  try {
    const r = await SalesOrder.updateOne(
      branchFilter(o, actor),
      {
        $set: { recce: { ...previous, projectCode: input.projectCode, estimationCode: input.estimationCode, zohoEstimateId: input.zohoEstimateId, clientId: clientId ?? null, codesSavedAt: new Date(), codesSavedBy: actor.id }, updatedBy: actor.id },
        $push: {
          leadLogsArray: leadLog(actor, 'STEP', null, null, `Codes saved: ${input.projectCode} / ${input.estimationCode}${clientId ? ` · Client ID ${clientId}` : ''}`, {
            step: 'codes',
            oldValue: o.recce?.projectCode ? { projectCode: o.recce.projectCode, estimationCode: o.recce.estimationCode ?? null, clientId: o.recce.clientId ?? null } : null,
            newValue: { projectCode: input.projectCode, estimationCode: input.estimationCode, clientId: clientId ?? null },
          }),
        },
      },
    );
    if (!r.matchedCount) throw AppError.conflict('This project was assigned meanwhile. Reload the page.');
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw AppError.conflict('That project or estimation code was just used by another order. Check the codes.');
    throw e;
  }
  // A New client keeps its confirmed client code (Client Management, later orders and emails); _id and clientNo stay.
  if (clientId && o.clientType !== 'EXISTING') {
    await Client.updateOne({ _id: o.client }, { $set: { zohoCustomerNo: clientId, code: clientId, updatedBy: actor.id } }).catch(async (e: { code?: number }) => {
      // Business code taken meanwhile: keep the Zoho client code at least.
      if (e.code !== 11000) throw e;
      await Client.updateOne({ _id: o.client }, { $set: { zohoCustomerNo: clientId } });
    });
  }
  await recordAudit({ actor, action: 'UPDATE', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'recce.projectCode', oldValue: o.recce?.projectCode ?? null, newValue: input.projectCode }, { field: 'recce.clientId', oldValue: o.recce?.clientId ?? null, newValue: clientId ?? null }], reason: `Project code ${input.projectCode}, estimation code ${input.estimationCode}` });
  return getRecce(id, actor);
}

/** Removes a project created for an assignment that did not go through (with its requirement and system messages). */
async function dropProject(projectId: Types.ObjectId | string) {
  await Promise.all([Project.deleteOne({ _id: projectId }), Requirement.deleteMany({ project: projectId }), CommunicationMessage.deleteMany({ project: projectId })]);
}

/**
 * Assign to Recce Team: creates the operations project from the order (code = project code, handover type, shops,
 * client contacts, notes), assigns it to the Recce / Operations person (who is notified) and completes the lead.
 */
export async function assignRecce(id: string, input: z.infer<typeof recceAssignBody>, actor: Actor) {
  const o = await liveOrder(id);
  assertBranchOpen(o, actor);
  await claimRecce(o, actor);
  const codes = o.recce?.projectCode && o.recce.estimationCode ? { projectCode: o.recce.projectCode, estimationCode: o.recce.estimationCode } : null;
  if (!codes) throw invalid('projectCode', 'Enter the project code and estimation code first');
  if (o.clientType !== 'EXISTING' && !o.recce?.clientId) throw invalid('clientId', 'Enter the Client ID created in Zoho first (Project Code & Estimation Code step)');
  const client = await clientOf(o);
  const gaps = handoverGaps({ ...o.toObject(), handoverFull: true });
  if (gaps.length) throw new AppError(422, 'HANDOVER_INCOMPLETE', gaps[0]!, gaps.map((message) => ({ path: 'handover', message })));
  // Contact persons are optional. Those with a mobile and an email go on the project (ASO: the SO contacts too).
  const so = o.handoverType === 'ASO' ? (o.soContacts ?? []) : [];
  const contacts = [...contactPersonsOf(client, o), ...so]
    .filter((k) => k.name && k.phone && k.email)
    .map((k) => ({ name: k.name!, email: k.email!, phone: k.phone! }))
    .filter((k, i, all) => all.findIndex((x) => x.phone === k.phone || x.email === k.email) === i)
    .slice(0, 20);
  const person = await User.findOne({ _id: input.assigneeId, role: { $in: ['OPERATIONS', 'RECCE_COORDINATOR'] }, isActive: true, deletedAt: null }).select('name').lean();
  if (!person) throw invalid('assigneeId', 'Choose an active Recce / Operations person');
  await assertCodesFree(o._id, codes.projectCode, codes.estimationCode);

  const type = o.handoverType as HandoverType;
  const notes = input.note ?? '';
  const parsed = projectCreate.safeParse({
    // A Client record (BD orders); a Client Servicing order's client array is copied onto the project instead.
    clientId: o.client ? String(o.client) : undefined,
    code: codes.projectCode,
    campaign: `Order ${o.orderNo}`,
    name: `${client?.name ?? 'Client'} - ${o.orderNo}`,
    priority: input.priority,
    startDate: input.startDate,
    targetDate: input.targetDate,
    district: input.district,
    instructions: notes || undefined,
    requirementType: type,
    expectedShops: type === 'ASO' ? null : (o.declaredShopTotal ?? o.shopList?.total ?? null),
    contacts,
    status: 'NEW',
    requirement: {
      source: 'OTHER',
      sourceNote: `Lead Management: ${o.orderNo} (estimation ${codes.estimationCode})`,
      description: notes || undefined,
      recceRequired: true,
      siteDataScenario: type === 'SHOP_MEASUREMENT' ? 'CLIENT_PROVIDED' : 'MEASUREMENT_REQUIRED',
    },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalid(String(issue.path[0] ?? 'project'), issue.message);
  }

  // Client Servicing order: the order's latest client entry goes onto the project (no clients collection record).
  const project = await createProject(parsed.data, actor, { clientDetails: o.client ? null : latestDetails(o) });
  const projectId = project._id as Types.ObjectId;
  try {
    await Project.updateOne({ _id: projectId }, { $set: { estimationCode: codes.estimationCode, salesOrder: o._id } });
    await assignProject(String(projectId), { assigneeId: input.assigneeId }, actor);
  } catch (e) {
    await dropProject(projectId);
    throw e;
  }

  const now = new Date();
  const note = `Assigned to ${person.name} (Recce team) · project ${codes.projectCode}`;
  const cs = csMine(o, actor);
  const assignment = { 'recce.assignee': person._id, 'recce.assignedAt': now, 'recce.assignedBy': actor.id, 'recce.note': input.note, 'recce.project': projectId, updatedBy: actor.id };
  // Client Servicing: their own completion, appended; the BD's handover, snapshot, route and completed lead are kept.
  const r = cs
    ? await SalesOrder.updateOne(
        { ...branchFilter(o, actor), 'recce.projectCode': codes.projectCode },
        {
          $set: assignment,
          $push: {
            salespipelineLogs: pipelineLog(actor, 'HANDOVER', o.stage, o.stage, `${note} (by Client Servicing)`),
            leadLogsArray: leadLog(actor, 'STEP', null, null, `Client Servicing assigned the Recce team (${person.name}) · project ${codes.projectCode}`, { step: 'cs-recce-assign' }),
          },
        },
      )
    : await SalesOrder.updateOne(
        { _id: o._id, csAssignee: null, 'recce.assignee': null, 'recce.projectCode': codes.projectCode, 'lead.status': 'OPEN', 'lead.stage': 'PROJECT_ASSIGN' },
        {
          $set: {
            ...assignment,
            handoverClient: await clientSnapshot(o),
            assignRoute: 'RECCE',
            'lead.status': 'COMPLETED',
            'lead.completedAt': now,
            'lead.completedBy': actor.id,
            'lead.stageChangedAt': now,
          },
          $push: {
            salespipelineLogs: pipelineLog(actor, 'HANDOVER', o.stage, o.stage, note),
            leadLogsArray: leadLog(actor, 'COMPLETE', 'PROJECT_ASSIGN', null, `Assigned to the Recce team (${person.name}): lead completed`),
          },
        },
      );
  if (!r.modifiedCount) {
    await dropProject(projectId);
    throw AppError.conflict('This project was assigned meanwhile. Reload the page.');
  }
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'recce.assignee', oldValue: null, newValue: String(person._id) }], reason: note });
  return getRecce(id, actor);
}
