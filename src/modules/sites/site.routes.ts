import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import * as c from './site.controller';

const read = [authenticate, requirePermission('sites:read', 'projects:read')];
const write = [authenticate, requirePermission('sites:write', 'projects:read')];
const P = '/projects/:projectId/sites';

export const siteRouter = Router();
siteRouter.get(P, ...read, c.list);
siteRouter.post(P, ...write, c.create);
siteRouter.get(`${P}/stats`, ...read, c.stats);
siteRouter.get(`${P}/export`, ...read, c.exportFile);
siteRouter.get(`${P}/template`, ...read, c.template);
siteRouter.post(`${P}/bulk`, ...write, c.bulk);
siteRouter.get(`${P}/imports`, ...read, c.imports);
siteRouter.post(`${P}/imports`, ...write, c.upload, c.uploadSheet);
siteRouter.get(`${P}/imports/:batchId`, ...read, c.getImport);
siteRouter.post(`${P}/imports/:batchId/preview`, ...write, c.preview);
siteRouter.get(`${P}/imports/:batchId/rows`, ...read, c.rows);
siteRouter.patch(`${P}/imports/:batchId/rows/:rowId`, ...write, c.patchRow);
siteRouter.post(`${P}/imports/:batchId/commit`, ...write, c.commit);
siteRouter.delete(`${P}/imports/:batchId`, ...write, c.discard);
siteRouter.patch('/sites/:id', ...write, c.update);
siteRouter.delete('/sites/:id', ...write, c.remove);
siteRouter.post('/sites/:id/duplicate', ...write, c.duplicate);
