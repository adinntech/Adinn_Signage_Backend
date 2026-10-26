import { Router } from 'express';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { scopeProject, scopeSite } from '../../common/project-access';
import * as c from './site.controller';
import * as ap from './approval.controller';

const read = [authenticate, requirePermission('sites:read'), requireAnyPermission('projects:read', 'jobs:read')];
const write = [authenticate, requirePermission('sites:write', 'projects:read')];
// Operations / coordinators may only reach projects assigned to them (see common/project-access.ts).
const readP = [...read, scopeProject('projectId')];
const writeP = [...write, scopeProject('projectId')];
const writeS = [...write, scopeSite];
// Recce staff add / correct the shops of an ASO project assigned to them (checked again in the service).
const capture = [authenticate, requireAnyPermission('projects:read', 'jobs:read'), requireAnyPermission('sites:write', 'sites:capture')];
const captureP = [...capture, scopeProject('projectId')];
const captureS = [...capture, scopeSite];
const P = '/projects/:projectId/sites';

export const siteRouter = Router();
siteRouter.get(P, ...readP, c.list);
siteRouter.post(P, ...captureP, c.create);
siteRouter.get(`${P}/stats`, ...readP, c.stats);
siteRouter.get(`${P}/export`, ...readP, c.exportFile);
siteRouter.get(`${P}/template`, ...readP, c.template);
siteRouter.post(`${P}/bulk`, ...writeP, c.bulk);
siteRouter.get(`${P}/imports`, ...readP, c.imports);
siteRouter.post(`${P}/imports`, ...writeP, c.upload, c.uploadSheet);
siteRouter.post(`${P}/imports/from-file`, ...writeP, c.extractFromFile);
siteRouter.get(`${P}/imports/:batchId`, ...readP, c.getImport);
siteRouter.post(`${P}/imports/:batchId/preview`, ...writeP, c.preview);
siteRouter.get(`${P}/imports/:batchId/rows`, ...readP, c.rows);
siteRouter.patch(`${P}/imports/:batchId/rows/:rowId`, ...writeP, c.patchRow);
siteRouter.post(`${P}/imports/:batchId/commit`, ...writeP, c.commit);
siteRouter.delete(`${P}/imports/:batchId`, ...writeP, c.discard);
siteRouter.patch('/sites/:id', ...captureS, c.update);
siteRouter.delete('/sites/:id', ...writeS, c.remove);
siteRouter.post('/sites/:id/duplicate', ...writeS, c.duplicate);
// The permission for approvals depends on the level and is checked in the service.
siteRouter.post('/sites/:id/approval', authenticate, scopeSite, ap.set);
siteRouter.get(`${P}/approval-summary`, ...readP, ap.summary);
siteRouter.post(`${P}/approve-all`, authenticate, scopeProject('projectId'), ap.approveAll);
