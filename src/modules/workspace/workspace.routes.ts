import { Router, type Request } from 'express';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { actorOf, objectId } from '../../common/query';
import { receive } from '../files/file.controller';
import * as svc from './workspace.service';
import { activityQuery, draftBody, noteEdit, notePayload, voicePayload } from './workspace.validators';

/** Project workspace: the event history, notes and voice notes of one project. */
export const workspaceRouter = Router();
workspaceRouter.use(authenticate, requirePermission('connect:use'));

const pid = (req: Request) => objectId.parse(req.params.projectId);
const sub = (req: Request, name: string) => objectId.parse(req.params[name]);
const uploaded = (req: Request) =>
  ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));
/** Multipart: the fields arrive as JSON in `payload`, the files as `files`. */
const payload = (req: Request): unknown => {
  if (typeof req.body?.payload !== 'string') return req.body;
  try {
    return JSON.parse(req.body.payload);
  } catch {
    throw AppError.badRequest('Invalid details');
  }
};
const h = asyncHandler;
const base = '/projects/:projectId';

workspaceRouter.get(base, h(async (req, res) => ok(res, await svc.overview(pid(req), actorOf(req)))));
workspaceRouter.get(`${base}/activity`, h(async (req, res) => ok(res, await svc.activity(pid(req), activityQuery.parse(req.query), actorOf(req)))));

workspaceRouter.get(`${base}/notes`, h(async (req, res) => ok(res, await svc.listNotes(pid(req), actorOf(req)))));
workspaceRouter.post(`${base}/notes`, receive, h(async (req, res) => ok(res, await svc.createNote(pid(req), notePayload.parse(payload(req)), uploaded(req), actorOf(req)), undefined, 201)));
workspaceRouter.patch(`${base}/notes/:noteId`, h(async (req, res) => ok(res, await svc.editNote(pid(req), sub(req, 'noteId'), noteEdit.parse(req.body), actorOf(req)))));
workspaceRouter.delete(`${base}/notes/:noteId`, h(async (req, res) => ok(res, await svc.deleteNote(pid(req), sub(req, 'noteId'), actorOf(req)))));
workspaceRouter.get(`${base}/notes/:noteId/files/:fileId/url`, h(async (req, res) => ok(res, await svc.noteFileUrl(pid(req), sub(req, 'noteId'), sub(req, 'fileId'), actorOf(req)))));
workspaceRouter.get(`${base}/note-draft`, h(async (req, res) => ok(res, await svc.getDraft(pid(req), actorOf(req)))));
workspaceRouter.put(`${base}/note-draft`, h(async (req, res) => ok(res, await svc.saveDraft(pid(req), draftBody.parse(req.body), actorOf(req)))));

workspaceRouter.get(`${base}/voice-notes`, h(async (req, res) => ok(res, await svc.listVoiceNotes(pid(req), actorOf(req)))));
workspaceRouter.post(`${base}/voice-notes`, receive, h(async (req, res) => ok(res, await svc.createVoiceNote(pid(req), voicePayload.parse(payload(req)), uploaded(req)[0], actorOf(req)), undefined, 201)));
workspaceRouter.delete(`${base}/voice-notes/:voiceId`, h(async (req, res) => ok(res, await svc.deleteVoiceNote(pid(req), sub(req, 'voiceId'), actorOf(req)))));
workspaceRouter.get(`${base}/voice-notes/:voiceId/url`, h(async (req, res) => ok(res, await svc.voiceNoteUrl(pid(req), sub(req, 'voiceId'), actorOf(req)))));
