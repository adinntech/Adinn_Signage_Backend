import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './client.service';
import { clientBody, clientListQuery, clientPatch, clientRegistration } from './client.validators';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listClients(clientListQuery.parse(req.query));
  ok(res, items, meta);
});
export const summary = asyncHandler(async (_req, res) => ok(res, await s.clientSummary()));
export const get = asyncHandler(async (req, res) => ok(res, await s.getClientDetails(String(req.params.id))));
export const create = asyncHandler(async (req, res) =>
  ok(res, await s.createClient(clientBody.parse(req.body), actorOf(req)), undefined, 201),
);
/** Client Management "Add Client": company + contacts only (orders are created separately in Order Management). */
export const register = asyncHandler(async (req, res) =>
  ok(res, (await s.registerCompany(clientRegistration.parse(req.body), actorOf(req))).toObject(), undefined, 201),
);
export const update = asyncHandler(async (req, res) =>
  ok(res, await s.updateClient(String(req.params.id), clientPatch.parse(req.body), actorOf(req))),
);
export const remove = asyncHandler(async (req, res) => {
  await s.deleteClient(String(req.params.id), actorOf(req));
  ok(res, { deleted: true });
});
