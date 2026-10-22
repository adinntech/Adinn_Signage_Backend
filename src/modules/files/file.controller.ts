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
import { LocalStorage, getStorageFor } from './storage';

const category = z.enum(FILE_CATEGORIES);

export const receive = multer({
  storage: multer.memoryStorage(),
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
  ok(res, await svc.fileUrl(objectId.parse(req.params.id), actorOf(req)));
});

export const remove = asyncHandler(async (req, res) => {
  ok(res, await svc.removeFile(objectId.parse(req.params.id), actorOf(req)));
});

/** Local storage only: serves a file for a valid, unexpired signed link (browsers cannot send a bearer token from <img>). */
export const raw = asyncHandler(async (req, res) => {
  // Local files stay readable even after new uploads switch to Spaces.
  const storage = getStorageFor('local');
  if (!(storage instanceof LocalStorage)) throw AppError.notFound();
  const { key, exp, sig } = z.object({ key: z.string().min(1).max(500), exp: z.coerce.number(), sig: z.string().min(1) }).parse(req.query);
  if (!storage.verify(key, exp, sig) || !(await svc.liveKey(key))) throw AppError.forbidden('This link is invalid or has expired');
  let file: string;
  try {
    file = await storage.read(key);
  } catch {
    throw AppError.notFound('File not found');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(file, { dotfiles: 'deny' });
});
