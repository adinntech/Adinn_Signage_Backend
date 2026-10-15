import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import * as c from './user.controller';

export const userRouter = Router();
userRouter.use(authenticate);

// Any signed-in user
userRouter.post('/me/change-credential', c.changeMyCredential);
userRouter.get('/lookup', requirePermission('projects:read'), c.lookup);

// User management (admin)
userRouter.get('/', requirePermission('users:manage'), c.list);
userRouter.post('/', requirePermission('users:manage'), c.create);
userRouter.get('/:id', requirePermission('users:manage'), c.get);
userRouter.patch('/:id', requirePermission('users:manage'), c.update);
userRouter.post('/:id/reset-credential', requirePermission('users:manage'), c.resetCredential);
userRouter.delete('/:id', requirePermission('users:manage'), c.remove);
