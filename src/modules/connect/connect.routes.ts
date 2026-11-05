import { Router, type Request } from 'express';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { actorOf, objectId } from '../../common/query';
import { receive } from '../files/file.controller';
import * as svc from './connect.service';
import { browseQuery, bulkDeleteBody, createChannelBody, editBody, membersBody, messagePayload, messagesQuery, peopleQuery, pinBody, reactBody, searchQuery, updateChannelBody } from './connect.validators';

/** Adinn Connect: team, project, private and direct channels for every web role. What each person sees is decided per channel. */
export const connectRouter = Router();
connectRouter.use(authenticate, requirePermission('connect:use'));

const id = (req: Request) => objectId.parse(req.params.id);
const sub = (req: Request, name: string) => objectId.parse(req.params[name]);
const uploaded = (req: Request) =>
  ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));
/** Multipart: the message fields arrive as JSON in `payload`, the files as `files`. A plain JSON body works too. */
const payload = (req: Request): unknown => {
  if (typeof req.body?.payload !== 'string') return req.body;
  try {
    return JSON.parse(req.body.payload);
  } catch {
    throw AppError.badRequest('Invalid message');
  }
};

const h = asyncHandler;
connectRouter.get('/people', h(async (req, res) => ok(res, await svc.people(peopleQuery.parse(req.query).q, actorOf(req)))));
connectRouter.get('/search', h(async (req, res) => ok(res, await svc.searchMessages(searchQuery.parse(req.query).q, actorOf(req)))));

connectRouter.get('/channels', h(async (req, res) => ok(res, await svc.listChannels(actorOf(req)))));
connectRouter.get('/channels/browse', h(async (req, res) => ok(res, await svc.browseChannels(browseQuery.parse(req.query).q, actorOf(req)))));
connectRouter.post('/channels', h(async (req, res) => ok(res, await svc.createChannel(createChannelBody.parse(req.body), actorOf(req)), undefined, 201)));
connectRouter.post('/channels/project/:projectId', h(async (req, res) => ok(res, await svc.openProjectChannel(sub(req, 'projectId'), actorOf(req)))));
connectRouter.get('/channels/:id', h(async (req, res) => ok(res, await svc.channelDetail(id(req), actorOf(req)))));
connectRouter.patch('/channels/:id', h(async (req, res) => ok(res, await svc.updateChannel(id(req), updateChannelBody.parse(req.body), actorOf(req)))));
connectRouter.post('/channels/:id/join', h(async (req, res) => ok(res, await svc.joinChannel(id(req), actorOf(req)))));
connectRouter.post('/channels/:id/members', h(async (req, res) => ok(res, await svc.addMembers(id(req), membersBody.parse(req.body), actorOf(req)))));
connectRouter.delete('/channels/:id/members/:userId', h(async (req, res) => ok(res, await svc.removeMember(id(req), sub(req, 'userId'), actorOf(req)))));

connectRouter.get('/channels/:id/messages', h(async (req, res) => ok(res, await svc.listMessages(id(req), messagesQuery.parse(req.query), actorOf(req)))));
connectRouter.post('/channels/:id/messages', receive, h(async (req, res) => ok(res, await svc.postMessage(id(req), messagePayload.parse(payload(req)), uploaded(req), actorOf(req)), undefined, 201)));
connectRouter.patch('/channels/:id/messages/:messageId', h(async (req, res) => ok(res, await svc.editMessage(id(req), sub(req, 'messageId'), editBody.parse(req.body), actorOf(req)))));
connectRouter.delete('/channels/:id/messages/:messageId', h(async (req, res) => ok(res, await svc.deleteMessage(id(req), sub(req, 'messageId'), actorOf(req)))));
connectRouter.post('/channels/:id/messages/bulk-delete', h(async (req, res) => ok(res, await svc.deleteMessages(id(req), bulkDeleteBody.parse(req.body).ids, actorOf(req)))));
connectRouter.post('/channels/:id/messages/clear', h(async (req, res) => ok(res, await svc.clearChannel(id(req), actorOf(req)))));
connectRouter.post('/channels/:id/messages/:messageId/reactions', h(async (req, res) => ok(res, await svc.reactToMessage(id(req), sub(req, 'messageId'), reactBody.parse(req.body), actorOf(req)))));

connectRouter.get('/channels/:id/pins', h(async (req, res) => ok(res, await svc.pinnedMessages(id(req), actorOf(req)))));
connectRouter.post('/channels/:id/pins', h(async (req, res) => ok(res, await svc.pinMessage(id(req), pinBody.parse(req.body), true, actorOf(req)))));
connectRouter.delete('/channels/:id/pins/:messageId', h(async (req, res) => ok(res, await svc.pinMessage(id(req), { messageId: sub(req, 'messageId') }, false, actorOf(req)))));
connectRouter.post('/channels/:id/read', h(async (req, res) => ok(res, await svc.markRead(id(req), actorOf(req)))));
connectRouter.get('/channels/:id/files', h(async (req, res) => ok(res, await svc.channelFiles(id(req), actorOf(req)))));
connectRouter.get('/channels/:id/files/:fileId/url', h(async (req, res) => ok(res, await svc.attachmentUrl(id(req), sub(req, 'fileId'), actorOf(req)))));
connectRouter.get('/channels/:id/history', h(async (req, res) => ok(res, await svc.channelHistory(id(req), actorOf(req)))));
