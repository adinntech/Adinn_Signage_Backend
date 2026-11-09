import { Router } from 'express';
import multer from 'multer';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import * as s from './mailContact.service';
import { bulkBody, contactBody, contactListQuery, contactPatch, suggestQuery } from './mailContact.validators';

const sheet = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(AppError.badRequest('Upload an .xlsx or .csv file'))),
}).single('file');

export const mailContactRouter = Router();
mailContactRouter.use(authenticate);
// Anyone who writes an email gets suggestions; only the admin manages the book.
mailContactRouter.get('/suggest', asyncHandler(async (req, res) => ok(res, await s.suggest(suggestQuery.parse(req.query)))));

mailContactRouter.use(requirePermission('mail:manage'));
mailContactRouter.get('/', asyncHandler(async (req, res) => {
  const r = await s.list(contactListQuery.parse(req.query));
  ok(res, r.items, r.meta);
}));
mailContactRouter.get('/groups', asyncHandler(async (_req, res) => ok(res, await s.groups())));
mailContactRouter.post('/bulk', asyncHandler(async (req, res) => ok(res, await s.bulk(bulkBody.parse(req.body), actorOf(req)))));
mailContactRouter.get('/sample', asyncHandler(async (_req, res) => {
  const f = await s.sampleSheet();
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', 'attachment; filename="mail-contacts-sample.xlsx"');
  res.send(f.buffer);
}));
mailContactRouter.post('/', asyncHandler(async (req, res) => ok(res, await s.create(contactBody.parse(req.body), actorOf(req)), undefined, 201)));
mailContactRouter.post('/import', sheet, asyncHandler(async (req, res) => ok(res, await s.importContacts(req.file && { originalname: req.file.originalname, buffer: req.file.buffer }, actorOf(req)))));
mailContactRouter.put('/:id', asyncHandler(async (req, res) => ok(res, await s.update(objectId.parse(req.params.id), contactPatch.parse(req.body), actorOf(req)))));
mailContactRouter.delete('/:id', asyncHandler(async (req, res) => {
  await s.remove(objectId.parse(req.params.id), actorOf(req));
  ok(res, { deleted: true });
}));
