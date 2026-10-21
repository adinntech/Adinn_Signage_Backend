import { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Project } from './project.model';
import { SurveyArea } from './surveyArea.model';

export const surveyAreaBody = z.object({
  area: z.string().trim().min(2, 'Enter the area or sales office name').max(120),
  notes: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)),
  shopsFound: z.number().int('Shops found must be a whole number').min(0).max(100000),
});


const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function requireAso(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('requirementType').lean();
  if (!p) throw AppError.notFound('Project not found');
  if (p.requirementType !== 'ASO') throw AppError.badRequest('Survey areas apply only to ASO projects');
}

export const listAreas = async (projectId: string) => {
  const p = await Project.exists({ _id: projectId, deletedAt: null });
  if (!p) throw AppError.notFound('Project not found');
  return SurveyArea.find({ project: projectId }).sort({ createdAt: -1 }).lean();
};

export async function createArea(projectId: string, body: z.infer<typeof surveyAreaBody>, actor: Actor) {
  await requireAso(projectId);
  if (await SurveyArea.exists({ project: projectId, areaKey: key(body.area) })) throw AppError.conflict(`"${body.area}" is already recorded for this project`);
  const a = await SurveyArea.create({ ...body, project: projectId, areaKey: key(body.area), createdBy: actor.id, updatedBy: actor.id });
  await recordAudit({ actor, action: 'CREATE', entity: 'SurveyArea', entityId: a._id, project: projectId });
  return a.toObject();
}

export async function updateArea(id: string, body: z.infer<typeof surveyAreaBody>, actor: Actor) {
  const a = await SurveyArea.findById(id);
  if (!a) throw AppError.notFound('Survey area not found');
  if (await SurveyArea.exists({ project: a.project, areaKey: key(body.area), _id: { $ne: id } })) throw AppError.conflict(`"${body.area}" is already recorded for this project`);
  a.set({ ...body, areaKey: key(body.area), updatedBy: actor.id });
  await a.save();
  await recordAudit({ actor, action: 'UPDATE', entity: 'SurveyArea', entityId: a._id, project: a.project });
  return a.toObject();
}

export async function deleteArea(id: string, actor: Actor) {
  const a = await SurveyArea.findByIdAndDelete(id);
  if (!a) throw AppError.notFound('Survey area not found');
  await recordAudit({ actor, action: 'DELETE', entity: 'SurveyArea', entityId: a._id, project: a.project });
}
