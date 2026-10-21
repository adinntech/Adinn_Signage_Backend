import { Router } from 'express';
import { authenticate } from '../../common/auth.middleware';
import * as c from './file.controller';

/** Folder placement is decided by the server from the project + category; clients never send a path. */
export const fileRouter = Router();
fileRouter.get('/files/raw', c.raw); // signed link, no bearer token
fileRouter.post('/projects/:projectId/files', authenticate, c.receive, c.upload);
fileRouter.get('/projects/:projectId/files', authenticate, c.list);
fileRouter.get('/files/:id/url', authenticate, c.url);
fileRouter.delete('/files/:id', authenticate, c.remove);
