import { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import type { Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { learn } from '../mailContacts/mailContact.service';
import { MailRouting, ROUTING_KEYS, type RoutingKey } from './mailRouting.model';
import type { routingBody } from './mailRouting.validators';

export interface Routing {
  key: RoutingKey;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  autoConfirm: boolean;
  /** True when nobody has saved it yet (the recipients are empty, or the old env list). */
  isDefault: boolean;
}

/** The audit log needs an ObjectId; one fixed id per routing key. */
const auditId = (key: RoutingKey) => new Types.ObjectId(Buffer.from(key.padEnd(12, '_').slice(0, 12)).toString('hex'));

export const LABELS: Record<RoutingKey, string> = { PROJECT_CODE: 'Project code request', CLIENT_CODE: 'Client code request', VENDOR_REGISTRATION: 'Vendor registration request', VENDOR_RATE_APPROVAL: 'Vendor amount approval request' };

const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ENV_TO: Record<RoutingKey, () => string[]> = {
  PROJECT_CODE: () => list(env.CODE_REQUEST_PROJECT_RECIPIENTS),
  CLIENT_CODE: () => list(env.CODE_REQUEST_CLIENT_RECIPIENTS),
  VENDOR_REGISTRATION: () => list(env.VENDOR_REGISTRATION_RECIPIENTS),
  VENDOR_RATE_APPROVAL: () => [],
};
/** No address is built into the code: until the Super Admin saves the recipients (Admin > Mail settings) only the old env list is used, else the lists are empty. */
const fallback = (key: RoutingKey) => ({ to: ENV_TO[key](), cc: [] as string[] });

/** The recipients for one kind of mail: what was saved, else the old env list, else empty. */
export async function routingOf(key: RoutingKey): Promise<Routing> {
  const row = await MailRouting.findById(key).lean();
  if (row) return { key, to: row.to, cc: row.cc, bcc: row.bcc, replyTo: row.replyTo ?? env.IMAP_USER ?? null, autoConfirm: !!row.autoConfirm, isDefault: false };
  return { key, ...fallback(key), bcc: [], replyTo: env.IMAP_USER ?? null, autoConfirm: false, isDefault: true };
}

export async function listRouting() {
  const rows = await MailRouting.find().lean();
  return ROUTING_KEYS.map((key) => {
    const row = rows.find((r) => r._id === key);
    return { ...(row ? { key, to: row.to, cc: row.cc, bcc: row.bcc, replyTo: row.replyTo ?? env.IMAP_USER ?? null, autoConfirm: !!row.autoConfirm, isDefault: false } : { key, ...fallback(key), bcc: [], replyTo: env.IMAP_USER ?? null, autoConfirm: false, isDefault: true }), label: LABELS[key] };
  });
}

export async function saveRouting(key: RoutingKey, input: z.infer<typeof routingBody>, actor: Actor) {
  const before = await routingOf(key);
  await MailRouting.updateOne({ _id: key }, { $set: { to: input.to, cc: input.cc, bcc: input.bcc, replyTo: input.replyTo ?? null, autoConfirm: input.autoConfirm, updatedBy: actor.id } }, { upsert: true });
  await learn([...input.to, ...input.cc, ...input.bcc, ...(input.replyTo ? [input.replyTo] : [])]);
  await recordAudit({
    actor,
    action: 'MAIL_ROUTING_UPDATED',
    entity: 'MailRouting',
    entityId: auditId(key),
    reason: `${LABELS[key]}: to ${input.to.join(', ')}; cc ${input.cc.join(', ') || '-'}`,
    changes: [
      { field: 'to', oldValue: before.to.join(', '), newValue: input.to.join(', ') },
      { field: 'cc', oldValue: before.cc.join(', '), newValue: input.cc.join(', ') },
    ],
  });
  return (await listRouting()).find((r) => r.key === key)!;
}
