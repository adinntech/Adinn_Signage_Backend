import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { Client } from '../clients/client.model';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';

export const shopsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const projectParam = z.object({ projectId: objectId });

/** The vendor company this login belongs to. A VENDOR login without a link sees nothing. */
async function vendorOf(actor: Actor) {
  const u = await User.findOne({ _id: actor.id, role: 'VENDOR', isActive: true, deletedAt: null }).select('vendorId').lean();
  if (!u?.vendorId) throw AppError.forbidden('This login is not linked to a vendor. Ask the office to set it.');
  return u.vendorId;
}

const mine = (vendor: Types.ObjectId) => ({ channel: 'VENDOR', vendor, deletedAt: null });

/** Projects in which this vendor was given shops, with how many. Costs, other vendors and BD documents are never included. */
export async function listJobs(actor: Actor) {
  const vendor = await vendorOf(actor);
  const groups = await Site.aggregate<{ _id: Types.ObjectId; shops: number; districts: string[] }>([
    { $match: mine(vendor) },
    { $group: { _id: '$project', shops: { $sum: 1 }, districts: { $addToSet: '$district' } } },
  ]);
  const projects = await Project.find({ _id: { $in: groups.map((g) => g._id) }, deletedAt: null, status: { $nin: ['CANCELLED', 'LOSS'] } })
    .select('code name client requirementType targetDate status')
    .sort({ createdAt: -1 })
    .lean();
  const clients = await Client.find({ _id: { $in: projects.map((p) => p.client) } }).select('name').lean();
  const clientName = new Map(clients.map((c) => [String(c._id), c.name]));
  const byProject = new Map(groups.map((g) => [String(g._id), g]));
  return projects.map((p) => ({
    projectId: p._id,
    code: p.code,
    name: p.name,
    client: clientName.get(String(p.client)) ?? null,
    requirementType: p.requirementType ?? null,
    targetDate: p.targetDate ?? null,
    status: p.status,
    shops: byProject.get(String(p._id))?.shops ?? 0,
    districts: (byProject.get(String(p._id))?.districts ?? []).filter(Boolean).sort(),
  }));
}

const SHOP_FIELDS = 'seq siteCode shopName dealerName location district address1 address2 address3 pincode mobile contactPerson width height unit quantity boardType remarks lat lng status';

/** Only this vendor's shops of one project. A project where they hold no shops is reported as not found. */
export async function listJobShops(actor: Actor, projectId: string, q: z.infer<typeof shopsQuery>) {
  const vendor = await vendorOf(actor);
  const filter: Record<string, unknown> = { ...mine(vendor), project: new Types.ObjectId(projectId) };
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); filter.$or = [{ shopName: re }, { dealerName: re }, { siteCode: re }, { location: re }, { district: re }, { mobile: re }]; }
  const [items, total] = await Promise.all([
    Site.find(filter).select(SHOP_FIELDS).sort({ seq: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Site.countDocuments(filter),
  ]);
  if (!total && !q.q) throw AppError.notFound('Project not found');
  return { items, meta: pageMeta(q.page, q.limit, total) };
}
