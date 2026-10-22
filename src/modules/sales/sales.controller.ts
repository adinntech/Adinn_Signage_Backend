import type { Request } from 'express';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import { quotationBody } from '../ratecards/ratecard.validators';
import * as quotation from '../ratecards/quotation.service';
import * as approval from './approval.service';
import * as mail from './salesMail.service';
import * as orders from './order.service';
import {
  approvalPatchBody,
  approvalUploadBody,
  boardQuery,
  commentBody,
  createOrderBody,
  emailListQuery,
  moveBody,
  ownerBody,
  registerBody,
  sendEmailBody,
} from './sales.validators';

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
export const board = asyncHandler(async (req, res) => ok(res, await orders.orderBoard(boardQuery.parse(req.query))));
export const get = asyncHandler(async (req, res) => ok(res, await orders.getOrder(id(req))));
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
