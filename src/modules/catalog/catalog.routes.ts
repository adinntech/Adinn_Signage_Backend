import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as svc from './catalog.service';
import { catalogQuery, installationBody, installationCodeParam, installationPatch, mediaBody, mediaCodeParam, mediaPatch, questionBody, questionParam, questionPatch, reorderBody } from './catalog.validators';

export const catalogRouter = Router();
catalogRouter.use(authenticate);

/** Everyone who is signed in reads the catalog (the phone and the web need it to draw the media cards and the questions). */
catalogRouter.get('/', asyncHandler(async (req, res) => ok(res, await svc.getCatalog(catalogQuery.parse(req.query).version))));

/* Editing is for the admin only. */
const manage = requirePermission('catalog:manage');
catalogRouter.get('/usage', manage, asyncHandler(async (_req, res) => ok(res, await svc.catalogUsage())));
catalogRouter.post('/defaults', manage, asyncHandler(async (req, res) => ok(res, await svc.loadDefaults(actorOf(req)))));
catalogRouter.post('/reorder', manage, asyncHandler(async (req, res) => {
  const b = reorderBody.parse(req.body);
  ok(res, await svc.reorder(actorOf(req), b.kind, b.ids));
}));

catalogRouter.post('/media', manage, asyncHandler(async (req, res) => ok(res, await svc.createMedia(actorOf(req), mediaBody.parse(req.body)), undefined, 201)));
catalogRouter.put('/media/:code', manage, asyncHandler(async (req, res) => ok(res, await svc.updateMedia(actorOf(req), mediaCodeParam.parse(req.params).code, mediaPatch.parse(req.body)))));
catalogRouter.delete('/media/:code', manage, asyncHandler(async (req, res) => ok(res, await svc.deleteMedia(actorOf(req), mediaCodeParam.parse(req.params).code))));

catalogRouter.post('/installations', manage, asyncHandler(async (req, res) => ok(res, await svc.createInstallation(actorOf(req), installationBody.parse(req.body)), undefined, 201)));
catalogRouter.put('/installations/:code', manage, asyncHandler(async (req, res) => ok(res, await svc.updateInstallation(actorOf(req), installationCodeParam.parse(req.params).code, installationPatch.parse(req.body)))));
catalogRouter.delete('/installations/:code', manage, asyncHandler(async (req, res) => ok(res, await svc.deleteInstallation(actorOf(req), installationCodeParam.parse(req.params).code))));

catalogRouter.post('/questions', manage, asyncHandler(async (req, res) => ok(res, await svc.createQuestion(actorOf(req), questionBody.parse(req.body)), undefined, 201)));
catalogRouter.put('/questions/:uid', manage, asyncHandler(async (req, res) => ok(res, await svc.updateQuestion(actorOf(req), questionParam.parse(req.params).uid, questionPatch.parse(req.body)))));
catalogRouter.delete('/questions/:uid', manage, asyncHandler(async (req, res) => ok(res, await svc.deleteQuestion(actorOf(req), questionParam.parse(req.params).uid))));
