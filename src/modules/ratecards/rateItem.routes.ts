import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import * as s from './rateItem.service';
import { rateItemBody, rateItemListQuery, rateItemPatch } from './ratecard.validators';

const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listRateItems(rateItemListQuery.parse(req.query));
  ok(res, items, meta);
});
const create = asyncHandler(async (req, res) => ok(res, await s.createRateItem(rateItemBody.parse(req.body), actorOf(req)), undefined, 201));
const update = asyncHandler(async (req, res) => ok(res, await s.updateRateItem(objectId.parse(req.params.id), rateItemPatch.parse(req.body), actorOf(req))));
const remove = asyncHandler(async (req, res) => ok(res, await s.deleteRateItem(objectId.parse(req.params.id), actorOf(req))));

/** Master rate card. Reading is open to the sales pipeline (Copy From Master / Compare Rates); changes need ratecards:manage. */
export const rateItemRouter = Router();
rateItemRouter.use(authenticate);
rateItemRouter.get('/', requirePermission('sales:read'), list);
rateItemRouter.post('/', requirePermission('ratecards:manage'), create);
rateItemRouter.patch('/:id', requirePermission('ratecards:manage'), update);
rateItemRouter.delete('/:id', requirePermission('ratecards:manage'), remove);
