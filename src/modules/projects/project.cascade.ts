import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { AuditLog } from '../audit/auditLog.model';
import { CommunicationChannel, CommunicationMessage } from '../communications/communication.model';
import { Notification } from '../notifications/notification.model';
import { ImportBatch, ImportRow, Site } from '../sites/site.model';
import { Requirement, Project } from './project.model';
import { BoardOption } from '../boards/boardOption.model';
import { CostPlan } from '../costing/costing.model';
import { Expense } from '../expenses/expense.model';
import { SurveyArea } from './surveyArea.model';

/**
 * EVERYTHING that belongs to a project and must disappear with it.
 *
 * Add a line here for every new collection that stores a `project` reference (the skill `project-data-cascade`
 * explains the steps). A test fails if a model refers to Project and is missing from this list, so a new module
 * cannot silently leave test data behind.
 *
 * Stored FILES are erased separately, first (see removeProjectFiles), because they live in local storage or Spaces.
 */
export const PROJECT_OWNED: { name: string; model: Model<any>; field: string }[] = [
  { name: 'Shops', model: Site, field: 'project' },
  { name: 'Survey areas', model: SurveyArea, field: 'project' },
  { name: 'Board options', model: BoardOption, field: 'project' },
  { name: 'Cost plans', model: CostPlan, field: 'project' },
  { name: 'Expense claims', model: Expense, field: 'project' },
  { name: 'Requirements', model: Requirement, field: 'project' },
  { name: 'Chat messages', model: CommunicationMessage, field: 'project' },
  { name: 'Chat channels', model: CommunicationChannel, field: 'project' },
  { name: 'Notifications', model: Notification, field: 'project' },
  { name: 'Audit history', model: AuditLog, field: 'project' },
];

/** Models that hang off a project's child (not the project itself), listed so the coverage test knows they are handled. */
export const HANDLED_VIA_PARENT = ['ImportRow'];

/**
 * Deletes the project and every record that belongs to it. Returns how many records were removed per kind.
 * The caller must already have erased the stored files.
 */
export async function purgeProjectData(projectId: string): Promise<Record<string, number>> {
  const id = new Types.ObjectId(projectId);
  const removed: Record<string, number> = {};
  const batches = await ImportBatch.find({ project: id }).select('_id').lean();
  removed['Import rows'] = (await (ImportRow as Model<any>).deleteMany({ batch: { $in: batches.map((b) => b._id) } })).deletedCount ?? 0;
  removed['Import batches'] = (await ImportBatch.deleteMany({ project: id })).deletedCount ?? 0;
  for (const s of PROJECT_OWNED) removed[s.name] = (await s.model.deleteMany({ [s.field]: id })).deletedCount ?? 0;
  removed.Project = (await Project.deleteOne({ _id: id })).deletedCount ?? 0;
  return removed;
}

/**
 * Records whose project no longer exists (e.g. the project was deleted straight in MongoDB, which cannot run the cascade).
 * Counts them, and deletes them only when `apply` is true. Records with no project at all (unlinked inbox) are left alone.
 */
export async function sweepOrphanRecords(apply: boolean): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const gone = async (ids: unknown[]) => {
    const alive = new Set((await Project.find({ _id: { $in: ids } }).select('_id').lean()).map((p) => String(p._id)));
    return ids.filter((i) => !alive.has(String(i)));
  };
  for (const s of PROJECT_OWNED) {
    const missing = await gone((await s.model.distinct(s.field, { [s.field]: { $ne: null } })) as unknown[]);
    if (!missing.length) continue;
    out[s.name] = apply ? (await s.model.deleteMany({ [s.field]: { $in: missing } })).deletedCount ?? 0 : await s.model.countDocuments({ [s.field]: { $in: missing } });
  }
  const batchProjects = await gone(await ImportBatch.distinct('project'));
  if (batchProjects.length) {
    const batches = await (ImportBatch as Model<any>).find({ project: { $in: batchProjects } }).select("_id").lean();
    const ids = batches.map((b: { _id: unknown }) => b._id);
    out['Import rows'] = apply ? (await (ImportRow as Model<any>).deleteMany({ batch: { $in: ids } })).deletedCount ?? 0 : await (ImportRow as Model<any>).countDocuments({ batch: { $in: ids } });
    out['Import batches'] = apply ? (await ImportBatch.deleteMany({ _id: { $in: ids } })).deletedCount ?? 0 : ids.length;
  }
  return out;
}
