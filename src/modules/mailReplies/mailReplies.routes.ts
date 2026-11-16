import { Router } from 'express';
import { authenticate } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { checkReplies, replyCheckState } from './replyMailbox';

/**
 * "Get reply" button of every request mail (project code, client code, vendor registration, vendor amount approval).
 * Any signed-in user may read the reply mailbox now instead of waiting for the timer; a second click while a check runs waits for
 * that check (one read of the mailbox), and processReply never reads the same mail twice.
 */
export const mailRepliesRouter = Router();
mailRepliesRouter.use(authenticate);
mailRepliesRouter.post('/check', asyncHandler(async (_req, res) => ok(res, await checkReplies())));
/** When the mailbox was last read (the timer or Get reply): shown next to the button. */
mailRepliesRouter.get('/status', asyncHandler(async (_req, res) => ok(res, replyCheckState())));
