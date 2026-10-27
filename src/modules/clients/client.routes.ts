import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { receive } from '../files/file.controller';
import * as c from './client.controller';

export const clientRouter = Router();
clientRouter.use(authenticate);
clientRouter.get('/', requirePermission('clients:read'), c.list);
clientRouter.get('/summary', requirePermission('clients:read'), c.summary);
clientRouter.get('/:id',requirePermission('clients:read'), c.get);
clientRouter.post('/', requirePermission('clients:write'), c.create);
clientRouter.post('/company', requirePermission('clients:write'), c.register);
clientRouter.patch('/:id', requirePermission('clients:write'), c.update);
clientRouter.delete('/:id', requirePermission('clients:write'), c.remove);
clientRouter.post('/:id/gst-certificates', requirePermission('clients:write'), receive, c.addGstCertificates);
clientRouter.delete('/:id/gst-certificates/:fileId', requirePermission('clients:write'), c.removeGstCertificate);
clientRouter.get('/:id/files/:fileId/url', requirePermission('clients:read'), c.fileUrl);
