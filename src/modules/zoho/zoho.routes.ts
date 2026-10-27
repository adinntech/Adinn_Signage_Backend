import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../common/auth.middleware';
import { asyncHandler, ok } from '../../common/http';
import { actorOf } from '../../common/query';
import * as s from './zoho.service';

const contactParam = z.object({ contactId: z.string().regex(/^\d{10,25}$/, 'Invalid Zoho contact id') });
/** Pages are small on purpose: Zoho is read one page at a time, never dumped in bulk. */
const searchQuery = z.object({
  q: z.string().trim().min(2, 'Type at least 2 letters').max(100).optional().or(z.literal('').transform(() => undefined)),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(25),
});

export const zohoRouter = Router();
zohoRouter.use(authenticate, requirePermission('zoho:sync'));
zohoRouter.get('/clients', asyncHandler(async (req, res) => {
  const { items, meta } = await s.searchZohoClients(searchQuery.parse(req.query));
  ok(res, items, meta);
}));
zohoRouter.get('/clients/:contactId', asyncHandler(async (req, res) => ok(res, await s.previewZohoClient(contactParam.parse(req.params).contactId))));
zohoRouter.post('/clients/:contactId/import', asyncHandler(async (req, res) => {
  const r = await s.importZohoContact(contactParam.parse(req.params).contactId, actorOf(req));
  ok(res, r, undefined, r.outcome === 'CREATED' ? 201 : 200);
}));
