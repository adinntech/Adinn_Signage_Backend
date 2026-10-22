import type { Request } from 'express';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './template.service';
import { templateBody, templateKey } from './template.validators';

const key = (req: Request) => {
  const r = templateKey.safeParse(req.params.key);
  if (!r.success) throw AppError.notFound('Template not found');
  return r.data;
};
const firstFile = (req: Request) => {
  const f = (req.files as Express.Multer.File[] | undefined)?.[0];
  return f && { originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer };
};

export const get = asyncHandler(async (req, res) => ok(res, await s.getTemplate(key(req))));
export const update = asyncHandler(async (req, res) => ok(res, await s.updateTemplate(key(req), templateBody.parse(req.body), actorOf(req))));
export const restore = asyncHandler(async (req, res) => ok(res, await s.restoreDefault(key(req), actorOf(req))));
export const uploadPdf = asyncHandler(async (req, res) => ok(res, await s.setTemplatePdf(key(req), firstFile(req), actorOf(req))));
export const pdfUrl = asyncHandler(async (req, res) => ok(res, await s.templatePdfUrl(key(req))));
export const removePdf =asyncHandler(async (req, res) => ok(res, await s.removeTemplatePdf(key(req), actorOf(req))));
export const history = asyncHandler(async (req, res) => ok(res, await s.templateHistory(key(req))));
