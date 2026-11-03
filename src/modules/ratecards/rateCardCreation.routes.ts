import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import * as s from './rateCardCreation.service';
import { rateCardCreationBody, rateCardCreationListQuery } from './ratecard.validators';

const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listRateCards(rateCardCreationListQuery.parse(req.query), actorOf(req));
  ok(res, items, meta);
});
const draft = asyncHandler(async (req, res) => ok(res, await s.newRateCard(actorOf(req))));
const get = asyncHandler(async (req, res) => ok(res, await s.getRateCard(objectId.parse(req.params.id), actorOf(req))));
const create = asyncHandler(async (req, res) => ok(res, await s.saveRateCard(null, rateCardCreationBody.parse(req.body), actorOf(req)), undefined, 201));
const save = asyncHandler(async (req, res) => ok(res, await s.saveRateCard(objectId.parse(req.params.id), rateCardCreationBody.parse(req.body), actorOf(req))));
const fileUrl = asyncHandler(async (req, res) => ok(res, await s.rateCardFileUrl(objectId.parse(req.params.id), objectId.parse(req.params.fileId), actorOf(req))));

/**
 * Rate Card Creation (Client Servicing): rate cards made without an order, priced from the master rate card (read
 * only here; master rates are changed in Rate Card Management, ratecards:manage).
 */
export const rateCardCreationRouter = Router();
rateCardCreationRouter.use(authenticate, requirePermission('ratecards:create'));
rateCardCreationRouter.get('/', list);
rateCardCreationRouter.get('/new', draft);
rateCardCreationRouter.post('/', create);
rateCardCreationRouter.get('/:id', get);
rateCardCreationRouter.put('/:id', save);
rateCardCreationRouter.get('/:id/files/:fileId/url', fileUrl);
