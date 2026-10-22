import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { receive } from '../files/file.controller';
import * as c from './template.controller';

export const templateRouter = Router();
templateRouter.use(authenticate, requirePermission('templates:manage'));
templateRouter.get('/:key', c.get);
templateRouter.put('/:key', c.update);
templateRouter.post('/:key/restore-default', c.restore);
templateRouter.post('/:key/pdf', receive, c.uploadPdf);
templateRouter.get('/:key/pdf/url', c.pdfUrl);
templateRouter.delete('/:key/pdf', c.removePdf);
templateRouter.get('/:key/history', c.history);
