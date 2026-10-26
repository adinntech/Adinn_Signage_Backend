import { z } from 'zod';
import { listQuery, objectId } from '../../common/query';
import { MAPPABLE, SCENARIOS, UNITS } from './site.fields';

const t = (n: number) => z.string().max(n).optional();
const num = z.union([z.number(), z.string()]).optional();

/** Raw (un-normalised) site fields; normalisation/validation happens in site.fields.normalise. */
export const siteFields = z.object({
  shopName: t(250), dealerName: t(250), location: t(250), district: t(250), address1: t(250), address2: t(250), address3: t(250),
  pincode: t(20), mobile: t(60), gstin: t(30), contactPerson: t(250), boardType: t(120), remarks: t(1000), clientSiteCode: t(120),
  width: num, height: num, quantity: num, unit: z.enum(UNITS).optional(), scenario: z.enum(SCENARIOS).optional(),
});

// lat / lng: the recce person's position when they add the shop on the spot.
export const siteCreate = siteFields.extend({ allowDuplicate: z.boolean().default(false), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() });
export const sitePatch = siteFields;

const bool = z.enum(['true', 'false']);
export const siteFilter = z.object({
  q: z.string().trim().max(100).optional(),
  district: z.string().trim().max(120).optional(),
  status: z.string().max(40).optional(),
  scenario: z.enum(SCENARIOS).optional(),
  missing: z.enum(['address', 'mobile', 'measurement', 'gst', 'district']).optional(),
  importBatchId: objectId.optional(),
});
export const siteListQuery = listQuery.merge(siteFilter).extend({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export const exportQuery = siteFilter.extend({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  columns: z.string().max(500).optional(),
  ids: z.string().max(20000).optional(),
  sort: z.string().regex(/^-?[a-zA-Z.]+$/).optional(),
});

const BULK_FIELDS = z.object({
  district: t(250), location: t(250), boardType: t(120), remarks: t(1000), unit: z.enum(UNITS).optional(),
  scenario: z.enum(SCENARIOS).optional(), width: num, height: num,
}).strict();
export const bulkBody = z
  .object({
    action: z.enum(['update', 'delete']),
    ids: z.array(objectId).max(5000).optional(),
    filter: siteFilter.optional(), // "select all matching" instead of explicit ids
    patch: BULK_FIELDS.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.ids?.length && !v.filter) ctx.addIssue({ code: 'custom', path: ['ids'], message: 'Provide ids or a filter' });
    if (v.action === 'update' && (!v.patch || !Object.values(v.patch).some((x) => x !== undefined))) ctx.addIssue({ code: 'custom', path: ['patch'], message: 'Nothing to update' });
  });

export const mappingTarget = z.enum([...MAPPABLE, 'extra', 'ignore']);
export const previewBody = z.object({
  mapping: z.record(z.string(), mappingTarget),
  scenario: z.enum(SCENARIOS).optional(),
  defaultUnit: z.enum(UNITS).default('ft'),
  duplicatePolicy: z.enum(['skip', 'import', 'update']).default('skip'),
});
export const fromFileBody = z.object({ fileId: objectId });
export const commitBody = z.object({ duplicatePolicy: z.enum(['skip', 'import', 'update']).optional() });
export const rowListQuery = listQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  state: z.enum(['VALID', 'WARNING', 'ERROR', 'DUPLICATE']).optional(),
});
export const rowPatch = z.object({ mapped: siteFields.partial().optional(), skipped: z.boolean().optional() });
