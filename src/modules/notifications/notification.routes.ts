import { Router } from 'express';
import { authenticate } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import { subscribe } from './notification.hub';
import * as svc from './notification.service';

export const notificationRouter = Router();
notificationRouter.use(authenticate);

/**
 * Live stream of this person's new notifications (Server-Sent Events). The client uses fetch with its bearer token,
 * so the stream is authenticated like every other call and ends when that token expires.
 */
notificationRouter.get('/stream', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell proxies (nginx, Render) not to buffer the stream
  });
  res.flushHeaders();
  const exp = (req.auth as { exp?: number }).exp;
  subscribe(req.auth!.sub, res, exp ? exp * 1000 : undefined);
});

notificationRouter.get('/', asyncHandler(async (req, res) => ok(res, await svc.listNotifications(actorOf(req)))));
notificationRouter.post('/read', asyncHandler(async (req, res) => ok(res, await svc.markAllRead(actorOf(req)))));
notificationRouter.post('/:id/read', asyncHandler(async (req, res) => ok(res, await svc.markRead(actorOf(req), objectId.parse(req.params.id)))));
