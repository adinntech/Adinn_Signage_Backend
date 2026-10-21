import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const ok = (res: Response, data: unknown, meta?: unknown, status = 200) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  if ((err as { name?: string })?.name === 'MulterError') {
    const code = (err as { code?: string }).code;
    return res.status(code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: { code: code ?? 'UPLOAD_ERROR', message: code === 'LIMIT_FILE_SIZE' ? 'File is too large' : code === 'LIMIT_FILE_COUNT' ? 'Too many files in one upload (max 10)' : 'Invalid upload' } });
  }
  if ((err as { code?: number })?.code === 11000) {
    return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'A record with the same unique value already exists' } });
  }
  if ((err as { name?: string })?.name === 'CastError') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid identifier' } });
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ success: false, error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  console.error(err);
  res
    .status(500)
    .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}

export const notFoundHandler = (_req: Request, res: Response) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });



