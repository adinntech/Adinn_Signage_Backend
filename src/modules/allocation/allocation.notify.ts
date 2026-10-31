import { Types } from 'mongoose';
import { clientNameOf } from '../clients/clientDetails';
import { notify } from '../notifications/notification.service';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';
import type { Actor } from '../../common/query';

/** Who is told about the new shops, and what "all of theirs" means for the running total in the message. */
export type ShopTarget =
  | { kind: 'USERS'; userIds: string[] } // an ASO survey given straight to recce staff
  | { kind: 'VENDOR'; vendorId: string }
  | { kind: 'IN_HOUSE' };

/**
 * Tells the recce person or vendor that more shops were added to a job they already have, e.g. "5 new shops added, you now
 * have 13". Called when Operations adds shops to an assigned ASO job, or allocates more shops to a vendor / the in-house team.
 * The person who made the change is never notified. Never throws: a failed notification must not undo the shop change.
 */
export async function notifyNewShops(projectId: string, target: ShopTarget, added: number, actor: Actor): Promise<void> {
  try {
    if (added < 1) return;
    const project = await Project.findOne({ _id: projectId, deletedAt: null }).select('code client clientDetails').lean();
    if (!project) return;
    const base = { project: new Types.ObjectId(projectId), deletedAt: null };
    let recipients: unknown[];
    let total: number;
    if (target.kind === 'USERS') {
      recipients = target.userIds;
      total = await Site.countDocuments(base);
    } else if (target.kind === 'VENDOR') {
      recipients = (await User.find({ role: 'VENDOR', vendorId: target.vendorId, isActive: true, deletedAt: null }).select('_id').lean()).map((u) => u._id);
      total = await Site.countDocuments({ ...base, channel: 'VENDOR', vendor: target.vendorId });
    } else {
      // The in-house team has no one-to-one assignment yet, so every active recce executive hears about it.
      recipients = (await User.find({ role: 'RECCE_EXECUTIVE', isActive: true, deletedAt: null }).select('_id').lean()).map((u) => u._id);
      total = await Site.countDocuments({ ...base, channel: 'IN_HOUSE' });
    }
    if (!recipients.length) return;
    const client = { name: await clientNameOf(project) };
    const s = (n: number) => `${n} shop${n === 1 ? '' : 's'}`;
    const first = total <= added;
    const when = Date.now();
    await notify({
      kind: 'SHOPS_ADDED',
      recipients: recipients as never[],
      title: first ? `New shops assigned: ${project.code}` : `${s(added)} added: ${project.code}`,
      body: first
        ? `${s(added)} in project ${project.code}${client?.name ? ` (${client.name})` : ''} are assigned to you.`
        : `${s(added)} were added to project ${project.code}${client?.name ? ` (${client.name})` : ''}. You now have ${s(total)} in this project.`,
      project: { _id: project._id, code: project.code, clientName: client?.name },
      actorId: actor.id,
      dedupe: (r) => `shops-added:${projectId}:${r}:${when}`,
    });
  } catch (e) {
    console.error('shops-added notification failed', e);
  }
}
