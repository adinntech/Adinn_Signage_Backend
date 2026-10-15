import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import * as c from './project.controller';

export const projectRouter = Router();
projectRouter.use(authenticate);
projectRouter.get('/', requirePermission('projects:read'), c.list);
projectRouter.get('/summary', requirePermission('projects:read'), c.summary);
projectRouter.post('/', requirePermission('projects:write'), c.create);
projectRouter.get('/:id', requirePermission('projects:read'), c.get);
projectRouter.patch('/:id', requirePermission('projects:write'), c.update);
projectRouter.patch('/:id/status', requirePermission('projects:write'), c.status);
projectRouter.get('/:id/requirement', requirePermission('projects:read'), c.getRequirement);
projectRouter.put('/:id/requirement', requirePermission('projects:write'), c.putRequirement);
projectRouter.get('/:id/history', requirePermission('projects:read'), c.history);
