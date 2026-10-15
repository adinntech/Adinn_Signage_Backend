import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import * as c from './client.controller';

export const clientRouter = Router();
clientRouter.use(authenticate);
clientRouter.get('/', requirePermission('clients:read'), c.list);
clientRouter.get('/:id', requirePermission('clients:read'), c.get);
clientRouter.post('/', requirePermission('clients:write'), c.create);
clientRouter.patch('/:id', requirePermission('clients:write'), c.update);
clientRouter.delete('/:id', requirePermission('clients:write'), c.remove);
