import { Router } from 'express';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { assertProjectAccess } from '../../common/project-access';
import { actorOf } from '../../common/query';
import { Expense } from './expense.model';
import * as svc from './expense.service';

const pid = (r: { params: Record<string, unknown> }) => String(r.params.projectId);
const scopeProj = asyncHandler(async (req, _res, next) => {
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, pid(req));
  next();
});
const scopeExpense = asyncHandler(async (req, _res, next) => {
  const id = String(req.params.id);
  const e = /^[a-f\d]{24}$/i.test(id) ? await Expense.findById(id).select('project').lean() : null;
  if (!e) throw AppError.notFound('Expense not found');
  await assertProjectAccess({ id: req.auth!.sub, role: req.auth!.role }, String(e.project));
  next();
});

const P = '/projects/:projectId/expenses';
export const expenseRouter = Router();
// The mobile app (field:execute) submits claims; Operations may enter one for the team; Finance / Admin review them.
expenseRouter.get(P, authenticate, requireAnyPermission('sites:read', 'finance:manage'), scopeProj, asyncHandler(async (req, res) => ok(res, await svc.listExpenses(pid(req)))));
expenseRouter.post(P, authenticate, requireAnyPermission('field:execute', 'sites:write'), scopeProj, asyncHandler(async (req, res) => ok(res, await svc.createExpense(pid(req), svc.expenseBody.parse(req.body), actorOf(req)), undefined, 201)));
expenseRouter.post('/expenses/:id/review', authenticate, requirePermission('finance:manage'), scopeExpense, asyncHandler(async (req, res) => ok(res, await svc.reviewExpense(String(req.params.id), svc.reviewBody.parse(req.body), actorOf(req)))));
expenseRouter.delete('/expenses/:id', authenticate, requireAnyPermission('field:execute', 'sites:write', 'finance:manage'), scopeExpense, asyncHandler(async (req, res) => { await svc.deleteExpense(String(req.params.id), actorOf(req)); ok(res, { deleted: true }); }));
