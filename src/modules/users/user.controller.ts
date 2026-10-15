import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './user.service';
import { changeCredentialSchema, createUserSchema, lookupQuery, resetCredentialSchema, updateUserSchema, userListQuery } from './user.validators';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await s.listUsers(userListQuery.parse(req.query));
  ok(res, items, meta);
});
export const get = asyncHandler(async (req, res) => ok(res, await s.getUser(String(req.params.id))));
export const create = asyncHandler(async (req, res) => ok(res, await s.createUser(createUserSchema.parse(req.body), actorOf(req)), undefined, 201));
export const update = asyncHandler(async (req, res) => ok(res, await s.updateUser(String(req.params.id), updateUserSchema.parse(req.body), actorOf(req))));
export const resetCredential = asyncHandler(async (req, res) => {
  await s.resetCredential(String(req.params.id), resetCredentialSchema.parse(req.body), actorOf(req));
  ok(res, { reset: true });
});
export const remove = asyncHandler(async (req, res) => {
  await s.deleteUser(String(req.params.id), actorOf(req));
  ok(res, { deleted: true });
});
export const changeMyCredential = asyncHandler(async (req, res) => {
  await s.changeOwnCredential(actorOf(req), changeCredentialSchema.parse(req.body));
  ok(res, { changed: true });
});
export const lookup = asyncHandler(async (req, res) => ok(res, await s.lookupUsers(lookupQuery.parse(req.query))));
