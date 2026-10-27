import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { scopeProject } from '../../common/project-access';
import * as c from './project.controller';

// Operations / coordinators reach only the projects assigned to them (common/project-access.ts).
const scoped = scopeProject('id');

export const projectRouter = Router();
projectRouter.use(authenticate);
projectRouter.get('/', requirePermission('projects:read'), c.list);
projectRouter.get('/summary', requirePermission('projects:read'), c.summary);
projectRouter.get('/activity', requirePermission('projects:read'), c.activity);
projectRouter.get('/assignees', requirePermission('projects:write'), c.assignees);
projectRouter.post('/', requirePermission('projects:write'), c.create);
projectRouter.get('/:id', requirePermission('projects:read'), scoped, c.get);
projectRouter.patch('/:id', requirePermission('projects:write'), scoped, c.update);
projectRouter.delete('/:id', requirePermission('projects:write'), scoped, c.remove);
projectRouter.patch('/:id/status', requirePermission('projects:write'), scoped, c.status);
projectRouter.post('/:id/assign', requirePermission('projects:write'), scoped, c.assign);
projectRouter.post('/:id/stage', requirePermission('verification:manage'), scoped, c.stage);
projectRouter.get('/:id/notification-log', requirePermission('projects:write'), scoped, c.notificationLog);
projectRouter.get('/:id/requirement', requirePermission('projects:read'), scoped, c.getRequirement);
projectRouter.get('/:id/bd-handover', requirePermission('projects:read'), scoped, c.bdHandover);
projectRouter.get('/:id/bd-handover/shops', requirePermission('projects:read'), scoped, c.bdHandoverShops);
projectRouter.get('/:id/bd-handover/files/:fileId/url', requirePermission('projects:read'), scoped, c.bdHandoverFileUrl);
projectRouter.put('/:id/requirement', requirePermission('projects:write'), scoped, c.putRequirement);
projectRouter.get('/:id/history', requirePermission('projects:read'), scoped, c.history);
projectRouter.get('/:id/survey-areas', requirePermission('projects:read'), scoped, c.areas);
projectRouter.post('/:id/survey-areas', requirePermission('sites:write'), scoped, c.areaCreate);
projectRouter.patch('/:id/survey-areas/:areaId', requirePermission('sites:write'), scoped, c.areaUpdate);
projectRouter.delete('/:id/survey-areas/:areaId', requirePermission('sites:write'), scoped, c.areaDelete);
