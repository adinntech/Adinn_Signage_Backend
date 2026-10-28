import { Router } from 'express';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { assertProjectAccess } from '../../common/project-access';
import { actorOf } from '../../common/query';
import * as svc from './costing.service';

const pid = (r: { params: Record<string, unknown> }) => String(r.params.projectId);
const scopeProj = asyncHandler(async (req, _res, next) => {
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, pid(req));
  next();
});
const read = [authenticate, requireAnyPermission('projects:read', 'finance:manage'), scopeProj];
const write = [authenticate, requirePermission('sites:write'), scopeProj];
const P = '/projects/:projectId/cost';

export const costRouter = Router();
// Company rates: everyone who plans can read them, only admin changes them.
costRouter.get('/cost-policy', authenticate, requireAnyPermission('projects:read', 'finance:manage'), asyncHandler(async (_req, res) => ok(res, await svc.getPolicy())));
costRouter.put('/cost-policy', authenticate, requirePermission('finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.updatePolicy(svc.policyBody.parse(req.body), actorOf(req)))));
costRouter.get(P, ...read, asyncHandler(async (req, res) => ok(res, await svc.getPlan(pid(req)))));
costRouter.post(`${P}/sync`, ...write, asyncHandler(async (req, res) => ok(res, await svc.syncLegs(pid(req), actorOf(req)))));
costRouter.put(P, ...write, asyncHandler(async (req, res) => ok(res, await svc.saveLegs(pid(req), svc.legsBody.parse(req.body), actorOf(req)))));
costRouter.get(`${P}/legs/:key/map-links`, ...read, asyncHandler(async (req, res) => ok(res, await svc.legMapLinks(pid(req), String(req.params.key)))));
costRouter.post(`${P}/legs/:key/route`, ...write, asyncHandler(async (req, res) => ok(res, await svc.routeLeg(pid(req), String(req.params.key), actorOf(req)))));
costRouter.post(`${P}/submit`, ...write, asyncHandler(async (req, res) => ok(res, await svc.submitPlan(pid(req), svc.submitBody.parse(req.body ?? {}), actorOf(req)))));
costRouter.post(`${P}/decide`, authenticate, requirePermission('finance:manage'), scopeProj, asyncHandler(async (req, res) => ok(res, await svc.decideApproval(pid(req), svc.decideBody.parse(req.body), actorOf(req)))));
costRouter.post(`${P}/assign`, ...write, asyncHandler(async (req, res) => ok(res, await svc.assignPlan(pid(req), actorOf(req)))));
costRouter.post(`${P}/client-decision`, ...write, asyncHandler(async (req, res) => ok(res, await svc.clientDecision(pid(req), svc.clientBody.parse(req.body), actorOf(req)))));
