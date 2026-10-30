import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { receive } from '../files/file.controller';
import * as c from './sales.controller';

const read = requirePermission('sales:read');
const write = requirePermission('sales:write');
/**
 * Handover chat: the BD team (sales:write) and the Client Servicing person the order is handed to (the :id param
 * scope already limits Client Servicing to their own orders, so they can reply on those only).
 */
const chat = (req: Request, res: Response, next: NextFunction) =>
  req.auth?.role === 'CLIENT_SERVICING' ? next() : write(req, res, next);

/**
 * Client Servicing workflow (Assign to Recce Team on an order handed to them): the BD team (sales:write) or a Client
 * Servicing person. :id scoping limits Client Servicing to their own orders; the services allow only the assigned
 * person and only the workflow steps (handover details only when they were not sent).
 */
const csFlow = (req: Request, res: Response, next: NextFunction) =>
  req.auth?.role === 'CLIENT_SERVICING' ? next() : write(req, res, next);

/** BD sales pipeline: client registration -> orders -> Company Profile -> Rate Card -> Client Approval Proof. */
export const salesRouter = Router();
salesRouter.use(authenticate);
salesRouter.param('id', c.scopeOrder);
salesRouter.post('/orders/new-client', write, requirePermission('clients:write'), c.registerClient);
salesRouter.get('/client-servicing-users', write, c.csUsers);
salesRouter.get('/recce-users', csFlow, c.recceUsers);
// Project Assign > Assign to Recce Team
salesRouter.get('/orders/:id/recce', csFlow, c.getRecce);
salesRouter.post('/orders/:id/recce/handover-done', csFlow, c.confirmRecceHandover);
salesRouter.post('/orders/:id/recce/code-request', csFlow, receive, c.sendCodeRequest);
salesRouter.put('/orders/:id/recce/codes', csFlow, c.saveRecceCodes);
salesRouter.post('/orders/:id/recce/assign', csFlow, c.assignRecce);
salesRouter.get('/shop-list-template', read, c.shopTemplate);
salesRouter.get('/zoho-clients', write, c.zohoClients);
salesRouter.get('/zoho-clients/:zohoId', write, c.zohoClient);
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
salesRouter.post('/orders/:id/handover/shops', csFlow, receive, c.uploadShops);
salesRouter.delete('/orders/:id/handover/shops', csFlow, c.removeShops);
salesRouter.get('/orders/:id/handover/shops/export', read, c.exportShops);
salesRouter.post('/orders/:id/handover/shop-rows', csFlow, c.addShopRow);
salesRouter.put('/orders/:id/handover/shop-rows/:rowId', csFlow, c.updateShopRow);
salesRouter.delete('/orders/:id/handover/shop-rows/:rowId', csFlow, c.deleteShopRow);
salesRouter.get('/orders/:id/handover/shop-history', read, c.shopHistory);
salesRouter.post('/orders/:id/handover/shop-rows/:rowId/files', csFlow, receive, c.addShopFiles);
salesRouter.delete('/orders/:id/handover/shop-rows/:rowId/files/:fileId', csFlow, c.removeShopFile);
// Communication & attachments (chat): text, files and voice notes
salesRouter.post('/orders/:id/handover/messages', read, chat, receive, c.addMessage);
salesRouter.delete('/orders/:id/handover/messages/:messageId', write, c.removeMessage);
salesRouter.patch('/orders/:id/handover/scope', write, c.handoverScope);
salesRouter.patch('/orders/:id/handover/type', csFlow, c.handoverType);
// ASO: the client's SO contacts (saved as one list)
salesRouter.put('/orders/:id/handover/so-contacts', csFlow, c.soContacts);
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
// Lead Management (mind map): an order becomes a lead and moves through its stages
salesRouter.get('/leads', read, c.leadList);
salesRouter.get('/leads/summary', read, c.leadSummary);
salesRouter.get('/leads/candidates', read, c.leadCandidates);
salesRouter.post('/leads', write, c.startLead);
salesRouter.get('/leads/:id', read, c.getLead);
salesRouter.patch('/leads/:id/notes', write, c.leadNotes);
salesRouter.post('/leads/:id/complete', write, c.completeLeadStage);
salesRouter.post('/leads/:id/back', write, c.previousLeadStage);
salesRouter.post('/leads/:id/close', write, c.closeLead);
salesRouter.post('/leads/:id/reopen', write, c.reopenLead);
salesRouter.post('/leads/:id/client', write, c.changeLeadClient);
salesRouter.get('/leads/:id/onboarding', read, c.onboarding);
salesRouter.put('/leads/:id/onboarding', write, c.saveOnboarding);
salesRouter.post('/leads/:id/onboarding/send', write, c.sendOnboarding);
salesRouter.get('/leads/:id/requirements', read, c.requirementNotes);
salesRouter.post('/leads/:id/requirements', write, receive, c.addRequirementNote);
salesRouter.delete('/leads/:id/requirements/:noteId', write, c.deleteRequirementNote);
