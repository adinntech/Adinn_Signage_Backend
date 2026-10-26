import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { AppError } from './errors';
import type { Actor } from './query';
import { Project } from '../modules/projects/project.model';
import { Site } from '../modules/sites/site.model';

/**
 * Operations and coordinators work only on projects BD has assigned to them. Recce executives work on projects assigned to
 * them (an ASO survey) and on projects that have in-house shops to visit. Everyone else with project access (BD, admin,
 * management, finance) is not narrowed here. A project outside the scope is reported as "not found" so its existence is
 * not revealed.
 */
export const SCOPED_ROLES = new Set(['OPERATIONS', 'RECCE_COORDINATOR', 'RECCE_EXECUTIVE']);
export const isScoped = (role: string) => SCOPED_ROLES.has(role);

/** Mongo filter to merge into project queries for this person. */
export async function projectScope(actor: Actor): Promise<Record<string, unknown>> {
  if (!isScoped(actor.role)) return {};
  const me = new Types.ObjectId(actor.id);
  if (actor.role !== 'RECCE_EXECUTIVE') return { assignedTo: me };
  const inHouse = await Site.distinct('project', { channel: 'IN_HOUSE', deletedAt: null });
  return { $or: [{ assignedTo: me }, { _id: { $in: inHouse } }] };
}

export async function assertProjectAccess(actor: Actor, projectId: string) {
  if (!isScoped(actor.role)) return;
  if (!Types.ObjectId.isValid(projectId)) throw AppError.notFound('Project not found');
  const ok = await Project.exists({ _id: projectId, deletedAt: null, ...(await projectScope(actor)) });
  if (!ok) throw AppError.notFound('Project not found');
}

const actorOfReq = (req: Request): Actor => ({ id: req.auth!.sub, role: req.auth!.role });

/** Route guard for paths that carry a project id (`:projectId` or `:id`). Place after `authenticate`. */
export const scopeProject =
  (param: 'projectId' | 'id' = 'projectId') =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(AppError.unauthorized());
    assertProjectAccess(actorOfReq(req), String(req.params[param])).then(() => next(), next);
  };

/** Route guard for paths keyed by a site id (`/sites/:id/...`). */
export const scopeSite = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!req.auth) return next(AppError.unauthorized());
    if (!isScoped(req.auth.role)) return next();
    const id = String(req.params.id);
    const site = Types.ObjectId.isValid(id) ? await Site.findOne({ _id: id, deletedAt: null }).select('project').lean() : null;
    if (!site) throw AppError.notFound('Site not found');
    await assertProjectAccess(actorOfReq(req), String(site.project));
    next();
  } catch (e) {
    next(e);
  }
};

/** A cancelled project is read-only: no shop edits, imports, approvals, survey areas or uploads. */
export async function assertNotCancelled(projectId: string | Types.ObjectId) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('status').lean();
  if (p?.status === 'CANCELLED') throw AppError.conflict('This project was cancelled, so it can no longer be changed');
  if (p?.status === 'LOSS') throw AppError.conflict('This project is marked as a loss, so it can no longer be changed');
}
