import multer from 'multer';
import type { Request } from 'express';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as imp from './import.service';
import * as svc from './site.service';
import * as v from './site.validators';
import { SCENARIOS } from './site.fields';

const p = (req: Request, k = 'projectId') => String(req.params[k]);
export const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    /\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(AppError.badRequest('Only .xlsx or .csv files are allowed')),
}).single('file');

function checkContent(file: Express.Multer.File) {
  const xlsx = /\.xlsx$/i.test(file.originalname);
  const isZip = file.buffer.length > 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
  if (xlsx && !isZip) throw AppError.badRequest('This is not a valid .xlsx file');
  if (!xlsx && file.buffer.subarray(0, 4096).includes(0)) throw AppError.badRequest('This is not a valid .csv file');
}

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await svc.listSites(p(req), v.siteListQuery.parse(req.query));
  ok(res, items, meta);
});
export const stats = asyncHandler(async (req, res) => ok(res, await svc.siteStats(p(req))));
export const create = asyncHandler(async (req, res) => ok(res, await svc.createSite(p(req), v.siteCreate.parse(req.body), actorOf(req)), undefined, 201));
export const update = asyncHandler(async (req, res) => ok(res, await svc.updateSite(p(req, 'id'), v.sitePatch.parse(req.body), actorOf(req))));
export const remove = asyncHandler(async (req, res) => { await svc.deleteSite(p(req, 'id'), actorOf(req)); ok(res, { deleted: true }); });
export const duplicate = asyncHandler(async (req, res) => ok(res, await svc.duplicateSite(p(req, 'id'), actorOf(req)), undefined, 201));
export const bulk = asyncHandler(async (req, res) => ok(res, await svc.bulk(p(req), v.bulkBody.parse(req.body), actorOf(req))));

const send = (res: import('express').Response, buffer: Buffer, fileName: string) => {
  const safe = fileName.replace(/[^\w.\-]/g, '_');
  res.setHeader('Content-Type', safe.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
};
export const exportFile = asyncHandler(async (req, res) => {
  const r = await svc.exportSites(p(req), v.exportQuery.parse(req.query));
  send(res, r.buffer, r.fileName);
});
export const template = asyncHandler(async (req, res) => {
  const sc = SCENARIOS.find((s) => s === req.query.scenario) ?? 'MEASUREMENT_REQUIRED';
  send(res, await svc.templateFile(sc), sc === 'CLIENT_PROVIDED' ? 'site-template-scenario2.xlsx' : 'site-template-scenario1.xlsx');
});

export const imports = asyncHandler(async (req, res) => ok(res, await imp.listImports(p(req))));
export const uploadSheet = asyncHandler(async (req, res) => {
  if (!req.file) throw AppError.badRequest('Attach a file in the "file" field');
  checkContent(req.file);
  ok(res, await imp.uploadSheet(p(req), req.file, actorOf(req)), undefined, 201);
});
export const extractFromFile = asyncHandler(async (req, res) => ok(res, await imp.uploadFromProjectFile(p(req), v.fromFileBody.parse(req.body).fileId, actorOf(req)), undefined, 201));
export const getImport = asyncHandler(async (req, res) => ok(res, await imp.getImport(p(req), p(req, 'batchId'))));
export const preview = asyncHandler(async (req, res) => ok(res, await imp.previewImport(p(req), p(req, 'batchId'), v.previewBody.parse(req.body))));
export const rows = asyncHandler(async (req, res) => {
  const { items, meta } = await imp.listRows(p(req), p(req, 'batchId'), v.rowListQuery.parse(req.query));
  ok(res, items, meta);
});
export const patchRow = asyncHandler(async (req, res) => ok(res, await imp.patchRow(p(req), p(req, 'batchId'), p(req, 'rowId'), v.rowPatch.parse(req.body))));
export const commit = asyncHandler(async (req, res) => ok(res, await imp.commitImport(p(req), p(req, 'batchId'), v.commitBody.parse(req.body ?? {}), actorOf(req))));
export const discard = asyncHandler(async (req, res) => { await imp.discardImport(p(req), p(req, 'batchId')); ok(res, { discarded: true }); });
