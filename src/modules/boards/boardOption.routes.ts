import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import { assertProjectAccess } from '../../common/project-access';
import { BoardOption } from './boardOption.model';
import * as svc from './boardOption.service';

const read = [authenticate, requirePermission('sites:read', 'projects:read')];
const write = [authenticate, requirePermission('sites:write')];
const P = '/projects/:projectId/boards';
const pid = (r: { params: Record<string, unknown> }) => String(r.params.projectId);
const q = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Operations / coordinators may only touch boards of projects assigned to them (common/project-access.ts). */
const scopeBoard = asyncHandler(async (req, _res, next) => {
  const id = String(req.params.id);
  const b = /^[a-f\d]{24}$/i.test(id) ? await BoardOption.findById(id).select('project').lean() : null;
  if (!b) throw AppError.notFound('Board option not found');
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, String(b.project));
  next();
});
const scopeProj = asyncHandler(async (req, _res, next) => {
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, pid(req));
  next();
});

export const boardRouter = Router();
boardRouter.get(P, ...read, scopeProj, asyncHandler(async (req, res) => ok(res, await svc.listBoards(pid(req), q(req.query.siteId)))));
boardRouter.get(`${P}/summary`, ...read, scopeProj, asyncHandler(async (req, res) => ok(res, await svc.boardSummary(pid(req)))));
boardRouter.get(
  `${P}/export`,
  ...read,
  scopeProj,
  asyncHandler(async (req, res) => {
    const r = await svc.exportBoards(pid(req), q(req.query.decision));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${r.fileName.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(r.buffer);
  }),
);
boardRouter.post(P, ...write, scopeProj, asyncHandler(async (req, res) => ok(res, await svc.createBoard(pid(req), svc.boardBody.parse(req.body), actorOf(req)), undefined, 201)));
boardRouter.patch('/boards/:id', ...write, scopeBoard, asyncHandler(async (req, res) => ok(res, await svc.updateBoard(String(req.params.id), svc.boardPatch.parse(req.body), actorOf(req)))));
boardRouter.post('/boards/:id/decision', ...write, scopeBoard, asyncHandler(async (req, res) => ok(res, await svc.decideBoard(String(req.params.id), svc.decisionBody.parse(req.body), actorOf(req)))));
boardRouter.delete('/boards/:id', ...write, scopeBoard, asyncHandler(async (req, res) => { await svc.deleteBoard(String(req.params.id), actorOf(req)); ok(res, { deleted: true }); }));
