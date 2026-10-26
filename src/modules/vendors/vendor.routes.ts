import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireAnyPermission, requirePermission } from '../../common/auth.middleware';
import { AppError } from '../../common/errors';
import { asyncHandler, ok } from '../../common/http';
import { actorOf, objectId } from '../../common/query';
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
vendorRouter.get('/export', ...read, asyncHandler(async (_req, res) => sheet(res, await exportVendors(), 'vendors.xlsx')));
vendorRouter.post('/import', ...write, upload, asyncHandler(async (req, res) => {
  if (!req.file) throw AppError.badRequest('Attach a file in the "file" field');
  ok(res, await importVendors(req.file, req.query.commit === 'true', actorOf(req)));
}));
vendorRouter.post('/', ...write, asyncHandler(async (req, res) => ok(res, await svc.createVendor(svc.vendorBody.parse(req.body), actorOf(req)), undefined, 201)));
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
