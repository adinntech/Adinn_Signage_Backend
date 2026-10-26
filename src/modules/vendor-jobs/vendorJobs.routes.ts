import { Router } from 'express';
import { authenticate, requireRole } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './vendorJobs.service';

/** Vendor mobile app: the shops allocated to the vendor this login belongs to (nothing else). */
export const vendorJobsRouter = Router();
vendorJobsRouter.use(authenticate, requireRole('VENDOR'));

vendorJobsRouter.get('/jobs', asyncHandler(async (req, res) => ok(res, await s.listJobs(actorOf(req)))));
vendorJobsRouter.get('/jobs/:projectId/shops', asyncHandler(async (req, res) => {
  const { items, meta } = await s.listJobShops(actorOf(req), s.projectParam.parse(req.params).projectId, s.shopsQuery.parse(req.query));
  ok(res, items, meta);
}));
