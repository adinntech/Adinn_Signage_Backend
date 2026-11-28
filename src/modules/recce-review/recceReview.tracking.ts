import { Types } from 'mongoose';
import { z } from 'zod';
import { escapeRegex, objectId, pageMeta, type Actor } from '../../common/query';
import { AuditLog } from '../audit/auditLog.model';
import { Site } from '../sites/site.model';
import { Vendor } from '../vendors/vendor.model';
import { stageDecision, visibleProject } from './recceReview.approval';
import { clientNameFor, EVENT_LABEL, getConfig, nameMap } from './recceReview.common';
import { RecceSubmission } from './recceReview.model';

/**
 * Project Tracking (Client Servicing): one project's allocation mind map (vendors / in-house staff), shop-wise progress and the
 * activity feed. Read-only over Sites (allocation) and the SAME recce submissions; decisions go through the existing review APIs.
 * Every number is counted from the records: one shop is one Site, counted once, in one allocation group.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;

export const TRACK_STATUSES = ['NOT_ALLOCATED', 'NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'REWORK', 'REJECTED', 'COMPLETED'] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];
const member = z.union([objectId, z.literal('none')]);

export const trackingShopsQuery = z.object({
  channel: z.enum(['all', 'VENDOR', 'IN_HOUSE']).default('all'),
  vendor: member.optional(),
  staff: member.optional(),
  status: z.enum(['all', ...TRACK_STATUSES]).default('all'),
  approval: z.enum(['all', 'PENDING', 'APPROVED', 'REJECTED']).default('all'),
  district: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const activityQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) });

/** One shop's tracking status, from its allocation and its submission. */
export function trackStatus(site: { channel?: string | null }, sub?: { status: string } | null): TrackStatus {
  if (!site.channel) return 'NOT_ALLOCATED';
  if (!sub) return 'NOT_STARTED';
  switch (sub.status) {
    case 'SUBMITTED': case 'UNDER_REVIEW': return 'SUBMITTED';
    case 'REWORK_REQUIRED': return 'REWORK';
    case 'REJECTED': return 'REJECTED';
    case 'APPROVED': return 'COMPLETED';
    default: return 'IN_PROGRESS';
  }
}
/** Summary buckets: Completed (approved), Rejected (rework or rejected), everything else is Yet to Complete. Never double-counted. */
export const bucketOf = (s: TrackStatus) => (s === 'COMPLETED' ? 'completed' : s === 'REWORK' || s === 'REJECTED' ? 'rejected' : 'pending');
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const memberKey = (s: Row) => (s.channel === 'VENDOR' ? (s.vendor ? String(s.vendor) : 'none') : s.assignedTo ? String(s.assignedTo) : 'none');

const SITE_FIELDS = 'shopName siteCode district location address1 pincode lat lng channel vendor assignedTo allocatedAt assignedToAt';
const SUB_FIELDS = 'site status currentVersion submittedAt finalApprovedAt reviews.versionNo reviews.stage reviews.decision reviews.reviewer reviews.decidedAt';

async function load(projectId: Types.ObjectId) {
  const [sites, subs] = await Promise.all([
    Site.find({ project: projectId, deletedAt: null }).select(SITE_FIELDS).sort({ seq: 1, _id: 1 }).lean<Row[]>().exec(),
    RecceSubmission.find({ project: projectId }).select(SUB_FIELDS).lean<Row[]>().exec(),
  ]);
  return { sites, subBy: new Map(subs.map((s) => [String(s.site), s])) };
}

/* ------------------------------------------------ overview (header, cards, mind map) ------------------------------------------------ */

export async function trackingOverview(actor: Actor, projectId: string) {
  const project = await visibleProject(actor, projectId);
  const { sites, subBy } = await load(project._id);
  const status = new Map(sites.map((s) => [String(s._id), trackStatus(s, subBy.get(String(s._id)))]));
  const tally = (list: Row[]) => {
    const b = { completed: 0, pending: 0, rejected: 0 };
    for (const s of list) b[bucketOf(status.get(String(s._id))!)]++;
    return { assigned: list.length, ...b, percent: pct(b.completed, list.length) };
  };

  const groups = new Map<string, Row[]>();
  for (const s of sites.filter((x) => x.channel)) {
    const k = `${s.channel}:${memberKey(s)}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const ids = (ch: string) => [...groups.keys()].filter((k) => k.startsWith(`${ch}:`)).map((k) => k.split(':')[1]!).filter((k) => k !== 'none');
  const [vNames, uNames] = await Promise.all([
    Vendor.find({ _id: { $in: ids('VENDOR') } }).select('name').lean().then((v) => new Map(v.map((x) => [String(x._id), String(x.name)]))),
    nameMap(ids('IN_HOUSE')),
  ]);
  const members = (ch: 'VENDOR' | 'IN_HOUSE') =>
    [...groups.entries()]
      .filter(([k]) => k.startsWith(`${ch}:`))
      .map(([k, list]) => {
        const id = k.split(':')[1]!;
        const name = id === 'none' ? (ch === 'VENDOR' ? 'Vendor not set' : 'Not assigned') : ((ch === 'VENDOR' ? vNames : uNames).get(id) ?? (ch === 'VENDOR' ? 'Vendor' : 'Staff'));
        return { id, name, channel: ch, ...tally(list) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

  const vendors = members('VENDOR');
  const staff = members('IN_HOUSE');
  const all = tally(sites);
  const vendorSites = sites.filter((s) => s.channel === 'VENDOR');
  const inhouseSites = sites.filter((s) => s.channel === 'IN_HOUSE');
  const lastSubmit = [...subBy.values()].reduce((m: number, s: Row) => Math.max(m, s.submittedAt ? new Date(s.submittedAt).getTime() : 0), 0);

  return {
    project: {
      id: String(project._id), code: project.code, name: project.name, client: await clientNameFor(project), status: project.status,
      requirementType: project.requirementType ?? null, district: project.district ?? null, startDate: project.startDate ?? null, createdAt: project.createdAt ?? null,
      lastSubmittedAt: lastSubmit ? new Date(lastSubmit) : null,
    },
    counts: {
      total: sites.length, vendor: vendorSites.length, inhouse: inhouseSites.length, notAllocated: sites.filter((s) => !s.channel).length,
      vendors: vendors.filter((v) => v.id !== 'none').length, staff: staff.filter((v) => v.id !== 'none').length,
      completed: all.completed, pending: all.pending, rejected: all.rejected,
      percent: { vendor: pct(vendorSites.length, sites.length), inhouse: pct(inhouseSites.length, sites.length), completed: pct(all.completed, sites.length), pending: pct(all.pending, sites.length), rejected: pct(all.rejected, sites.length) },
    },
    branches: { vendor: tally(vendorSites), inhouse: tally(inhouseSites) },
    vendors, staff,
    activity: (await activityPage(project._id, 1, 6)).items,
  };
}

/* ------------------------------------------------ shops (filters, pagination) ------------------------------------------------ */

export async function trackingShops(actor: Actor, projectId: string, q: z.infer<typeof trackingShopsQuery>) {
  const project = await visibleProject(actor, projectId);
  const { sites, subBy } = await load(project._id);
  const re = q.q ? new RegExp(escapeRegex(q.q), 'i') : null;

  // Vendor / staff names for search and display.
  const [vNames, uNames] = await Promise.all([
    Vendor.find({ _id: { $in: [...new Set(sites.map((s) => s.vendor).filter(Boolean).map(String))] } }).select('name').lean().then((v) => new Map(v.map((x) => [String(x._id), String(x.name)]))),
    nameMap(sites.map((s) => s.assignedTo)),
  ]);
  const team = (s: Row) => (s.channel === 'VENDOR' ? (vNames.get(String(s.vendor)) ?? null) : s.channel === 'IN_HOUSE' ? (uNames.get(String(s.assignedTo)) ?? null) : null);
  const csOf = (s: Row) => stageDecision(subBy.get(String(s._id)), 'CS')?.decision ?? null;

  const list = sites.filter((s) => {
    const st = trackStatus(s, subBy.get(String(s._id)));
    if (q.channel !== 'all' && s.channel !== q.channel) return false;
    if (q.vendor && !(s.channel === 'VENDOR' && memberKey(s) === q.vendor)) return false;
    if (q.staff && !(s.channel === 'IN_HOUSE' && memberKey(s) === q.staff)) return false;
    if (q.status !== 'all' && st !== q.status) return false;
    if (q.approval !== 'all') {
      const d = csOf(s);
      if (q.approval === 'PENDING' && d !== 'PENDING') return false;
      if (q.approval === 'APPROVED' && d !== 'APPROVED') return false;
      if (q.approval === 'REJECTED' && d !== 'REJECTED' && d !== 'REWORK') return false;
    }
    if (q.district && String(s.district ?? '').toLowerCase() !== q.district.toLowerCase()) return false;
    if (re && ![s.shopName, s.siteCode, s.location, s.district, team(s)].some((v) => v && re.test(String(v)))) return false;
    return true;
  });
  const page = list.slice((q.page - 1) * q.limit, q.page * q.limit);

  // Photo counts and units of the current version, for this page only.
  const pageSubIds = page.map((s) => subBy.get(String(s._id))?._id).filter(Boolean);
  const [details, cfg] = await Promise.all([
    pageSubIds.length ? RecceSubmission.find({ _id: { $in: pageSubIds } }).select('currentVersion versions.version versions.photos mediaItems.quantity mediaItems.units.unitId mediaItems.units.key mediaItems.units.currentVersion mediaItems.units.versions.version mediaItems.units.versions.photoIds boards.units.currentVersion boards.units.versions.version boards.units.versions.photos').lean<Row[]>().exec() : Promise.resolve([] as Row[]),
    getConfig(),
  ]);
  const perUnit = (cfg.unitPhotoCategories ?? []).length;
  const detailBy = new Map(details.map((d) => [String(d._id), d]));
  const items = page.map((s) => {
    const sub = subBy.get(String(s._id));
    const d = sub ? detailBy.get(String(sub._id)) : null;
    const cur = d ? (d.versions ?? []).find((v: Row) => v.version === d.currentVersion) : null;
    // Unit record: mediaItems[].units (or an older `boards` record not moved yet).
    const bu = d ? (d.boards?.length ? d.boards : (d.mediaItems ?? []).filter((m: Row) => (m.units ?? []).some((u: Row) => u.unitId))).flatMap((b: Row) => b.units ?? []) : [];
    const units = bu.length || (d ? (d.mediaItems ?? []).reduce((a: number, m: Row) => a + (m.units?.length || m.quantity || 1), 0) : 0);
    const unitPhotos = bu.length ? bu.reduce((a: number, u: Row) => a + ((u.versions ?? []).find((v: Row) => v.version === u.currentVersion)?.[d.boards?.length ? 'photos' : 'photoIds']?.length ?? 0), 0) : null;
    const cs = stageDecision(sub, 'CS');
    const ops = stageDecision(sub, 'OPS');
    return {
      siteId: String(s._id), submissionId: sub ? String(sub._id) : null, siteCode: s.siteCode, shopName: s.shopName ?? null,
      location: [s.location, s.district].filter(Boolean).join(', ') || null, district: s.district ?? null, address: [s.address1, s.pincode].filter(Boolean).join(', ') || null,
      lat: s.lat ?? null, lng: s.lng ?? null, channel: s.channel ?? null, memberId: s.channel ? memberKey(s) : null, team: team(s),
      allocatedAt: s.assignedToAt ?? s.allocatedAt ?? null, status: trackStatus(s, sub), recceStatus: sub?.status ?? null, version: sub?.currentVersion ?? 0,
      photoCount: unitPhotos ?? cur?.photos?.length ?? 0, units, expectedPhotos: units && perUnit ? units * perUnit : null, submittedAt: sub?.submittedAt ?? null,
      cs: cs ? { decision: cs.decision, decidedAt: cs.decidedAt } : null, ops: ops ? { decision: ops.decision, decidedAt: ops.decidedAt } : null,
    };
  });
  const districts = [...new Set(sites.map((s) => s.district).filter(Boolean).map(String))].sort();
  return { items, districts, meta: pageMeta(q.page, q.limit, list.length) };
}

/* ------------------------------------------------ activity feed ------------------------------------------------ */

const HIDDEN = ['DRAFT_SAVED', 'REVIEW_STARTED'];

/** Latest first: recce events of the project (AuditLog) merged with shop allocations (Site). */
async function activityPage(projectId: Types.ObjectId, page: number, limit: number) {
  const want = page * limit;
  const logFilter = { entity: 'RecceSubmission', project: projectId, action: { $nin: HIDDEN }, 'meta.visibility': { $in: ['ALL', 'REVIEW'] } };
  const allocFilter = { project: projectId, deletedAt: null, $or: [{ assignedToAt: { $ne: null } }, { allocatedAt: { $ne: null } }] };
  const [logs, logTotal, allocs, allocTotal] = await Promise.all([
    AuditLog.find(logFilter).sort({ at: -1 }).limit(want).populate('user', 'name').lean<Row[]>().exec(),
    AuditLog.countDocuments(logFilter),
    Site.find(allocFilter).select('shopName siteCode channel vendor assignedTo assignedToAt assignedToBy allocatedAt allocatedBy').sort({ assignedToAt: -1, allocatedAt: -1 }).limit(want).lean<Row[]>().exec(),
    Site.countDocuments(allocFilter),
  ]);
  const siteIds = [...new Set(logs.map((l) => l.meta?.site).filter(Boolean).map(String))];
  const [siteBy, vNames, uNames] = await Promise.all([
    Site.find({ _id: { $in: siteIds } }).select('shopName siteCode').lean().then((v) => new Map(v.map((x) => [String(x._id), x]))),
    Vendor.find({ _id: { $in: allocs.map((s) => s.vendor).filter(Boolean) } }).select('name').lean().then((v) => new Map(v.map((x) => [String(x._id), String(x.name)]))),
    nameMap(allocs.flatMap((s) => [s.assignedTo, s.assignedToBy, s.allocatedBy])),
  ]);
  const events = [
    ...logs.map((l) => {
      const site = l.meta?.site ? siteBy.get(String(l.meta.site)) : null;
      return {
        id: String(l._id), type: String(l.action), label: EVENT_LABEL[l.action] ?? String(l.action), actor: l.user?.name ?? 'Unknown', role: l.role ?? '', at: l.at as Date,
        reason: l.reason ?? '', version: l.meta?.version ?? null, siteId: site ? String(site._id) : null, siteCode: site?.siteCode ?? null, shopName: site?.shopName ?? null, submissionId: String(l.entityId),
      };
    }),
    ...allocs.map((s) => {
      const to = s.channel === 'VENDOR' ? (vNames.get(String(s.vendor)) ?? 'vendor') : s.assignedTo ? (uNames.get(String(s.assignedTo)) ?? 'staff') : 'in-house team';
      return {
        id: `alloc-${String(s._id)}`, type: 'SHOP_ALLOCATED', label: `Shop allocated to ${to}`, actor: uNames.get(String(s.assignedToBy ?? s.allocatedBy)) ?? 'Operations', role: '', at: (s.assignedToAt ?? s.allocatedAt) as Date,
        reason: '', version: null, siteId: String(s._id), siteCode: s.siteCode ?? null, shopName: s.shopName ?? null, submissionId: null as string | null,
      };
    }),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { items: events.slice((page - 1) * limit, want), meta: pageMeta(page, limit, logTotal + allocTotal) };
}

export async function trackingActivity(actor: Actor, projectId: string, q: z.infer<typeof activityQuery>) {
  const project = await visibleProject(actor, projectId);
  return activityPage(project._id, q.page, q.limit);
}
