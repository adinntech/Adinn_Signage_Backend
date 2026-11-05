import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { assertProjectAccess } from '../../common/project-access';
import { actorOf, objectId } from '../../common/query';
import { ROLE_PERMISSIONS, type Role } from '../roles/roles';
import { RecceTrip } from './recceCost.model';
import * as svc from './recceCost.service';

export const recceCostRouter = Router();
const R = '/recce-cost';
const canReview = (role: string) => (ROLE_PERMISSIONS[role as Role] as readonly string[] | undefined)?.includes('recce-cost:review') ?? false;
const user = (req: { auth?: { sub: string; role: string } }) => ({ id: req.auth!.sub, role: req.auth!.role });

/** Employees see only their own claims; reviewers see all. */
const scopeTrip = asyncHandler(async (req, _res, next) => {
  const id = String(req.params.id);
  const t = /^[a-f\d]{24}$/i.test(id) ? await RecceTrip.findById(id).select('project employee').lean() : null;
  if (!t) throw AppError.notFound('Trip not found');
  if (String(t.employee) !== req.auth!.sub && !canReview(req.auth!.role)) throw AppError.forbidden('Not your claim');
  next();
});

// Rates: everyone on the module reads, only Admin / Finance edits (every save is a new dated version).
recceCostRouter.get(`${R}/rates`, authenticate, requireAnyPermission('recce-cost:submit', 'recce-cost:review', 'finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.ratesAt(req.query.at ? new Date(String(req.query.at)) : new Date()))));
recceCostRouter.get(`${R}/rates/history`, authenticate, requirePermission('finance:manage'), asyncHandler(async (_req, res) => ok(res, await svc.rateHistory())));
recceCostRouter.post(`${R}/rates`, authenticate, requirePermission('finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.saveRates(svc.rateBody.parse(req.body), actorOf(req)), undefined, 201)));

// Trips
recceCostRouter.get(`${R}/trips`, authenticate, requireAnyPermission('recce-cost:submit', 'recce-cost:review'), asyncHandler(async (req, res) => {
  const q = z.object({ projectId: objectId.optional(), status: z.string().optional(), mine: z.enum(['true', 'false']).optional(), employee: objectId.optional() }).parse(req.query);
  const reviewer = canReview(req.auth!.role);
  ok(res, await svc.listTrips({ ...q, mine: !reviewer || q.mine === 'true', actor: actorOf(req) }));
}));
recceCostRouter.post(`${R}/trips`, authenticate, requirePermission('recce-cost:submit'), asyncHandler(async (req, res) => {
  const body = svc.tripBody.parse(req.body);
  await assertProjectAccess(user(req), body.projectId);
  ok(res, await svc.saveTrip(null, body, actorOf(req)), undefined, 201);
}));
recceCostRouter.get(`${R}/trips/:id`, authenticate, scopeTrip, asyncHandler(async (req, res) => ok(res, await svc.getTrip(String(req.params.id)))));
recceCostRouter.put(`${R}/trips/:id`, authenticate, requirePermission('recce-cost:submit'), scopeTrip, asyncHandler(async (req, res) => ok(res, await svc.saveTrip(String(req.params.id), svc.tripBody.parse(req.body), actorOf(req)))));
recceCostRouter.post(`${R}/trips/:id/submit`, authenticate, requirePermission('recce-cost:submit'), scopeTrip, asyncHandler(async (req, res) => ok(res, await svc.submitTrip(String(req.params.id), actorOf(req)))));
recceCostRouter.post(`${R}/trips/:id/review`, authenticate, requirePermission('recce-cost:review'), scopeTrip, asyncHandler(async (req, res) => {
  const body = svc.reviewBody.parse(req.body);
  // Final decisions are Finance / Admin; Operations / Coordinator only take a claim into review.
  if (body.action !== 'START_REVIEW' && !['FINANCE', 'SUPER_ADMIN'].includes(req.auth!.role)) throw AppError.forbidden('Only Finance or Admin can approve, reject or settle');
  ok(res, await svc.reviewTrip(String(req.params.id), body, actorOf(req)));
}));
recceCostRouter.delete(`${R}/trips/:id`, authenticate, requirePermission('recce-cost:submit'), scopeTrip, asyncHandler(async (req, res) => { await svc.deleteTrip(String(req.params.id), actorOf(req)); ok(res, { deleted: true }); }));

// Vendor rate cards and the cost applied to a project
recceCostRouter.get(`${R}/vendor-rates`, authenticate, requireAnyPermission('recce-cost:review', 'finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.listVendorRates(typeof req.query.vendorId === 'string' ? req.query.vendorId : undefined))));
recceCostRouter.post(`${R}/vendor-rates`, authenticate, requirePermission('finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.saveVendorRate(null, svc.vendorRateBody.parse(req.body), actorOf(req)), undefined, 201)));
recceCostRouter.put(`${R}/vendor-rates/:id`, authenticate, requirePermission('finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.saveVendorRate(objectId.parse(req.params.id), svc.vendorRateBody.parse(req.body), actorOf(req)))));
recceCostRouter.get(`${R}/vendor-costs`, authenticate, requireAnyPermission('recce-cost:review', 'finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.listVendorCosts(typeof req.query.projectId === 'string' ? req.query.projectId : undefined))));
recceCostRouter.post(`${R}/projects/:projectId/vendor-cost`, authenticate, requireAnyPermission('vendors:manage', 'finance:manage'), asyncHandler(async (req, res) => {
  ok(res, await svc.applyVendorRate(String(req.params.projectId), svc.applyVendorBody.parse(req.body), actorOf(req)), undefined, 201);
}));

// Internal cost report
recceCostRouter.get(`${R}/report`, authenticate, requireAnyPermission('recce-cost:review', 'finance:manage', 'reports:read'), asyncHandler(async (req, res) => {
  const q = z.object({ client: objectId.optional(), project: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
  ok(res, await svc.costReport(q));
}));
