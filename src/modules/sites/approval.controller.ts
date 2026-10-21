import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import * as a from './approval.service';

export const set = asyncHandler(async (req, res) => ok(res, await a.setApproval(objectId.parse(req.params.id), a.approvalBody.parse(req.body), actorOf(req))));
export const approveAll = asyncHandler(async (req, res) =>
  ok(res, await a.approveAllPending(objectId.parse(req.params.projectId), a.approveAllBody.parse(req.body).level, actorOf(req))),);
