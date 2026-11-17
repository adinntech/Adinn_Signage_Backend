import { Router } from 'express';
import { authenticate } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { z } from 'zod';
import { checkReplies, checkRequestReplies, replyCheckState } from './replyMailbox';

/** Optional: the request IDs of one screen (e.g. an order's project code requests): only their replies are read (fast). */
const checkBody = z.object({ requestIds: z.array(z.string().trim().regex(/^[A-Za-z0-9_-]{3,80}$/)).max(20).optional() }).optional();

/**
 * "Get reply" button of every request mail (project code, client code, vendor registration, vendor amount approval).
 * Any signed-in user may read the reply mailbox now instead of waiting for the timer; a second click while a check runs waits for
 * that check (one read of the mailbox), and processReply never reads the same mail twice.
 */
export const mailRepliesRouter = Router();
mailRepliesRouter.use(authenticate);
mailRepliesRouter.post(
  '/check',
  asyncHandler(async (req, res) => {
    const ids = checkBody.parse(req.body ?? undefined)?.requestIds;
    ok(res, await (ids?.length ? checkRequestReplies(ids) : checkReplies({ fresh: true })));
  }),
);
/** When the mailbox was last read (the timer or Get reply): shown next to the button. */
mailRepliesRouter.get('/status', asyncHandler(async (_req, res) => ok(res, replyCheckState())));
