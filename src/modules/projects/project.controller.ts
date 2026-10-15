import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './project.service';
import { projectCreate, projectListQuery, projectPatch, requirementBody, statusBody } from './project.validators';

const id = (req: { params: Record<string, string | string[] | undefined> }) => String(req.params.id);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listProjects(projectListQuery.parse(req.query));
  ok(res, items, meta);
});
export const summary = asyncHandler(async (_req, res) => ok(res, await s.projectSummary()));
export const get = asyncHandler(async (req, res) => ok(res, await s.getProject(id(req))));
export const create = asyncHandler(async (req, res) =>
  ok(res, await s.createProject(projectCreate.parse(req.body), actorOf(req)), undefined, 201),
);
export const update = asyncHandler(async (req, res) =>
  ok(res, await s.updateProject(id(req), projectPatch.parse(req.body), actorOf(req))),
);
export const status = asyncHandler(async (req, res) => {
  const b = statusBody.parse(req.body);
  ok(res, await s.changeStatus(id(req), b.status, b.reason, actorOf(req)));
});
export const getRequirement = asyncHandler(async (req, res) => {
  await s.getProject(id(req));
  ok(res, await s.getRequirement(id(req)));
});
export const putRequirement = asyncHandler(async (req, res) =>
  ok(res, await s.upsertRequirement(id(req), requirementBody.parse(req.body), actorOf(req))),
);
export const history = asyncHandler(async (req, res) => {
  await s.getProject(id(req));
  ok(res, await s.projectHistory(id(req)));
});
