import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { createHash } from 'node:crypto';
import { Client } from '../clients/client.model';
import { clientNameOf } from '../clients/clientDetails';
import { discardStoredFiles, eraseStoredFile, storeEmbeddedFile, storedFileUrl, validateFiles, type UploadedFile } from '../files/file.service';
import type { StoredFile } from '../files/storedFile.schema';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import { User } from '../users/user.model';

export const shopsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const projectParam = z.object({ projectId: objectId });
export const shopParam = z.object({ projectId: objectId, siteId: objectId });
export const imageParam = shopParam.extend({ imageId: objectId });
/** Photos one shop may hold (all uploads together). */
export const MAX_SHOP_IMAGES = 10;

/** The vendor company this login belongs to. A VENDOR login without a link sees nothing. */
async function vendorOf(actor: Actor) {
  const u = await User.findOne({ _id: actor.id, role: 'VENDOR', isActive: true, deletedAt: null }).select('vendorId').lean();
  if (!u?.vendorId) throw AppError.forbidden('This login is not linked to a vendor. Ask the office to set it.');
  return u.vendorId;
}

/** The vendor's shops that this login may see: shops given to this login, and shops not yet given to any login of the vendor. */
const mine = (vendor: Types.ObjectId, actor: Actor) => ({
  channel: 'VENDOR', vendor, deletedAt: null,
  $or: [{ assignedTo: new Types.ObjectId(actor.id) }, { assignedTo: null }],
});

/** Projects in which this vendor was given shops, with how many. Costs, other vendors and BD documents are never included. */
export async function listJobs(actor: Actor) {
  const vendor = await vendorOf(actor);
  const groups = await Site.aggregate<{ _id: Types.ObjectId; shops: number; districts: string[] }>([
    { $match: mine(vendor, actor) },
    { $group: { _id: '$project', shops: { $sum: 1 }, districts: { $addToSet: '$district' } } },
  ]);
  const projects = await Project.find({ _id: { $in: groups.map((g) => g._id) }, deletedAt: null, status: { $nin: ['CANCELLED', 'LOSS'] } })
    .select('code name client clientDetails requirementType targetDate status')
    .sort({ createdAt: -1 })
    .lean();
  const clients = await Client.find({ _id: { $in: projects.map((p) => p.client) } }).select('name').lean();
  const clientName = new Map(clients.map((c) => [String(c._id), c.name]));
  const byProject = new Map(groups.map((g) => [String(g._id), g]));
  return projects.map((p) => ({
    projectId: p._id,
    code: p.code,
    name: p.name,
    // Older projects: the Client record; projects from a Client Servicing order: their client array.
    client: (p.client ? clientName.get(String(p.client)) : p.clientDetails?.at(-1)?.name) ?? null,
    requirementType: p.requirementType ?? null,
    targetDate: p.targetDate ?? null,
    status: p.status,
    shops: byProject.get(String(p._id))?.shops ?? 0,
    districts: (byProject.get(String(p._id))?.districts ?? []).filter(Boolean).sort(),
  }));
}

const SHOP_FIELDS = 'seq siteCode shopName dealerName location district address1 address2 address3 pincode mobile contactPerson width height unit quantity boardType remarks lat lng status assignedTo assignedToAt assignedToBy vendorImages';

/** Only this vendor's shops of one project. A project where they hold no shops is reported as not found. */
export async function listJobShops(actor: Actor, projectId: string, q: z.infer<typeof shopsQuery>) {
  const vendor = await vendorOf(actor);
  const filter: Record<string, unknown> = { ...mine(vendor, actor), project: new Types.ObjectId(projectId) };
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); filter.$and = [{ $or: [{ shopName: re }, { dealerName: re }, { siteCode: re }, { location: re }, { district: re }, { mobile: re }] }]; }
  const [items, total] = await Promise.all([
    Site.find(filter).select(SHOP_FIELDS).sort({ seq: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('assignedToBy', 'name').lean(),
    Site.countDocuments(filter),
  ]);
  if (!total && !q.q) throw AppError.notFound('Project not found');
  // Each shop's photos with a short-lived link (same shape as GET .../shops/:siteId/images), and how many it holds.
  const rows = await Promise.all(
    items.map(async ({ vendorImages, ...shop }) => ({ ...shop, imageCount: vendorImages?.length ?? 0, maxImages: MAX_SHOP_IMAGES, images: await imageViews(vendorImages) })),
  );
  return { items: rows, meta: pageMeta(q.page, q.limit, total) };
}

/* ------------------------------------------- Shop photos (vendor mobile app) ------------------------------------------- */

/** One shop of this vendor in this project (same rule as the shop list), or 404. */
async function myShop(actor: Actor, projectId: string, siteId: string) {
  const vendor = await vendorOf(actor);
  const site = await Site.findOne({ ...mine(vendor, actor), _id: new Types.ObjectId(siteId), project: new Types.ObjectId(projectId) })
    .select('siteCode project vendorImages')
    .lean();
  if (!site) throw AppError.notFound('Shop not found');
  return site;
}

/** Photos with a short-lived link to open each (a file missing from storage gets `url: null`, the rest still show). */
function imageViews(list: StoredFile[] | null | undefined) {
  return Promise.all(
    (list ?? []).map(async (f) => {
      const link = await storedFileUrl(f).catch(() => null);
      return { id: String(f.fileId), name: f.name ?? null, size: f.size ?? null, mimeType: f.mimeType ?? null, uploadedAt: f.uploadedAt ?? null, url: link?.url ?? null, urlExpiresAt: link?.expiresAt ?? null };
    }),
  );
}

/** The shop's photos, each with a short-lived link to open it. */
async function imagesOf(site: { _id: Types.ObjectId; siteCode: string; vendorImages?: StoredFile[] | null }) {
  const list = site.vendorImages ?? [];
  return { siteId: String(site._id), siteCode: site.siteCode, count: list.length, max: MAX_SHOP_IMAGES, remaining: Math.max(0, MAX_SHOP_IMAGES - list.length), images: await imageViews(list) };
}

export async function listShopImages(actor: Actor, projectId: string, siteId: string) {
  return imagesOf(await myShop(actor, projectId, siteId));
}

/**
 * Adds 1-10 photos to one shop, up to 10 per shop in all. All or nothing: every photo is checked (images only, size,
 * content, not the same photo twice) before any is stored, and stored photos are removed again if saving fails.
 */
export async function uploadShopImages(actor: Actor, projectId: string, siteId: string, files: UploadedFile[]) {
  if (!files.length) throw AppError.badRequest('Attach at least one image (form-data field "images")');
  const site = await myShop(actor, projectId, siteId);
  const project = await Project.findOne({ _id: projectId, deletedAt: null }).select('code status client clientDetails').lean();
  if (!project) throw AppError.notFound('Project not found');
  if (['CANCELLED', 'LOSS'].includes(String(project.status))) throw AppError.conflict('This project is closed: photos cannot be added');
  const have = site.vendorImages ?? [];
  const room = MAX_SHOP_IMAGES - have.length;
  if (files.length > room) {
    throw AppError.badRequest(room > 0 ? `Only ${room} more image${room > 1 ? 's' : ''} allowed for this shop (max ${MAX_SHOP_IMAGES})` : `This shop already has ${MAX_SHOP_IMAGES} images. Delete one to add another.`);
  }
  validateFiles('VENDOR_SHOP_IMAGE', files);
  const hashes = files.map((f) => createHash('sha256').update(f.buffer).digest('hex'));
  const twice = hashes.findIndex((h, i) => hashes.indexOf(h) !== i);
  if (twice !== -1) throw AppError.conflict(`${files[twice]!.originalname} was selected twice`);
  const old = have.find((f) => f.sha256 && hashes.includes(f.sha256));
  if (old) throw AppError.conflict(`${files[hashes.indexOf(old.sha256!)]!.originalname} is already uploaded for this shop (as "${old.name}")`);

  const clientName = (await clientNameOf(project as Parameters<typeof clientNameOf>[0])) ?? 'Client';
  const stored: StoredFile[] = [];
  try {
    for (const file of files) {
      stored.push(await storeEmbeddedFile({ category: 'VENDOR_SHOP_IMAGE', clientName, folderKey: `${project.code}_${site.siteCode}`, file, actor, owner: { entity: 'Site', id: site._id } }));
    }
    // Saved only while the shop still has room (another phone may have added photos meanwhile).
    const r = await Site.updateOne(
      { _id: site._id, $expr: { $lte: [{ $size: { $ifNull: ['$vendorImages', []] } }, MAX_SHOP_IMAGES - files.length] } },
      { $push: { vendorImages: { $each: stored } }, $set: { updatedBy: new Types.ObjectId(actor.id) } },
    );
    if (!r.modifiedCount) throw AppError.conflict(`Photos were added to this shop meanwhile; it can hold ${MAX_SHOP_IMAGES}. Reload and try again.`);
  } catch (e) {
    await discardStoredFiles(stored);
    throw e;
  }
  return listShopImages(actor, projectId, siteId);
}

/** Removes one photo of the shop (record first, then the stored file). */
export async function removeShopImage(actor: Actor, projectId: string, siteId: string, imageId: string) {
  const site = await myShop(actor, projectId, siteId);
  const file = (site.vendorImages ?? []).find((f) => String(f.fileId) === imageId);
  if (!file) throw AppError.notFound('Image not found');
  await Site.updateOne({ _id: site._id }, { $pull: { vendorImages: { fileId: file.fileId } }, $set: { updatedBy: new Types.ObjectId(actor.id) } });
  await eraseStoredFile(file, actor, { entity: 'Site', id: site._id });
  return listShopImages(actor, projectId, siteId);
}
