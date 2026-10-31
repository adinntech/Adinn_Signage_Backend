import { Types } from 'mongoose';
import { clientNameOf } from '../clients/clientDetails';
import { Project } from '../projects/project.model';
import { User } from '../users/user.model';
import { notify } from './notification.service';
import type { AuditInput } from '../audit/auditLog.model';

const VERB: Record<string, string> = {
  CREATE: 'added',
  UPDATE: 'updated',
  DELETE: 'deleted',
  DUPLICATE: 'duplicated',
  BULK_UPDATE: 'bulk-updated',
  BULK_DELETE: 'bulk-deleted',
  APPROVAL: 'updated the approval of',
  ASSIGN: 'assigned',
  STATUS_CHANGE: 'changed the status of',
  UPLOAD: 'uploaded',
  IMPORT_SITES: 'imported',
};
const NOUN: Record<string, string> = {
  Project: 'the project',
  Site: 'a shop',
  SurveyArea: 'a survey area',
  FileAsset: 'a document',
  Requirement: 'the requirements',
  ImportBatch: 'shops',
};
const TITLE_NOUN: Record<string, string> = { Project: 'Project', Site: 'Shop', SurveyArea: 'Survey area', FileAsset: 'Document', Requirement: 'Requirements', ImportBatch: 'Shops' };
const PAST: Record<string, string> = { CREATE: 'added', UPDATE: 'updated', DELETE: 'deleted', DUPLICATE: 'duplicated', BULK_UPDATE: 'bulk updated', BULK_DELETE: 'bulk deleted', APPROVAL: 'approval changed', UPLOAD: 'uploaded' };
const ROLE: Record<string, string> = { BD: 'BD', OPERATIONS: 'Operations', RECCE_COORDINATOR: 'Coordinator', SUPER_ADMIN: 'Admin', CLIENT_SERVICING: 'Client Servicing', FINANCE: 'Accounts' };

/** These already send their own, more specific notification to the other side, so only Admin gets the generic one. */
function alreadyAnnounced(i: AuditInput) {
  if (['ASSIGN', 'STATUS_CHANGE', 'IMPORT_SITES'].includes(i.action)) return true;
  if (i.action === 'UPLOAD') return i.changes?.some((c) => c.field === 'category' && c.newValue === 'BD_CLIENT_DETAILS') ?? false;
  if (i.action === 'APPROVAL') return i.changes?.some((c) => c.newValue === 'CORRECTION') ?? false;
  return false;
}

/**
 * Every recorded action (create, edit, delete, upload, approval ...) is announced to the people on the project:
 * the Operations assignee and the BD owner. Super Admin is told about everything everyone does, in the app only.
 * Never throws, so it cannot fail the action that caused it.
 */
export async function announceActivity(i: AuditInput, auditId: Types.ObjectId | string): Promise<void> {
  try {
    if (!i.project) return;
    const p = await Project.findOne({ _id: i.project, deletedAt: null }).select('code client clientDetails owner createdBy assignedTo').lean();
    if (!p) return;
    const [who, clientName, admins] = await Promise.all([
      User.findById(i.actor.id).select('name').lean(),
      clientNameOf(p),
      User.find({ role: 'SUPER_ADMIN', isActive: true, deletedAt: null }).select('_id').lean(),
    ]);
    const fields = i.entity === 'Project' && i.action === 'UPDATE' && i.changes?.length ? ` (${i.changes.map((c) => c.field).join(', ')})` : '';
    const verb = VERB[i.action] ?? i.action.toLowerCase().replace(/_/g, ' ');
    const noun = NOUN[i.entity] ?? i.entity;
    const title = `${TITLE_NOUN[i.entity] ?? i.entity} ${PAST[i.action] ?? verb}`;
    const body = `${who?.name ?? 'Someone'} (${ROLE[i.actor.role] ?? i.actor.role}) ${verb} ${noun}${fields} in ${p.code}${clientName ? ` · ${clientName}` : ''}${i.reason ? `: ${i.reason}` : ''}.`;
    const project = { _id: p._id, code: p.code, clientName: client?.name };
    const base = { title: `${p.code}: ${title}`, body, project, actorId: i.actor.id };
    if (!alreadyAnnounced(i)) {
      await notify({ ...base, kind: 'ACTIVITY', recipients: [p.assignedTo, p.owner ?? p.createdBy], dedupe: (r) => `activity:${auditId}:${r}` });
    }
    await notify({ ...base, kind: 'ADMIN_ACTIVITY', recipients: admins.map((a) => a._id), dedupe: (r) => `admin-activity:${auditId}:${r}` });
  } catch (e) {
    console.error('activity notification failed', e);
  }
}
