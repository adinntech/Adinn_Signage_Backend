import type { Request } from 'express';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import * as svc from './codeRequest.service';
import { alreadySentBody, codeListQuery, confirmBody, draftBody, rejectBody, retryBody, sendBody } from './codeRequest.validators';

const id = (req: Request) => objectId.parse(req.params.id);
const uploaded = (req: Request) =>
  ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));

/** Multipart: the email fields arrive as JSON in `payload`, the attachments as `files`. */
const payload = (req: Request): unknown => {
  if (typeof req.body?.payload !== 'string') return req.body;
  try {
    return JSON.parse(req.body.payload);
  } catch {
    throw AppError.badRequest('Invalid email details');
  }
};

export const overview = asyncHandler(async (req, res) => ok(res, await svc.overview(id(req), actorOf(req))));
export const history = asyncHandler(async (req, res) => ok(res, await svc.history(id(req), actorOf(req))));
export const saveDraft = asyncHandler(async (req, res) => ok(res, await svc.saveDraft(id(req), draftBody.parse(req.body), actorOf(req))));
export const send = asyncHandler(async (req, res) => ok(res, await svc.sendRequests(id(req), sendBody.parse(payload(req)), uploaded(req), actorOf(req)), undefined, 201));
export const alreadySent = asyncHandler(async (req, res) => ok(res, await svc.markAlreadySent(id(req), alreadySentBody.parse(req.body), actorOf(req))));
export const retry = asyncHandler(async (req, res) => ok(res, await svc.retryBatch(id(req), retryBody.parse(req.body).mailBatchId, actorOf(req))));
export const confirm = asyncHandler(async (req, res) => ok(res, await svc.confirmCode(id(req), confirmBody.parse(req.body), actorOf(req))));
export const reject = asyncHandler(async (req, res) => ok(res, await svc.rejectRequest(id(req), rejectBody.parse(req.body), actorOf(req))));
export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await svc.listRequests(codeListQuery.parse(req.query), actorOf(req));
  ok(res, items, meta);
});
