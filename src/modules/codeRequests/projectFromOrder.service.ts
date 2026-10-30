import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { Client } from '../clients/client.model';
import { CommunicationMessage } from '../communications/communication.model';
import { Project, Requirement } from '../projects/project.model';
import { createProject } from '../projects/project.service';
import { projectCreate } from '../projects/project.validators';
import { HANDOVER_TYPE_LABELS } from '../sales/handover.service';
import { liveOrder, pipelineLog } from '../sales/order.service';
import { SalesOrder, type HandoverType } from '../sales/sales.model';
import { CodeRequest } from './codeRequest.model';
import { assertCodeActor } from './codeRequest.service';
import type { csProjectBody } from './codeRequest.validators';

const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);

/** Both codes confirmed, or why not. The project code is the confirmed 8-digit number (or the one the BD saved on the order). */
async function codesOf(o: Awaited<ReturnType<typeof liveOrder>>) {
  const client = await Client.findById(o.client).select('name approvedCode contacts').lean();
  if (!client) throw AppError.notFound('Client not found');
  const row = await CodeRequest.findOne({ order: o._id, kind: 'PROJECT_CODE', status: 'CONFIRMED' }).select('confirmedCode').lean();
  return { client, clientCode: client.approvedCode ?? null, projectCode: row?.confirmedCode ?? o.recce?.projectCode ?? null };
}

/**
 * What the Create Project screen shows before the form: the order, both confirmed codes, the BD's handover details
 * (type, shops, notes, documents) and the client contacts, so Client Servicing only completes what is missing.
 */
export async function projectDraft(orderId: string, actor: Actor) {
  assertCodeActor(actor);
  const o = await SalesOrder.findOne({ _id: orderId, deletedAt: null })
    .select('orderNo client handoverType handoverNotes declaredShopTotal shopList.total recce.project recce.assignee handoverDocumentsArray.name handoverShopsArray.fileId')
    .lean();
  if (!o) throw AppError.notFound('Order not found');
  const live = await liveOrder(orderId);
  const { client, clientCode, projectCode } = await codesOf(live);
  const existing = await Project.findOne({ salesOrder: o._id, deletedAt: null }).select('code status').lean();
  const type = (o.handoverType ?? null) as HandoverType | null;
  const missing: string[] = [];
  if (!clientCode) missing.push('Confirm the client code');
  if (!projectCode) missing.push('Confirm the project code');
  return {
    order: { _id: String(o._id), orderNo: o.orderNo },
    client: { _id: String(client._id), name: client.name },
    codes: { client: clientCode, project: projectCode },
    ready: missing.length === 0 && !existing,
    missing,
    project: existing ? { _id: String(existing._id), code: existing.code, status: existing.status } : null,
    handover: {
      type,
      typeLabel: type ? HANDOVER_TYPE_LABELS[type] : null,
      notes: o.handoverNotes ?? '',
      shops: type === 'ASO' ? null : (o.declaredShopTotal ?? o.shopList?.total ?? null),
      documents: (o.handoverDocumentsArray ?? []).length,
    },
    contacts: (client.contacts ?? []).map((k) => ({ name: k.name, email: k.email ?? '', phone: k.phone ?? '' })),
  };
}

/** Removes a project created for an assignment that did not go through. */
const dropProject = (id: Types.ObjectId | string) => Promise.all([Project.deleteOne({ _id: id }), Requirement.deleteMany({ project: id }), CommunicationMessage.deleteMany({ project: id })]);

/**
 * Client Servicing creates the operations project from a handed-over order once both codes are confirmed: the code is the
 * confirmed project code and the project is linked to the order. It is assigned afterwards on the Recce Assignment screen.
 */
export async function createFromOrder(orderId: string, input: z.infer<typeof csProjectBody>, actor: Actor) {
  assertCodeActor(actor);
  const o = await liveOrder(orderId);
  if (o.recce?.project || (await Project.exists({ salesOrder: o._id, deletedAt: null }))) throw AppError.conflict('A project was already created for this order.');
  const { client, clientCode, projectCode } = await codesOf(o);
  if (!clientCode) throw AppError.conflict('Confirm the client code first.');
  if (!projectCode) throw AppError.conflict('Confirm the project code first.');

  const parsed = projectCreate.safeParse({
    clientId: String(o.client),
    code: projectCode,
    campaign: input.campaign,
    name: `${client.name} - ${input.campaign}`,
    priority: input.priority,
    startDate: input.startDate,
    targetDate: input.targetDate,
    district: input.district,
    instructions: input.instructions,
    requirementType: input.requirementType,
    expectedShops: input.requirementType === 'ASO' ? null : input.expectedShops,
    contacts: input.contacts,
    ownerId: o.owner ? String(o.owner) : undefined,
    status: 'NEW',
    requirement: {
      source: 'OTHER',
      sourceNote: `Client Servicing: order ${o.orderNo}`,
      description: input.instructions,
      recceRequired: true,
      siteDataScenario: input.requirementType === 'SHOP_MEASUREMENT' ? 'CLIENT_PROVIDED' : 'MEASUREMENT_REQUIRED',
    },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalid(String(issue.path[0] ?? 'project'), issue.message);
  }

  const project = await createProject(parsed.data, actor);
  const projectId = project._id as Types.ObjectId;
  try {
    await Project.updateOne({ _id: projectId }, { $set: { salesOrder: o._id } });
  } catch (e) {
    await dropProject(projectId);
    throw e;
  }
  const r = await SalesOrder.updateOne(
    { _id: o._id, $or: [{ recce: null }, { 'recce.project': null }] },
    {
      $set: { recce: { ...(o.toObject().recce ?? {}), project: projectId, projectCode }, updatedBy: actor.id },
      $push: { salespipelineLogs: pipelineLog(actor, 'HANDOVER', o.stage, o.stage, `Project ${projectCode} created by Client Servicing`) },
    },
  );
  if (!r.modifiedCount) {
    await dropProject(projectId);
    throw AppError.conflict('A project was created for this order meanwhile. Reload the page.');
  }
  await recordAudit({ actor, action: 'ASSIGN', entity: 'SalesOrder', entityId: o._id, changes: [{ field: 'recce.project', oldValue: null, newValue: String(projectId) }], reason: `Project ${projectCode} created by Client Servicing` });
  return { projectId: String(projectId), code: projectCode };
}
