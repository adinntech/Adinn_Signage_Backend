import { Router } from 'express';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import { env } from '../../config/env';
import { checkReplies } from '../mailReplies/replyMailbox';
import { listRouting, saveRouting } from './mailRouting.service';
import { routingBody, routingKey } from './mailRouting.validators';

export const mailSettingsRouter = Router();
mailSettingsRouter.use(authenticate, requirePermission('mail:manage'));
mailSettingsRouter.get('/routing', asyncHandler(async (_req, res) => ok(res, await listRouting())));
mailSettingsRouter.get('/replies/status', asyncHandler(async (_req, res) => ok(res, { enabled: env.imapEnabled, mailbox: env.imapEnabled ? env.IMAP_USER : null, everySeconds: env.imapEnabled ? env.MAIL_REPLY_POLL_SECONDS : 0 })));
mailSettingsRouter.post('/replies/check', asyncHandler(async (_req, res) => ok(res, await checkReplies())));
mailSettingsRouter.put('/routing/:key', asyncHandler(async (req, res) => ok(res, await saveRouting(routingKey.parse(req.params.key), routingBody.parse(req.body), actorOf(req)))));
