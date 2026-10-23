import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './masters.service';

const label = (what: string, max: number, pattern: RegExp, hint: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, ' '))
    .pipe(z.string().min(2, `Enter the ${what} name (at least 2 characters)`).max(max).regex(pattern, hint));

export const industryBody = z.object({
  name: label('industry', 80, /^[A-Za-z0-9&,./()' -]+$/, 'Use letters, numbers, spaces and & , . / ( ) - only'),
});
const state = z.string().trim().min(1, 'Select a state').max(80);
export const cityBody = z.object({
  state,
  name: label('city', 60, /^[A-Za-z][A-Za-z .'-]*$/, 'Use letters, spaces and . \' - only'),
});

/** Client-form masters: Industry / Business Category, and the State -> City list from `locations`. */
export const mastersRouter = Router();
mastersRouter.use(authenticate);
mastersRouter.get('/industries', requirePermission('clients:read'), asyncHandler(async (_req, res) => ok(res, await s.listIndustries())));
mastersRouter.post(
  '/industries',
  requirePermission('clients:write'),
  asyncHandler(async (req, res) => ok(res, await s.createIndustry(industryBody.parse(req.body), actorOf(req)), undefined, 201)),
);
mastersRouter.get('/states', requirePermission('clients:read'), asyncHandler(async (_req, res) => ok(res, await s.listStates())));
mastersRouter.get('/cities', requirePermission('clients:read'), asyncHandler(async (req, res) => ok(res, await s.listCities(state.parse(req.query.state)))));
mastersRouter.post('/cities', requirePermission('clients:write'), asyncHandler(async (req, res) => ok(res, await s.addCity(cityBody.parse(req.body)), undefined, 201)));
