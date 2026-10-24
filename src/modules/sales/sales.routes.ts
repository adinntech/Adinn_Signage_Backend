import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { receive } from '../files/file.controller';
import * as c from './sales.controller';

const read = requirePermission('sales:read');
const write = requirePermission('sales:write');

/** BD sales pipeline: client registration -> orders -> Company Profile -> Rate Card -> Client Approval Proof. */
export const salesRouter = Router();
salesRouter.use(authenticate);
salesRouter.param('id', c.scopeOrder);
salesRouter.post('/orders/new-client', write, requirePermission('clients:write'), c.registerClient);
salesRouter.get('/client-servicing-users', write, c.csUsers);
salesRouter.get('/shop-list-template', read, c.shopTemplate);
salesRouter.get('/orders', read, c.list);
salesRouter.post('/orders', write, c.createOrder);
salesRouter.get('/orders/board', read, c.board);
salesRouter.get('/orders/:id', read, c.get);
salesRouter.post('/orders/:id/stage', write, c.move);
salesRouter.patch('/orders/:id/owner', write, c.reassign);
salesRouter.get('/orders/:id/history', read, c.history);
// BD -> Client Servicing handover (shop list and documents are optional; documents can still be added after handover)
salesRouter.get('/orders/:id/handover', read, c.getHandover);
salesRouter.get('/orders/:id/handover/shops', read, c.shops);
salesRouter.post('/orders/:id/handover/shops', write, receive, c.uploadShops);
salesRouter.delete('/orders/:id/handover/shops', write, c.removeShops);
salesRouter.post('/orders/:id/handover/documents', write, receive, c.addDocuments);
salesRouter.delete('/orders/:id/handover/documents/:docId', write, c.removeDocument);
salesRouter.post('/orders/:id/handover/assign', write, c.assignCs);
salesRouter.get('/orders/:id/comments', read, c.comments);
salesRouter.post('/orders/:id/comments', write, receive, c.addComment);
salesRouter.delete('/orders/:id/comments/:commentId', write, c.deleteComment);
salesRouter.delete('/orders/:id/comments/:commentId/attachments/:fileId', write, c.deleteCommentFile);
salesRouter.get('/orders/:id/files/:fileId/url', read, c.fileUrl);
salesRouter.get('/orders/:id/company-profile/draft', read, c.profileDraft);
salesRouter.post('/orders/:id/company-profile/send', write, c.sendProfile);
salesRouter.get('/orders/:id/emails', read, c.emails);
salesRouter.post('/emails/:emailId/resend', write, c.resend);
salesRouter.get('/orders/:id/rate-card', read, c.rateCard);
salesRouter.put('/orders/:id/rate-card', write, c.saveRateCard);
salesRouter.post('/orders/:id/rate-card/send', write, c.sendRateCard);
salesRouter.get('/orders/:id/approval', read, c.approvalOverview);
salesRouter.post('/orders/:id/approval/documents', write, receive, c.uploadApproval);
salesRouter.patch('/approval/documents/:docId', write, c.updateApproval);
salesRouter.delete('/approval/documents/:docId', write, c.deleteApproval);
salesRouter.post('/orders/:id/approval/complete', write, c.completeApproval);
