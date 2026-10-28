import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import { quotationBody } from '../ratecards/ratecard.validators';
import * as quotation from '../ratecards/quotation.service';
import * as approval from './approval.service';
import * as handover from './handover.service';
import * as leads from './lead.service';
import * as onboard from './onboarding.service';
import * as recce from './recce.service';
import * as mail from './salesMail.service';
import * as orders from './order.service';
import {
  approvalPatchBody,
  approvalUploadBody,
  assignCsBody,
  boardQuery,
  closeLeadBody,
  commentBody,
  createOrderBody,
  emailListQuery,
  handoverNotesBody,
  handoverScopeBody,
  handoverTypeBody,
  shopTotalBody,
  voiceNoteBody,
  leadCandidatesQuery,
  leadListQuery,
  leadMoveBody,
  leadNotesBody,
  moveBody,
  onboardingBody,
  orderListQuery,
  ownerBody,
  registerBody,
  sendEmailBody,
  shopRowsQuery,
  startLeadBody,
  zohoClientQuery,
  recceAssignBody,
  recceCodesBody,
} from './sales.validators';
import { linkedZohoClients } from '../clients/client.service';
import { searchZohoClients, zohoMode } from '../zoho/zoho.customers';

const id = (req: Request) => objectId.parse(req.params.id);
const uploaded = (req: Request) =>
  ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));

export const registerClient = asyncHandler(async (req, res) => {
  const r = await orders.registerNewClient(registerBody.parse(req.body), actorOf(req));
  ok(res, r, undefined, r.replayed ? 200 : 201);
});
export const createOrder = asyncHandler(async (req, res) => {
  const r = await orders.createOrderForClient(createOrderBody.parse(req.body), actorOf(req));
  ok(res, r, undefined, r.replayed ? 200 : 201);
});
/** Existing Client picker: Zoho customers (sample list until Zoho is connected), each with its linked CRM client if any. */
export const zohoClients = asyncHandler(async (req, res) => {
  const { q } = zohoClientQuery.parse(req.query);
  const items = await searchZohoClients(q);
  const linked = await linkedZohoClients(items.map((z) => z.zohoId));
  ok(res, items.map((z) => ({ ...z, clientId: linked.get(z.zohoId)?.clientId ?? null, clientNo: linked.get(z.zohoId)?.clientNo ?? null })), { mode: zohoMode() });
});
export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await orders.listOrders(orderListQuery.parse(req.query), actorOf(req));
  ok(res, items, meta);
});
export const board = asyncHandler(async (req, res) => {
  if (handover.isCs(actorOf(req))) throw AppError.forbidden();
  ok(res, await orders.orderBoard(boardQuery.parse(req.query)));
});
export const get = asyncHandler(async (req, res) => {
  await handover.markSeen(id(req), actorOf(req));
  ok(res, await orders.getOrder(id(req)));
});

/** Client Servicing may only open orders handed to them (runs for every `/orders/:id...` route). */
export const scopeOrder = (req: Request, _res: Response, next: NextFunction, value: string) => {
  handover.assertOrderAccess(objectId.parse(value), actorOf(req)).then(() => next(), next);
};

/* --------------------------------- handover --------------------------------- */

export const csUsers = asyncHandler(async (_req, res) => ok(res, await handover.csUsers()));
export const shopTemplate = asyncHandler(async (req, res) => {
  // ?type=SHOP_DETAILS: without Size (W x H). Anything else: the Shop + Measurement template (with Size).
  const type = req.query.type === 'SHOP_DETAILS' ? 'SHOP_DETAILS' : 'SHOP_MEASUREMENT';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${type === 'SHOP_DETAILS' ? 'shop-details-template' : 'shop-measurement-template'}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(await handover.shopTemplate(type));
});
export const getHandover = asyncHandler(async (req, res) => ok(res, await handover.getHandover(id(req))));
export const shops = asyncHandler(async (req, res) => {
  const { items, meta } = await handover.listShops(id(req), shopRowsQuery.parse(req.query));
  ok(res, items, meta);
});
export const uploadShops = asyncHandler(async (req, res) => ok(res, await handover.uploadShopList(id(req), uploaded(req)[0], actorOf(req)), undefined, 201));
export const removeShops = asyncHandler(async (req, res) => ok(res, await handover.removeShopList(id(req), actorOf(req))));
export const addDocuments = asyncHandler(async (req, res) => ok(res, await handover.addDocuments(id(req), uploaded(req), actorOf(req)), undefined, 201));
export const removeDocument = asyncHandler(async (req, res) => ok(res, await handover.removeDocument(id(req), objectId.parse(req.params.docId), actorOf(req))));
export const handoverScope = asyncHandler(async (req, res) => ok(res, await handover.setHandoverScope(id(req), handoverScopeBody.parse(req.body).full, actorOf(req))));
export const handoverNotes = asyncHandler(async (req, res) => ok(res, await handover.setHandoverNotes(id(req), handoverNotesBody.parse(req.body).notes, actorOf(req))));
export const addVoiceNote = asyncHandler(async (req, res) =>
  ok(res, await handover.addVoiceNote(id(req), uploaded(req)[0], voiceNoteBody.parse(req.body ?? {}).durationSec, actorOf(req)), undefined, 201),
);
export const removeVoiceNote = asyncHandler(async (req, res) => ok(res, await handover.removeVoiceNote(id(req), objectId.parse(req.params.noteId), actorOf(req))));
export const handoverType = asyncHandler(async (req, res) => ok(res, await handover.setHandoverType(id(req), handoverTypeBody.parse(req.body).type, actorOf(req))));
export const shopTotal = asyncHandler(async (req, res) => ok(res, await handover.setShopTotal(id(req), shopTotalBody.parse(req.body).total, actorOf(req))));
export const verifyShops = asyncHandler(async (req, res) => ok(res, await handover.verifyShops(id(req), actorOf(req))));
const rowNo = (req: Request) => z.coerce.number().int().min(1).parse(req.params.row);
export const addShopFiles = asyncHandler(async (req, res) => ok(res, await handover.addShopFiles(id(req), rowNo(req), uploaded(req), actorOf(req)), undefined, 201));
export const removeShopFile = asyncHandler(async (req, res) => ok(res, await handover.removeShopFile(id(req), rowNo(req), objectId.parse(req.params.fileId), actorOf(req))));
export const assignCs =asyncHandler(async (req, res) => ok(res, await handover.assignClientServicing(id(req), assignCsBody.parse(req.body), actorOf(req))));
export const move = asyncHandler(async (req, res) => ok(res, await orders.moveStage(id(req), moveBody.parse(req.body).stage, actorOf(req))));
export const reassign = asyncHandler(async (req, res) => ok(res, await orders.reassignOwner(id(req), ownerBody.parse(req.body).ownerId, actorOf(req))));
export const history = asyncHandler(async (req, res) => ok(res, await orders.orderHistory(id(req))));

export const comments = asyncHandler(async (req, res) => ok(res, await orders.listComments(id(req))));
export const addComment = asyncHandler(async (req, res) =>
  ok(res, await orders.addComment(id(req), commentBody.parse(req.body ?? {}).body, uploaded(req), actorOf(req)), undefined, 201),
);
export const deleteComment = asyncHandler(async (req, res) => ok(res, await orders.deleteComment(id(req), objectId.parse(req.params.commentId), actorOf(req))));
export const deleteCommentFile = asyncHandler(async (req, res) =>
  ok(res, await orders.deleteCommentAttachment(id(req), objectId.parse(req.params.commentId), objectId.parse(req.params.fileId), actorOf(req))),
);
export const fileUrl = asyncHandler(async (req, res) => ok(res, await orders.orderFileUrl(id(req), objectId.parse(req.params.fileId))));

export const profileDraft = asyncHandler(async (req, res) => ok(res, await mail.companyProfileDraft(id(req), actorOf(req))));
export const sendProfile = asyncHandler(async (req, res) => ok(res, await mail.sendCompanyProfile(id(req), sendEmailBody.parse(req.body), actorOf(req)), undefined, 201));
export const emails = asyncHandler(async (req, res) => ok(res, await mail.listEmails(id(req), emailListQuery.parse(req.query).kind)));
export const resend = asyncHandler(async (req, res) => ok(res, await mail.resendEmail(objectId.parse(req.params.emailId), actorOf(req)), undefined, 201));

export const rateCard = asyncHandler(async (req, res) => ok(res, await quotation.getQuotation(id(req), actorOf(req))));
export const saveRateCard = asyncHandler(async (req, res) => ok(res, await quotation.saveQuotation(id(req), quotationBody.parse(req.body), actorOf(req))));
export const sendRateCard = asyncHandler(async (req, res) => ok(res, await mail.sendRateCard(id(req), sendEmailBody.parse(req.body), actorOf(req)), undefined, 201));

export const approvalOverview = asyncHandler(async (req, res) => ok(res, await approval.approvalOverview(id(req))));
export const uploadApproval = asyncHandler(async (req, res) =>
  ok(res, await approval.uploadApprovalDoc(id(req), approvalUploadBody.parse(req.body ?? {}), uploaded(req)[0], actorOf(req)), undefined, 201),
);
export const updateApproval = asyncHandler(async (req, res) =>
  ok(res, await approval.updateApprovalDoc(objectId.parse(req.params.docId), approvalPatchBody.parse(req.body), actorOf(req))),
);
export const deleteApproval = asyncHandler(async (req, res) => ok(res, await approval.deleteApprovalDoc(objectId.parse(req.params.docId), actorOf(req))));
export const completeApproval =asyncHandler(async (req, res) => ok(res, await approval.completeApproval(id(req), actorOf(req))));

/* ----------------------------- Lead Management ----------------------------- */

/** Every lead route: not for Client Servicing. */
const bd = (req: Request) => {
  const actor = actorOf(req);
  leads.assertLeadAccess(actor);
  return actor;
};
export const leadList = asyncHandler(async (req, res) => {
  bd(req);
  const { items, meta } = await leads.listLeads(leadListQuery.parse(req.query));
  ok(res, items, meta);
});
export const leadSummary = asyncHandler(async (req, res) => {
  bd(req);
  ok(res, await leads.leadSummary());
});
export const leadCandidates = asyncHandler(async (req, res) => {
  bd(req);
  ok(res, await leads.leadCandidates(leadCandidatesQuery.parse(req.query)));
});
export const startLead = asyncHandler(async (req, res) => ok(res, await leads.startLead(startLeadBody.parse(req.body), bd(req)), undefined, 201));
export const getLead = asyncHandler(async (req, res) => {
  bd(req);
  ok(res, await leads.getLead(id(req)));
});
export const leadNotes = asyncHandler(async (req, res) => ok(res, await leads.updateInitialNotes(id(req), leadNotesBody.parse(req.body).initialNotes, bd(req))));
export const completeLeadStage = asyncHandler(async (req, res) => {
  const b = leadMoveBody.parse(req.body);
  ok(res, await leads.completeStage(id(req), b.stage, b.note, bd(req)));
});
export const previousLeadStage = asyncHandler(async (req, res) => {
  const b = leadMoveBody.parse(req.body);
  ok(res, await leads.previousStage(id(req), b.stage, b.note, bd(req)));
});
export const closeLead = asyncHandler(async (req, res) => ok(res, await leads.closeLead(id(req), closeLeadBody.parse(req.body).reason, bd(req))));
export const reopenLead = asyncHandler(async (req, res) => ok(res, await leads.reopenLead(id(req), bd(req))));
export const requirementNotes = asyncHandler(async (req, res) => {
  bd(req);
  ok(res, await leads.listRequirementNotes(id(req)));
});
export const addRequirementNote = asyncHandler(async (req, res) =>
  ok(res, await leads.addRequirementNote(id(req), commentBody.parse(req.body ?? {}).body, uploaded(req), bd(req)), undefined, 201),
);
export const onboarding = asyncHandler(async (req, res) => ok(res, await onboard.getOnboarding(id(req), bd(req))));
export const saveOnboarding = asyncHandler(async (req, res) => ok(res, await onboard.saveOnboarding(id(req), onboardingBody.parse(req.body), bd(req))));
export const sendOnboarding = asyncHandler(async (req, res) => ok(res, await onboard.sendOnboarding(id(req), sendEmailBody.parse(req.body), bd(req)), undefined, 201));
/* ------------------------------ Project Assign > Recce team ------------------------------ */

export const recceUsers = asyncHandler(async (_req, res) => ok(res, await recce.recceUsers()));
export const getRecce = asyncHandler(async (req, res) => ok(res, await recce.getRecce(id(req), bd(req))));
/** Multipart: the email fields arrive as JSON in `payload`, the attachments as `files`. */
export const sendCodeRequest = asyncHandler(async (req, res) => {
  let raw: unknown = req.body;
  if (typeof req.body?.payload === 'string') {
    try {
      raw = JSON.parse(req.body.payload);
    } catch {
      throw AppError.badRequest('Invalid email details');
    }
  }
  ok(res, await recce.sendCodeRequest(id(req), sendEmailBody.parse(raw), uploaded(req), bd(req)), undefined, 201);
});
export const saveRecceCodes = asyncHandler(async (req, res) => ok(res, await recce.saveCodes(id(req), recceCodesBody.parse(req.body), bd(req))));
export const assignRecce = asyncHandler(async (req, res) => ok(res, await recce.assignRecce(id(req), recceAssignBody.parse(req.body), bd(req))));

export const deleteRequirementNote =asyncHandler(async (req, res) => ok(res, await leads.deleteRequirementNote(id(req), objectId.parse(req.params.noteId), bd(req))));
