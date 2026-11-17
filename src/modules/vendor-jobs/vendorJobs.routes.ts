import { Router } from 'express';
import multer from 'multer';
import { env } from '../../config/env';
import { authenticate, requireRole } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './vendorJobs.service';

/** Vendor mobile app: the shops allocated to the vendor this login belongs to (nothing else). */
/** Shop photos: up to 10 images in form-data field "images". */
const images = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: env.MAX_IMAGE_SIZE, files: s.MAX_SHOP_IMAGES },
}).array('images', s.MAX_SHOP_IMAGES);
const files = (req: Express.Request) => ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, buffer: f.buffer }));

export const vendorJobsRouter = Router();
vendorJobsRouter.use(authenticate, requireRole('VENDOR'));

vendorJobsRouter.get('/jobs', asyncHandler(async (req, res) => ok(res, await s.listJobs(actorOf(req)))));
vendorJobsRouter.get('/jobs/:projectId/shops', asyncHandler(async (req, res) => {
  const { items, meta } = await s.listJobShops(actorOf(req), s.projectParam.parse(req.params).projectId, s.shopsQuery.parse(req.query));
  ok(res, items, meta);
}));
vendorJobsRouter.get('/jobs/:projectId/shops/:siteId/images', asyncHandler(async (req, res) => {
  const p = s.shopParam.parse(req.params);
  ok(res, await s.listShopImages(actorOf(req), p.projectId, p.siteId));
}));
vendorJobsRouter.post('/jobs/:projectId/shops/:siteId/images', images, asyncHandler(async (req, res) => {
  const p = s.shopParam.parse(req.params);
  ok(res, await s.uploadShopImages(actorOf(req), p.projectId, p.siteId, files(req)), undefined, 201);
}));
vendorJobsRouter.delete('/jobs/:projectId/shops/:siteId/images/:imageId', asyncHandler(async (req, res) => {
  const p = s.imageParam.parse(req.params);
  ok(res, await s.removeShopImage(actorOf(req), p.projectId, p.siteId, p.imageId));
}));
