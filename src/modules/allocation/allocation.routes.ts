import { Router } from 'express';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { assertProjectAccess } from '../../common/project-access';
import { actorOf } from '../../common/query';
import { Site } from '../sites/site.model';
import * as svc from './allocation.service';

const pid = (r: { params: Record<string, unknown> }) => String(r.params.projectId);
const scopeProj = asyncHandler(async (req, _res, next) => {
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, pid(req));
  next();
});
const scopeSite = asyncHandler(async (req, _res, next) => {
  const id = String(req.params.id);
  const s = /^[a-f\d]{24}$/i.test(id) ? await Site.findOne({ _id: id, deletedAt: null }).select('project').lean() : null;
  if (!s) throw AppError.notFound('Shop not found');
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, String(s.project));
  next();
});

// Operations / coordinators (verification:manage + sites:write) allocate; BD may look.
const read = [authenticate, requireAnyPermission('verification:manage', 'projects:read'), scopeProj];
const write = [authenticate, requirePermission('sites:write', 'verification:manage'), scopeProj];
const P = '/projects/:projectId/allocation';

export const allocationRouter = Router();
allocationRouter.get(P, ...read, asyncHandler(async (req, res) => ok(res, await svc.getOverview(pid(req)))));
allocationRouter.get(`${P}/shops`, ...read, asyncHandler(async (req, res) => { const r = await svc.listAllocation(pid(req), svc.listQuery.parse(req.query)); ok(res, r.items, r.meta); }));
allocationRouter.get(`${P}/map`, ...read, asyncHandler(async (req, res) => ok(res, await svc.mapPoints(pid(req)))));
allocationRouter.put(`${P}/origin`, ...write, asyncHandler(async (req, res) => ok(res, await svc.setOrigin(pid(req), svc.originBody.parse(req.body), actorOf(req)))));
allocationRouter.post(`${P}/assign`, ...write, asyncHandler(async (req, res) => ok(res, await svc.assign(pid(req), svc.assignBody.parse(req.body), actorOf(req)))));
allocationRouter.post(`${P}/split/preview`, ...write, asyncHandler(async (req, res) => ok(res, await svc.previewSplit(pid(req), svc.splitBody.parse(req.body)))));
allocationRouter.post(`${P}/split/apply`, ...write, asyncHandler(async (req, res) => ok(res, await svc.applySplit(pid(req), svc.applySplitBody.parse(req.body), actorOf(req)))));
allocationRouter.post(`${P}/geocode`, ...write, asyncHandler(async (req, res) => ok(res, await svc.geocodeSites(pid(req), svc.geocodeBody.parse(req.body ?? {}), actorOf(req)))));
allocationRouter.get(`${P}/itinerary`, ...read, asyncHandler(async (req, res) => ok(res, await svc.itinerary(pid(req), svc.itineraryQuery.parse(req.query)))));
allocationRouter.put('/sites/:id/coords', authenticate, requirePermission('sites:write', 'verification:manage'), scopeSite, asyncHandler(async (req, res) => ok(res, await svc.setSiteCoords(String(req.params.id), svc.coordsBody.parse(req.body), actorOf(req)))));
