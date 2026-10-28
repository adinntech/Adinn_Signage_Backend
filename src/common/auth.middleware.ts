import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';
import { verifyAccess, type AccessPayload } from '../modules/auth/auth.service';
import { permissionsFor, type Permission, type Role } from '../modules/roles/roles';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessPayload;
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return next(AppError.unauthorized());
  try {
    req.auth = verifyAccess(header.slice(7));
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (req.auth.role === 'SUPER_ADMIN' || roles.includes(req.auth.role)) return next();
    next(AppError.forbidden());
  };

export const requirePermission =
  (...perms: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(AppError.unauthorized());
    const have = permissionsFor(req.auth.role);
    if (perms.every((p) => have.includes(p))) return next();
    next(AppError.forbidden());
  };

/** Allows the request when the role has at least ONE of the permissions (requirePermission needs all of them). */
export const requireAnyPermission =
  (...perms: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(AppError.unauthorized());
    const have = permissionsFor(req.auth.role);
    if (perms.some((p) => have.includes(p))) return next();
    next(AppError.forbidden());
  };
