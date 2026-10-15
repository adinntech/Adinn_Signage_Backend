import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './communication.service';
import * as v from './communication.validators';

const id = (req: { params: Record<string, string | string[] | undefined> }) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listMessages(v.messageListQuery.parse(req.query));
  ok(res, items, meta);
});
export const get = asyncHandler(async (req, res) => ok(res, await s.getMessage(id(req))));
export const create = asyncHandler(async (req, res) =>
  ok(res, await s.createMessage(v.messageCreate.parse(req.body), actorOf(req)), undefined, 201),
);
export const actioned = asyncHandler(async (req, res) => ok(res, await s.setActioned(id(req), v.actionedBody.parse(req.body), actorOf(req))));
export const requestApproval = asyncHandler(async (req, res) =>
  ok(res, await s.requestApproval(id(req), v.approvalRequestBody.parse(req.body), actorOf(req)), undefined, 201),
);
export const decide = asyncHandler(async (req, res) => ok(res, await s.decideApproval(id(req), v.approvalDecisionBody.parse(req.body), actorOf(req))));
export const createProject = asyncHandler(async (req, res) =>
  ok(res, await s.createProjectFromMail(id(req), v.createProjectFromMessage.parse(req.body), actorOf(req)), undefined, 201),
);

const pid = (req: { params: Record<string, string | string[] | undefined> }) => String(req.params.projectId);
const kind = (req: { params: Record<string, string | string[] | undefined> }) => v.channelKind.parse(String(req.params.kind).toUpperCase());
export const channels = asyncHandler(async (req, res) => ok(res, await s.listChannels(pid(req))));
export const putChannel = asyncHandler(async (req, res) =>
  ok(res, await s.upsertChannel(pid(req), kind(req), v.channelBody.parse(req.body), actorOf(req))),
);
export const intro = asyncHandler(async (req, res) => ok(res, await s.introMessage(pid(req), kind(req))));
