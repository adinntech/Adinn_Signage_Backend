import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import * as c from './communication.controller';

const read = requirePermission('communications:read');
const write = requirePermission('communications:write');

export const communicationRouter = Router();
communicationRouter.use(authenticate);
communicationRouter.get('/messages', read, c.list);
communicationRouter.post('/messages', write, c.create);
communicationRouter.get('/messages/:id', read, c.get);
communicationRouter.patch('/messages/:id/actioned', write, c.actioned);
communicationRouter.post('/messages/:id/request-approval', write, c.requestApproval);
communicationRouter.patch('/messages/:id/approval', read, c.decide);
communicationRouter.post('/messages/:id/create-project', write, requirePermission('projects:write'), c.createProject);
communicationRouter.get('/projects/:projectId/channels', read, c.channels);
communicationRouter.put('/projects/:projectId/channels/:kind', write, c.putChannel);
communicationRouter.get('/projects/:projectId/channels/:kind/intro', read, c.intro);
