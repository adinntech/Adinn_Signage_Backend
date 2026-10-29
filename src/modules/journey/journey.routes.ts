import { Router } from 'express';
import { asyncHandler, ok } from '../../common/http';
import { authenticate, requireRole } from '../../common/auth.middleware';
import { objectId } from '../../common/query';
import * as journey from './journey.service';
import { portfolioQuery } from './journey.validators';

/** Admin project monitoring: Super Admin and Management inspect every project's journey. */
export const journeyRouter = Router();
journeyRouter.use(authenticate, requireRole('MANAGEMENT'));
journeyRouter.get(
  '/portfolio',
  asyncHandler(async (req, res) => {
    const { items, meta } = await journey.portfolio(portfolioQuery.parse(req.query));
    ok(res, items, meta);
  }),
);
journeyRouter.get(
  '/projects/:id',
  asyncHandler(async (req, res) => ok(res, await journey.projectJourney(objectId.parse(req.params.id)))),
);
