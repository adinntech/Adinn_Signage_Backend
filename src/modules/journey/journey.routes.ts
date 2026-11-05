import { Router } from 'express';
import { asyncHandler, ok } from '../../common/http';
import { authenticate, requireRole } from '../../common/auth.middleware';
import { actorOf, objectId } from '../../common/query';
import * as journey from './journey.service';
import { commentBody, portfolioQuery } from './journey.validators';

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
journeyRouter.post(
  '/projects/:id/comments',
  asyncHandler(async (req, res) => ok(res, await journey.addComment(objectId.parse(req.params.id), commentBody.parse(req.body), actorOf(req)), undefined, 201)),
);
journeyRouter.delete(
  '/projects/:id/comments/:commentId',
  asyncHandler(async (req, res) => ok(res, await journey.deleteComment(objectId.parse(req.params.id), objectId.parse(req.params.commentId), actorOf(req)))),
);
