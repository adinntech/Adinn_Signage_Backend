import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import { projectNotificationLog } from '../notifications/notification.service';
import { shopRowsQuery } from '../sales/sales.validators';
import * as bd from './bdHandover.service';
import * as s from './project.service';
import * as areaSvc from './surveyArea.service';
import { additionalShopsBody, assignBody, projectCreate, projectListQuery, projectPatch, requirementBody, stageBody, statusBody } from './project.validators';

const id = (req: { params: Record<string, string | string[] | undefined> }) => String(req.params.id);

/** BD handover of a project created from Lead Management (null for other projects). */
export const bdHandover = asyncHandler(async (req, res) => ok(res, await bd.projectHandover(id(req))));
export const bdHandoverShops = asyncHandler(async (req, res) => {
  const { items, meta } = await bd.projectHandoverShops(id(req), shopRowsQuery.parse(req.query));
  ok(res, items, meta);
});
export const bdHandoverShopsExport = asyncHandler(async (req, res) => {
  const f = await bd.projectHandoverShopsExport(id(req));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(f.buffer);
});
export const bdHandoverFileUrl = asyncHandler(async (req, res) => ok(res, await bd.projectHandoverFileUrl(id(req), objectId.parse(req.params.fileId))));

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listProjects(projectListQuery.parse(req.query), actorOf(req));
  ok(res, items, meta);
});
export const summary = asyncHandler(async (req, res) => ok(res, await s.projectSummary(actorOf(req))));
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

export const remove = asyncHandler(async (req, res) => ok(res, await s.deleteProject(id(req), actorOf(req))));
export const assignees = asyncHandler(async (_req, res) => ok(res, await s.listAssignees()));
export const assign = asyncHandler(async (req, res) => ok(res, await s.assignProject(id(req), assignBody.parse(req.body), actorOf(req))));
export const stage = asyncHandler(async (req, res) => ok(res, await s.advanceStage(id(req), stageBody.parse(req.body), actorOf(req))));

export const areas = asyncHandler(async (req, res) => ok(res, await areaSvc.listAreas(id(req))));
export const areaCreate = asyncHandler(async (req, res) =>
  ok(res, await areaSvc.createArea(id(req), areaSvc.surveyAreaBody.parse(req.body), actorOf(req)), undefined, 201),
);
export const areaUpdate = asyncHandler(async (req, res) =>
  ok(res, await areaSvc.updateArea(String(req.params.areaId), areaSvc.surveyAreaBody.parse(req.body), actorOf(req))),
);
export const areaDelete = asyncHandler(async (req, res) => {
  await areaSvc.deleteArea(String(req.params.areaId), actorOf(req));
  ok(res, { id: String(req.params.areaId) });
});

export const activity = asyncHandler(async (req, res) => ok(res, await s.recentActivity(actorOf(req))));
export const notificationLog = asyncHandler(async (req, res) => {
  await s.getProject(id(req));
  ok(res, await projectNotificationLog(id(req)));
});

export const additionalShops = asyncHandler(async (req, res) => ok(res, await s.setAdditionalShops(id(req), additionalShopsBody.parse(req.body), actorOf(req))));
