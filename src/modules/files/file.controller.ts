import path from 'node:path';
import multer from 'multer';
import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import { ALLOWED_EXTENSIONS, FILE_CATEGORIES } from './file.categories';
import * as svc from './file.service';
import { LocalStorage, contentDisposition, getStorageFor } from './storage';

const category = z.enum(FILE_CATEGORIES);

export const receive = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8', // browsers send file names as UTF-8; the default (latin1) turns Tamil/Hindi names into garbage
  limits: { fileSize: env.MAX_FILE_SIZE, files: 10 },
  fileFilter: (_req, file, cb) =>
    ALLOWED_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true)
      : cb(AppError.badRequest(`${file.originalname}: this file type is not allowed`)),
}).array('files', 10);

const pid = (req: Request) => objectId.parse(req.params.projectId);

export const upload = asyncHandler(async (req, res) => {
  const cat = category.parse(req.body?.category);
  const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));
  ok(res, await svc.uploadFiles(pid(req), cat, files, actorOf(req)), undefined, 201);
});

export const list = asyncHandler(async (req, res) => {
  const cat = req.query.category ? category.parse(req.query.category) : undefined;
  ok(res, await svc.listFiles(pid(req), actorOf(req), cat));
});

export const url = asyncHandler(async (req, res) => {
  const disposition = z.enum(['inline', 'attachment']).default('inline').parse(req.query.disposition);
  ok(res, await svc.fileUrl(objectId.parse(req.params.id), actorOf(req), disposition));
});

export const content = asyncHandler(async (req, res) => {
  const f = await svc.fileContent(objectId.parse(req.params.id), actorOf(req));
  res.setHeader('Content-Type', f.mimeType);
  res.setHeader('Content-Disposition', contentDisposition('inline', f.name));
  res.setHeader('Cache-Control', 'private, no-store');
  f.stream.on('error', () => res.destroy());
  f.stream.pipe(res);
});

/** The size limits and allowed types, so the web app checks files the moment they are picked, with the same numbers as the server. */
export const limits = asyncHandler(async (_req, res) => {
  ok(res, { maxFileBytes: env.MAX_FILE_SIZE, maxImageBytes: env.MAX_IMAGE_SIZE, maxVideoBytes: env.MAX_VIDEO_SIZE, extensions: ALLOWED_EXTENSIONS });
});

export const remove = asyncHandler(async (req, res) => {
  ok(res, await svc.removeFile(objectId.parse(req.params.id), actorOf(req)));
});

/** Local storage only: serves a file for a valid, unexpired signed link (browsers cannot send a bearer token from <img>). */
export const raw = asyncHandler(async (req, res) => {
  // Local files stay readable even after new uploads switch to Spaces.
  const storage = getStorageFor('local');
  if (!(storage instanceof LocalStorage)) throw AppError.notFound();
  const { key, exp, sig, dl } = z.object({ key: z.string().min(1).max(500), exp: z.coerce.number(), sig: z.string().min(1), dl: z.string().optional() }).parse(req.query);
  const name = storage.verify(key, exp, sig) ? await svc.liveFileName(key) : null;
  if (!name) throw AppError.forbidden('This link is invalid or has expired');
  let file: string;
  try {
    file = await storage.read(key);
  } catch {
    throw AppError.notFound('File not found');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  // Saved under the file's original name (not the stored, time-stamped one); dl=1 forces a download instead of showing it.
  res.setHeader('Content-Disposition', contentDisposition(dl === '1' ? 'attachment' : 'inline', name));
  // The web app on another origin shows these in <img> and <iframe> previews, so allow exactly that and nothing wider.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${env.corsOrigins.join(' ')}`);
  res.sendFile(file, { dotfiles: 'deny' });
});

const checkBody = z.object({
  category,
  files: z.array(z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid file hash') })).min(1).max(50),
});
export const check = asyncHandler(async (req, res) => {
  const b = checkBody.parse(req.body);
  ok(res, await svc.checkDuplicates(pid(req), b.category, b.files.map((f) => f.sha256.toLowerCase()), actorOf(req)));
});
