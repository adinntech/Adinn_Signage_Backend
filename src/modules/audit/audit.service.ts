import { AuditLog, type AuditInput } from './auditLog.model';

export const recordAudit = (i: AuditInput) =>
  AuditLog.create({
    user: i.actor.id,
    role: i.actor.role,
    action: i.action,
    entity: i.entity,
    entityId: i.entityId,
    project: i.project,
    changes: i.changes ?? [],
    reason: i.reason,
  });

const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** Field-level diff of `fields` between a plain-object snapshot and the patch actually applied. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]) {
  return fields
    .filter((f) => f in after && !same(before[f], after[f]))
    .map((f) => ({ field: f, oldValue: norm(before[f]), newValue: norm(after[f]) }));
}

export const listAudit = (filter: Record<string, unknown>, limit = 100) =>
  AuditLog.find(filter).sort({ at: -1 }).limit(limit).populate('user', 'name role').lean();
