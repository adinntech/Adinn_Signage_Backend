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
const read = [authenticate, requireAnyPermission('sites:read', 'finance:manage'), scopeProj];
const write = [authenticate, requirePermission('sites:write'), scopeProj];
const P = '/projects/:projectId/cost';

export const costRouter = Router();
costRouter.get('/cost-policy', authenticate, requireAnyPermission('sites:read', 'finance:manage'), asyncHandler(async (_req, res) => ok(res, await svc.getPolicy())));
costRouter.put('/cost-policy', authenticate, requirePermission('finance:manage'), asyncHandler(async (req, res) => ok(res, await svc.updatePolicy(svc.policyBody.parse(req.body), actorOf(req)))));
costRouter.get(P, ...read, asyncHandler(async (req, res) => ok(res, await svc.getPlan(pid(req)))));
costRouter.put(P, ...write, asyncHandler(async (req, res) => ok(res, await svc.savePlan(pid(req), svc.planBody.parse(req.body), actorOf(req)))));
costRouter.post(`${P}/choose`, ...write, asyncHandler(async (req, res) => ok(res, await svc.chooseChannel(pid(req), svc.chooseBody.parse(req.body), actorOf(req)))));
costRouter.post(`${P}/decide`, authenticate, requirePermission('finance:manage'), scopeProj, asyncHandler(async (req, res) => ok(res, await svc.decideApproval(pid(req), svc.decideBody.parse(req.body), actorOf(req)))));
costRouter.post(`${P}/client-decision`, ...write, asyncHandler(async (req, res) => ok(res, await svc.clientDecision(pid(req), svc.clientBody.parse(req.body), actorOf(req)))));
