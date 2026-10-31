import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
import { receive } from '../files/file.controller';
import { z } from 'zod';
import { lookupZohoVendor, zohoVendorDetails } from '../zoho/zoho.service';
import { exportZohoVendors, listZohoVendors, startZohoVendorSync, zohoExportQuery, zohoVendorListQuery, zohoVendorStatus } from '../zoho/zoho.vendors';
import { exportVendors, importVendors, vendorTemplate } from './vendor.excel';
import * as svc from './vendor.service';
import { createUser, listVendorLogins } from '../users/user.service';
import { createUserSchema } from '../users/user.validators';

const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(AppError.badRequest('Only .xlsx or .csv files are allowed'))),
}).single('file');

const read = [authenticate, requireAnyPermission('vendors:manage', 'finance:manage')];
const write = [authenticate, requirePermission('vendors:manage')];
const sheet = (res: import('express').Response, buffer: Buffer, name: string) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
};

export const vendorRouter = Router();
vendorRouter.get('/', ...read, asyncHandler(async (req, res) => { const r = await svc.listVendors(svc.vendorListQuery.parse(req.query)); ok(res, r.items, { ...r.meta, summary: r.summary }); }));
vendorRouter.get('/active', ...read, asyncHandler(async (_req, res) => ok(res, await svc.activeVendors())));
vendorRouter.get('/template', ...read, asyncHandler(async (_req, res) => sheet(res, await vendorTemplate(), 'vendor-template.xlsx')));
const download = (res: import('express').Response, f: { buffer: Buffer; contentType: string; ext: string }, name: string) => {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.${f.ext}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(f.buffer);
};
// ?format=xlsx|csv plus the screen's own filters (q, status, type, district): the file holds every matching row, not just one page.
vendorRouter.get('/export', ...read, asyncHandler(async (req, res) => download(res, await exportVendors(svc.vendorExportQuery.parse(req.query)), 'registered-vendors')));
vendorRouter.post('/import', ...write, upload, asyncHandler(async (req, res) => {
  if (!req.file) throw AppError.badRequest('Attach a file in the "file" field');
  ok(res, await importVendors(req.file, req.query.commit === 'true', actorOf(req)));
}));
vendorRouter.post('/', ...write, asyncHandler(async (req, res) => ok(res, await svc.createVendor(svc.vendorBody.parse(req.body), actorOf(req)), undefined, 201)));
// Zoho vendors: a stored copy of Zoho's vendor list. Not registered vendors; "Register" is a separate step.
vendorRouter.get('/zoho-directory', ...read, asyncHandler(async (req, res) => { const r = await listZohoVendors(zohoVendorListQuery.parse(req.query)); ok(res, r.items, r.meta); }));
vendorRouter.get('/zoho-directory/export', ...read, asyncHandler(async (req, res) => download(res, await exportZohoVendors(zohoExportQuery.parse(req.query)), 'zoho-vendors')));
vendorRouter.get('/zoho-directory/status', ...read, asyncHandler(async (_req, res) => ok(res, await zohoVendorStatus())));
vendorRouter.post('/zoho-directory/sync', ...write, asyncHandler(async (req, res) => ok(res, await startZohoVendorSync(actorOf(req)), undefined, 202)));
vendorRouter.get('/zoho-directory/:contactId/details', ...write, asyncHandler(async (req, res) => ok(res, await zohoVendorDetails(z.object({ contactId: z.string().regex(/^\d{10,25}$/, 'Invalid Zoho contact id') }).parse(req.params).contactId))));
// Fill the registration form from a Zoho Books vendor number (e.g. 12543). Must stay above '/:id'.
vendorRouter.get('/zoho/:vendorNo', ...write, asyncHandler(async (req, res) => ok(res, await lookupZohoVendor(svc.zohoVendorNoParam.parse(req.params).vendorNo))));
vendorRouter.post('/:id/kyc-files', ...write, receive, asyncHandler(async (req, res) => {
  const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));
  ok(res, await svc.addKycFiles(objectId.parse(req.params.id), svc.kycFileBody.parse(req.body).docType, files, actorOf(req)), undefined, 201);
}));
vendorRouter.delete('/:id/kyc-files/:fileId', ...write, asyncHandler(async (req, res) => ok(res, await svc.removeKycFile(objectId.parse(req.params.id), objectId.parse(req.params.fileId), actorOf(req)))));
vendorRouter.get('/:id/kyc-files/:fileId/url', ...read, asyncHandler(async (req, res) => ok(res, await svc.kycFileUrl(objectId.parse(req.params.id), objectId.parse(req.params.fileId)))));
vendorRouter.get('/:id', ...read, asyncHandler(async (req, res) => ok(res, await svc.getVendor(objectId.parse(req.params.id)))));
vendorRouter.patch('/:id', ...write, asyncHandler(async (req, res) => ok(res, await svc.updateVendor(objectId.parse(req.params.id), svc.vendorPatch.parse(req.body), actorOf(req)))));
vendorRouter.put('/:id/kyc', ...write, asyncHandler(async (req, res) => ok(res, await svc.setKyc(objectId.parse(req.params.id), svc.kycBody.parse(req.body), actorOf(req)))));
vendorRouter.post('/:id/status', ...write, asyncHandler(async (req, res) => ok(res, await svc.setStatus(objectId.parse(req.params.id), svc.statusBody.parse(req.body), actorOf(req)))));
vendorRouter.delete('/:id', ...write, asyncHandler(async (req, res) => { await svc.deleteVendor(objectId.parse(req.params.id), actorOf(req)); ok(res, { deleted: true }); }));

// Logins of a vendor company (mobile app users). Created here so Operations can link them without the user-admin screen.
vendorRouter.get('/:id/logins', ...read, asyncHandler(async (req, res) => ok(res, await listVendorLogins(objectId.parse(req.params.id)))));
vendorRouter.post('/:id/logins', ...write, asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id);
  await svc.getVendor(id);
  ok(res, await createUser(createUserSchema.parse({ ...req.body, role: 'VENDOR', vendorId: id }), actorOf(req)), undefined, 201);
}));
