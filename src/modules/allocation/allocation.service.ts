import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { assertNotCancelled } from '../../common/project-access';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { recordAudit } from '../audit/audit.service';
import { getPolicy } from '../costing/costing.service';
import { Project } from '../projects/project.model';
import { Site } from '../sites/site.model';
import { Vendor } from '../vendors/vendor.model';
import { hasCoords, roadKm, splitSites, type LatLng, type SplitBy } from './allocation.geo';
import { geocode } from './allocation.maps';
import { notifyNewShops } from './allocation.notify';
import { planRoute } from './allocation.route';

const coord = (name: string, max: number) => z.coerce.number().min(-max, `${name} is out of range`).max(max, `${name} is out of range`);
export const originBody = z.object({ name: z.string().trim().max(120).optional(), lat: coord('Latitude', 90), lng: coord('Longitude', 180) });
export const coordsBody = z.object({ lat: coord('Latitude', 90).nullable(), lng: coord('Longitude', 180).nullable() }).refine((v) => (v.lat === null) === (v.lng === null), { path: ['lat'], message: 'Give both latitude and longitude, or clear both' });
export const assignBody = z
  .object({
    siteIds: z.array(objectId).min(1, 'Select at least one shop').max(20000),
    channel: z.enum(['VENDOR', 'IN_HOUSE', 'NONE']),
    vendorId: objectId.optional(),
  })
  .refine((v) => v.channel !== 'VENDOR' || !!v.vendorId, { path: ['vendorId'], message: 'Choose the vendor' });
export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  district: z.string().trim().max(120).optional(),
  view: z.string().max(40).optional(), // unassigned | vendor | in_house | no_coords | <vendorId>
  sort: z.enum(['seq', 'distance', '-distance', 'district', 'name']).default('seq'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const splitBody = z.object({
  by: z.enum(['district', 'distance', 'count']).default('district'),
  maxPerTeam: z.coerce.number().int().min(1).max(100000).optional(),
  teams: z.array(z.object({ vendorId: objectId.nullable() })).min(1, 'Choose at least one team').max(50),
  onlyUnassigned: z.boolean().default(true),
});
export const applySplitBody = z.object({ groups: z.array(z.object({ vendorId: objectId.nullable(), siteIds: z.array(objectId).min(1) })).min(1).max(100) });
export const itineraryQuery = z.object({ shopsPerDay: z.coerce.number().int().min(1).max(60).default(8) });
export const geocodeBody = z.object({ limit: z.coerce.number().int().min(1).max(40).default(12), onlyMissing: z.boolean().default(true) });

async function requireProject(projectId: string) {
  const p = await Project.findOne({ _id: projectId, deletedAt: null }).select('code originName originLat originLng status').lean();
  if (!p) throw AppError.notFound('Project not found');
  return p;
}
const originOf = (p: { originLat?: number | null; originLng?: number | null }): LatLng | null => (hasCoords({ lat: p.originLat, lng: p.originLng }) ? { lat: p.originLat as number, lng: p.originLng as number } : null);

interface Row { _id: Types.ObjectId; seq: number; siteCode: string; shopName?: string; dealerName?: string; location?: string; district?: string; mobile?: string; address1?: string; address2?: string; address3?: string; pincode?: string; geoQuality?: string; lat?: number | null; lng?: number | null; channel?: string; vendor?: Types.ObjectId | null }
const LIGHT = 'seq siteCode shopName dealerName location district mobile address1 address2 address3 pincode geoQuality lat lng channel vendor';

async function loadSites(projectId: string, extra: Record<string, unknown> = {}) {
  return Site.find({ project: projectId, deletedAt: null, ...extra }).select(LIGHT).sort({ seq: 1 }).limit(20000).lean<Row[]>();
}
const withDistance = (s: Row, origin: LatLng | null) => ({ ...s, distanceKm: origin && hasCoords(s) ? roadKm(origin, s) : null });

export async function setOrigin(projectId: string, body: z.infer<typeof originBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  await Project.updateOne({ _id: projectId }, { originName: body.name, originLat: body.lat, originLng: body.lng, updatedBy: actor.id });
  await recordAudit({ actor, action: 'UPDATE', entity: 'Project', entityId: projectId, project: projectId, reason: `Start point set to ${body.name ?? `${body.lat}, ${body.lng}`}` });
  return getOverview(projectId);
}

export async function setSiteCoords(siteId: string, body: z.infer<typeof coordsBody>, actor: Actor) {
  const s = await Site.findOne({ _id: siteId, deletedAt: null });
  if (!s) throw AppError.notFound('Shop not found');
  await assertNotCancelled(s.project);
  if (body.lat === null) { s.set({ lat: undefined, lng: undefined, geoQuality: undefined }); } else { s.set({ lat: body.lat, lng: body.lng, geoQuality: 'MANUAL' }); }
  await s.save();
  await recordAudit({ actor, action: 'UPDATE', entity: 'Site', entityId: s._id, project: s.project, changes: [{ field: 'location', oldValue: null, newValue: body.lat === null ? null : `${body.lat}, ${body.lng}` }] });
  return { _id: s._id, lat: s.lat ?? null, lng: s.lng ?? null };
}

/** Counts per team, districts and how many shops still have no map position. */
export async function getOverview(projectId: string) {
  const project = await requireProject(projectId);
  const origin = originOf(project);
  const sites = await loadSites(projectId);
  const vendors = await Vendor.find({ _id: { $in: [...new Set(sites.filter((s) => s.vendor).map((s) => String(s.vendor)))] } }).select('code name type status').lean();
  const vById = new Map(vendors.map((v) => [String(v._id), v]));
  const team = new Map<string, { key: string; vendorId: string | null; name: string; shops: number; districts: Set<string>; km: number }>();
  const bump = (key: string, vendorId: string | null, name: string, s: Row) => {
    const t = team.get(key) ?? { key, vendorId, name, shops: 0, districts: new Set<string>(), km: 0 };
    t.shops++;
    if (s.district) t.districts.add(s.district);
    if (origin && hasCoords(s)) t.km += roadKm(origin, s);
    team.set(key, t);
  };
  let unassigned = 0;
  for (const s of sites) {
    if (s.channel === 'VENDOR' && s.vendor) bump(String(s.vendor), String(s.vendor), vById.get(String(s.vendor))?.name ?? 'Vendor', s);
    else if (s.channel === 'IN_HOUSE') bump('IN_HOUSE', null, 'In-house team', s);
    else unassigned++;
  }
  return {
    origin: origin ? { name: project.originName ?? 'Start point', ...origin } : null,
    total: sites.length,
    unassigned,
    withoutCoords: sites.filter((s) => !hasCoords(s)).length,
    districts: [...new Set(sites.map((s) => s.district).filter(Boolean))].sort(),
    teams: [...team.values()].map((t) => ({ key: t.key, vendorId: t.vendorId, name: t.name, shops: t.shops, districts: [...t.districts].sort(), approxKm: Math.round(t.km) })),
  };
}

export async function listAllocation(projectId: string, q: z.infer<typeof listQuery>) {
  const project = await requireProject(projectId);
  const origin = originOf(project);
  const f: Record<string, unknown> = {};
  if (q.district) f.district = new RegExp(`^${escapeRegex(q.district)}$`, 'i');
  if (q.q) { const re = new RegExp(escapeRegex(q.q), 'i'); f.$or = [{ shopName: re }, { dealerName: re }, { siteCode: re }, { location: re }, { district: re }, { mobile: re }]; }
  if (q.view === 'unassigned') f.channel = null;
  else if (q.view === 'vendor') f.channel = 'VENDOR';
  else if (q.view === 'in_house') f.channel = 'IN_HOUSE';
  else if (q.view && /^[a-f\d]{24}$/i.test(q.view)) f.vendor = q.view;
  const rows = (await loadSites(projectId, f)).map((s) => withDistance(s, origin));
  const filtered = q.view === 'no_coords' ? rows.filter((s) => !hasCoords(s)) : rows;
  const dist = (r: { distanceKm: number | null }) => r.distanceKm ?? Infinity;
  if (q.sort === 'distance') filtered.sort((a, b) => dist(a) - dist(b));
  else if (q.sort === '-distance') filtered.sort((a, b) => (b.distanceKm ?? -1) - (a.distanceKm ?? -1));
  else if (q.sort === 'district') filtered.sort((a, b) => (a.district ?? '').localeCompare(b.district ?? '') || dist(a) - dist(b));
  else if (q.sort === 'name') filtered.sort((a, b) => (a.shopName ?? a.dealerName ?? '').localeCompare(b.shopName ?? b.dealerName ?? ''));
  const items = filtered.slice((q.page - 1) * q.limit, q.page * q.limit);
  const vendors = await Vendor.find({ _id: { $in: items.filter((i) => i.vendor).map((i) => i.vendor) } }).select('name code').lean();
  const vName = new Map(vendors.map((v) => [String(v._id), `${v.name}`]));
  return { items: items.map((i) => ({ ...i, vendorName: i.vendor ? vName.get(String(i.vendor)) ?? null : null })), meta: pageMeta(q.page, q.limit, filtered.length) };
}

/** Every shop with a position, for the map (light fields only). */
export async function mapPoints(projectId: string) {
  const project = await requireProject(projectId);
  const origin = originOf(project);
  const sites = (await loadSites(projectId)).filter(hasCoords);
  return { origin: origin ? { name: project.originName ?? 'Start point', ...origin } : null, points: sites.map((s) => ({ id: s._id, name: s.shopName || s.dealerName || s.siteCode, district: s.district ?? null, lat: s.lat, lng: s.lng, channel: s.channel ?? null, vendor: s.vendor ?? null })) };
}

async function assertActiveVendor(id: string) {
  const v = await Vendor.findOne({ _id: id, deletedAt: null }).select('name status').lean();
  if (!v) throw AppError.notFound('Vendor not found');
  if (v.status !== 'ACTIVE') throw AppError.conflict(`${v.name} is not active (KYC pending, inactive or blacklisted), so shops cannot be given to them`);
  return v;
}

export async function assign(projectId: string, body: z.infer<typeof assignBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const vendor = body.channel === 'VENDOR' ? await assertActiveVendor(body.vendorId as string) : null;
  const filter = { project: projectId, deletedAt: null, _id: { $in: body.siteIds } };
  // Shops that are new to this team or vendor (those already theirs are not news).
  const fresh = body.channel === 'NONE' ? 0 : await Site.countDocuments({ ...filter, ...(body.channel === 'VENDOR' ? { $or: [{ channel: { $ne: 'VENDOR' } }, { vendor: { $ne: new Types.ObjectId(body.vendorId as string) } }] } : { channel: { $ne: 'IN_HOUSE' } }) });
  const set = body.channel === 'NONE'
    ? { $unset: { channel: 1, vendor: 1, allocatedAt: 1, allocatedBy: 1 } }
    : { $set: { channel: body.channel, allocatedAt: new Date(), allocatedBy: actor.id, ...(vendor ? { vendor: body.vendorId } : {}) }, ...(body.channel === 'IN_HOUSE' ? { $unset: { vendor: 1 } } : {}) };
  const r = await Site.updateMany(filter, set);
  if (body.channel === 'VENDOR') await notifyNewShops(projectId, { kind: 'VENDOR', vendorId: body.vendorId as string }, fresh, actor);
  else if (body.channel === 'IN_HOUSE') await notifyNewShops(projectId, { kind: 'IN_HOUSE' }, fresh, actor);
  await recordAudit({ actor, action: 'ALLOCATE', entity: 'Project', entityId: projectId, project: projectId, reason: `${r.modifiedCount} shop(s) → ${body.channel === 'VENDOR' ? vendor?.name : body.channel === 'IN_HOUSE' ? 'in-house team' : 'unassigned'}` });
  return { affected: r.modifiedCount, overview: await getOverview(projectId) };
}

/** Suggests how to divide shops between teams. Nothing is saved until the groups are applied. */
export async function previewSplit(projectId: string, body: z.infer<typeof splitBody>) {
  const project = await requireProject(projectId);
  const origin = originOf(project);
  const rows = (await loadSites(projectId, body.onlyUnassigned ? { channel: null } : {})).map((s) => withDistance(s, origin));
  const ids = [...new Set(body.teams.map((t) => t.vendorId).filter(Boolean))] as string[];
  const vendors = await Vendor.find({ _id: { $in: ids } }).select('name status').lean();
  const vById = new Map(vendors.map((v) => [String(v._id), v]));
  for (const t of body.teams) if (t.vendorId && vById.get(t.vendorId)?.status !== 'ACTIVE') throw AppError.conflict(`${vById.get(t.vendorId)?.name ?? 'A vendor'} is not active`);
  const teams = body.teams.map((t, i) => ({ key: `${t.vendorId ?? 'IN_HOUSE'}:${i}`, vendorId: t.vendorId }));
  const groups = splitSites(rows.map((r) => ({ id: String(r._id), district: r.district, distanceKm: r.distanceKm, seq: r.seq })), teams, body.by as SplitBy, body.maxPerTeam);
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return {
    totalShops: rows.length,
    groups: groups.map((g) => ({
      vendorId: g.team.vendorId,
      name: g.team.vendorId ? vById.get(g.team.vendorId)?.name ?? 'Vendor' : 'In-house team',
      siteIds: g.sites.map((s) => s.id),
      shops: g.sites.length,
      districts: [...new Set(g.sites.map((s) => s.district).filter(Boolean))],
      approxKm: Math.round(g.sites.reduce((a, s) => a + (byId.get(s.id)?.distanceKm ?? 0), 0)),
    })),
  };
}

export async function applySplit(projectId: string, body: z.infer<typeof applySplitBody>, actor: Actor) {
  let affected = 0;
  for (const g of body.groups) affected += (await assign(projectId, { siteIds: g.siteIds, channel: g.vendorId ? 'VENDOR' : 'IN_HOUSE', ...(g.vendorId ? { vendorId: g.vendorId } : {}) }, actor)).affected;
  return { affected, overview: await getOverview(projectId) };
}

/**
 * Looks up the map position of shops that have none, from their address, area and pincode. The free address service allows
 * about one request a second, so this works through a few shops per call and the screen calls it again until none are left.
 */
export async function geocodeSites(projectId: string, body: z.infer<typeof geocodeBody>, actor: Actor) {
  await requireProject(projectId);
  await assertNotCancelled(projectId);
  const rows = (await loadSites(projectId)).filter((s) => !hasCoords(s));
  const batch = rows.slice(0, body.limit);
  const pause = () => new Promise<void>((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : 1100));
  let found = 0;
  const notFound: { id: Types.ObjectId; name: string }[] = [];
  let unavailable = false;
  for (const s of batch) {
    let hit = null;
    try {
      hit = await geocode({ address: [s.address1, s.address2].filter(Boolean).join(', '), area: s.location ?? s.address3, district: s.district, pincode: s.pincode }, pause);
    } catch {
      unavailable = true;
      break;
    }
    if (hit) {
      await Site.updateOne({ _id: s._id }, { lat: hit.lat, lng: hit.lng, geoQuality: hit.quality });
      found++;
    } else notFound.push({ id: s._id, name: s.shopName || s.dealerName || s.siteCode });
    await pause();
  }
  if (found) await recordAudit({ actor, action: 'GEOCODE', entity: 'Project', entityId: projectId, project: projectId, reason: `${found} shop(s) located from their address` });
  return { tried: batch.length, found, notFound, remaining: Math.max(0, rows.length - found - notFound.length), unavailable };
}

/** Day-wise round trips for the in-house team's shops (see planRoute for how the distance is found). */
export async function itinerary(projectId: string, q: z.infer<typeof itineraryQuery>) {
  const project = await requireProject(projectId);
  const origin = originOf(project);
  if (!origin) throw AppError.conflict('Set the start point (office / hub) on the map first');
  const sites = await loadSites(projectId, { channel: 'IN_HOUSE' });
  const located = sites.filter(hasCoords) as (Row & LatLng)[];
  const rates = await getPolicy();
  const route = await planRoute(origin, located, q.shopsPerDay);
  const food = route.days.length * rates.foodPerDay;
  const fuel = Math.round(route.totalKm * rates.fuelRatePerKm);
  return {
    origin: { name: project.originName ?? 'Start point', ...origin },
    shopsPerDay: q.shopsPerDay,
    totalShops: located.length,
    withoutCoords: sites.length - located.length,
    roadDistance: route.roadDistance,
    days: route.days,
    totalKm: route.totalKm,
    // Every day is a round trip from the start point, so no night stays are assumed; the cost plan has the real trip dates.
    estimate: { days: route.days.length, nights: 0, food, stay: 0, fuel, total: food + fuel },
  };
}
