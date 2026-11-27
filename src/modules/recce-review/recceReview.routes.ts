import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env';
import { authenticate, requireRole } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import * as f from './recceReview.field';
import * as r from './recceReview.review';
import { fieldDashboard, performance, performanceQuery } from './recceReview.dashboard';
import { marksBody } from './recceReview.marks';
import { threadQuery } from './recceReview.thread';
import { compareQuery } from './recceReview.versions';

const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: env.MAX_IMAGE_SIZE, files: 10 } });
const one = (req: Request) => (req.file ? { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, buffer: req.file.buffer } : undefined);
const files = (req: Request) => ((req.files as Express.Multer.File[] | undefined) ?? []).map((x) => ({ originalname: x.originalname, mimetype: x.mimetype, size: x.size, buffer: x.buffer }));

/** `meta` is a JSON array in a form-data text field: one object per photo, same order as the files. */
function parseMetas(raw: unknown) {
  let json: unknown;
  try { json = JSON.parse(String(raw ?? '[]')); } catch { throw AppError.badRequest('meta must be a JSON array'); }
  return z.array(f.photoMeta).max(10).parse(json);
}

/**
 * Field app (vendor and in-house recce mobile logins): only the shops given to this login. A vendor never reaches another
 * vendor's shop: such a shop is reported as not found.
 */
export const recceFieldRouter = Router();
recceFieldRouter.use(authenticate, requireRole('VENDOR', 'RECCE_EXECUTIVE'));
const A = actorOf;
recceFieldRouter.get('/shops', asyncHandler(async (req, res) => { const out = await f.myShops(A(req), f.myShopsQuery.parse(req.query)); ok(res, out.items, out.meta); }));
recceFieldRouter.get('/shops/:siteId', asyncHandler(async (req, res) => ok(res, await f.shopDetail(A(req), f.siteParam.parse(req.params).siteId))));
recceFieldRouter.post('/shops/:siteId/start', asyncHandler(async (req, res) => ok(res, await f.startVisit(A(req), f.siteParam.parse(req.params).siteId))));
recceFieldRouter.put('/shops/:siteId/draft', asyncHandler(async (req, res) => ok(res, await f.saveDraft(A(req), f.siteParam.parse(req.params).siteId, f.draftBody.parse(req.body)))));
recceFieldRouter.post('/shops/:siteId/photos', upload.array('photos', 10), asyncHandler(async (req, res) => ok(res, await f.uploadPhotos(A(req), f.siteParam.parse(req.params).siteId, files(req), parseMetas(req.body?.meta)), undefined, 201)));
// The 2D drawing / 3D preview picture of ONE board (multipart, field "file"): stored inside the shop's document with that board.
recceFieldRouter.put('/shops/:siteId/boards/:mediaKey/renders/:kind', upload.single('file'), asyncHandler(async (req, res) => { const p = f.renderParam.parse(req.params); ok(res, await f.saveBoardRender(A(req), p.siteId, p.mediaKey, p.kind, one(req))); }));
recceFieldRouter.put('/shops/:siteId/photos/order', asyncHandler(async (req, res) => ok(res, await f.reorderPhotos(A(req), f.siteParam.parse(req.params).siteId, f.reorderBody.parse(req.body).ids))));
recceFieldRouter.patch('/shops/:siteId/photos/:photoId', asyncHandler(async (req, res) => { const p = f.photoParam.parse(req.params); ok(res, await f.patchPhoto(A(req), p.siteId, p.photoId, f.photoPatch.parse(req.body))); }));
recceFieldRouter.put('/shops/:siteId/photos/:photoId/annotation', upload.single('edited'), asyncHandler(async (req, res) => {
  const p = f.photoParam.parse(req.params);
  let json: unknown; try { json = JSON.parse(String(req.body?.annotations ?? '[]')); } catch { throw AppError.badRequest('annotations must be a JSON array'); }
  const edited = req.file ? { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, buffer: req.file.buffer } : undefined;
  ok(res, await f.annotatePhoto(A(req), p.siteId, p.photoId, f.annotationBody.parse({ annotations: json }), edited));
}));
recceFieldRouter.delete('/shops/:siteId/photos/:photoId', asyncHandler(async (req, res) => { const p = f.photoParam.parse(req.params); ok(res, await f.deletePhoto(A(req), p.siteId, p.photoId, typeof req.query.reason === 'string' ? req.query.reason : undefined)); }));
recceFieldRouter.get('/shops/:siteId/versions/compare', asyncHandler(async (req, res) => ok(res, await f.myCompare(A(req), f.siteParam.parse(req.params).siteId, compareQuery.parse(req.query)))));
recceFieldRouter.get('/shops/:siteId/versions', asyncHandler(async (req, res) => ok(res, await f.myVersions(A(req), f.siteParam.parse(req.params).siteId))));
recceFieldRouter.get('/shops/:siteId/photos/:photoId/history', asyncHandler(async (req, res) => { const p = f.photoParam.parse(req.params); ok(res, await f.myPhotoHistory(A(req), p.siteId, p.photoId)); }));
recceFieldRouter.post('/shops/:siteId/submit', asyncHandler(async (req, res) => ok(res, await f.submit(A(req), f.siteParam.parse(req.params).siteId, f.submitBody.parse(req.body)))));
recceFieldRouter.get('/dashboard', asyncHandler(async (req, res) => ok(res, await fieldDashboard(A(req)))));
// Thread: no query = last 100 oldest first (original reply); ?limit= and / or ?before= = newest-first page with meta.nextBefore.
recceFieldRouter.get('/shops/:siteId/messages/unread', asyncHandler(async (req, res) => ok(res, await f.shopUnread(A(req), f.siteParam.parse(req.params).siteId))));
recceFieldRouter.post('/shops/:siteId/messages/read', asyncHandler(async (req, res) => ok(res, await f.shopMarkRead(A(req), f.siteParam.parse(req.params).siteId))));
recceFieldRouter.get('/shops/:siteId/messages', asyncHandler(async (req, res) => { const out = await f.shopThread(A(req), f.siteParam.parse(req.params).siteId, threadQuery.parse(req.query)); ok(res, out.items, out.meta); }));
// JSON { body, refs } or multipart (body, refs as a JSON string, one image in `file`).
recceFieldRouter.post('/shops/:siteId/messages', upload.single('file'), asyncHandler(async (req, res) => ok(res, await f.sendShopMessage(A(req), f.siteParam.parse(req.params).siteId, req.body, one(req)), undefined, 201)));
recceFieldRouter.get('/shops/:siteId/activity', asyncHandler(async (req, res) => {
  const site = f.siteParam.parse(req.params).siteId;
  const d = await f.shopDetail(A(req), site); // also proves the shop is this login's
  ok(res, d.submissionId ? await r.timeline(A(req), d.submissionId, r.activityQuery.parse(req.query), true) : []);
}));

/** Review side: Recce Operations, Client Servicing (their projects), Admin and Management (everything, read-only for Management). */
export const recceReviewRouter = Router();
recceReviewRouter.use(authenticate);
recceReviewRouter.get('/inbox', asyncHandler(async (req, res) => { const out = await r.inbox(A(req), r.inboxQuery.parse(req.query)); ok(res, out.items, out.meta); }));
recceReviewRouter.get('/progress', asyncHandler(async (req, res) => ok(res, await r.progress(A(req), r.progressQuery.parse(req.query)))));
recceReviewRouter.get('/performance', asyncHandler(async (req, res) => ok(res, await performance(A(req), performanceQuery.parse(req.query)))));
recceReviewRouter.get('/monitor', asyncHandler(async (req, res) => ok(res, await r.monitorWithNames(A(req)))));
recceReviewRouter.get('/reviewers', asyncHandler(async (req, res) => ok(res, await r.reviewerChoices(A(req)))));
recceReviewRouter.get('/config', asyncHandler(async (req, res) => { if (req.auth!.role === 'VENDOR' || req.auth!.role === 'RECCE_EXECUTIVE') throw AppError.forbidden(); ok(res, await r.readConfig()); }));
recceReviewRouter.put('/config', asyncHandler(async (req, res) => ok(res, await r.saveConfig(A(req), r.configBody.parse(req.body)))));
recceReviewRouter.get('/submissions/:id', asyncHandler(async (req, res) => ok(res, await r.workspace(A(req), r.idParam.parse(req.params).id))));
recceReviewRouter.get('/submissions/:id/versions/compare', asyncHandler(async (req, res) => ok(res, await r.reviewCompare(A(req), r.idParam.parse(req.params).id, compareQuery.parse(req.query)))));
recceReviewRouter.get('/submissions/:id/versions', asyncHandler(async (req, res) => ok(res, await r.reviewVersions(A(req), r.idParam.parse(req.params).id))));
recceReviewRouter.post('/submissions/:id/start', asyncHandler(async (req, res) => ok(res, await r.markReviewStarted(A(req), r.idParam.parse(req.params).id))));
recceReviewRouter.post('/submissions/:id/decision', asyncHandler(async (req, res) => ok(res, await r.decide(A(req), r.idParam.parse(req.params).id, r.decideBody.parse(req.body)))));
recceReviewRouter.post('/submissions/:id/marks', asyncHandler(async (req, res) => ok(res, await r.applyMarks(A(req), r.idParam.parse(req.params).id, marksBody.parse(req.body)))));
recceReviewRouter.post('/submissions/:id/change-decision', asyncHandler(async (req, res) => ok(res, await r.changeDecision(A(req), r.idParam.parse(req.params).id, r.changeDecisionBody.parse(req.body)))));
recceReviewRouter.post('/submissions/:id/override', asyncHandler(async (req, res) => ok(res, await r.override(A(req), r.idParam.parse(req.params).id, r.overrideBody.parse(req.body)))));
recceReviewRouter.post('/submissions/:id/reopen', asyncHandler(async (req, res) => ok(res, await r.reopen(A(req), r.idParam.parse(req.params).id, r.reopenBody.parse(req.body)))));
recceReviewRouter.put('/submissions/:id/reviewer', asyncHandler(async (req, res) => ok(res, await r.assignReviewer(A(req), r.idParam.parse(req.params).id, r.reviewerBody.parse(req.body)))));
recceReviewRouter.post('/submissions/:id/photos/:photoId/restore', asyncHandler(async (req, res) => { const p = z.object({ id: objectId, photoId: objectId }).parse(req.params); ok(res, await r.restorePhoto(A(req), p.id, p.photoId)); }));
recceReviewRouter.get('/submissions/:id/activity', asyncHandler(async (req, res) => ok(res, await r.reviewTimeline(A(req), r.idParam.parse(req.params).id, r.activityQuery.parse(req.query)))));
recceReviewRouter.get('/submissions/:id/messages/unread', asyncHandler(async (req, res) => ok(res, await r.reviewUnread(A(req), r.idParam.parse(req.params).id))));
recceReviewRouter.post('/submissions/:id/messages/read', asyncHandler(async (req, res) => ok(res, await r.reviewMarkRead(A(req), r.idParam.parse(req.params).id))));
recceReviewRouter.get('/submissions/:id/messages', asyncHandler(async (req, res) => { const out = await r.reviewThread(A(req), r.idParam.parse(req.params).id, threadQuery.parse(req.query)); ok(res, out.items, out.meta); }));
recceReviewRouter.post('/submissions/:id/messages', upload.single('file'), asyncHandler(async (req, res) => ok(res, await r.reviewSendMessage(A(req), r.idParam.parse(req.params).id, req.body, one(req)), undefined, 201)));
