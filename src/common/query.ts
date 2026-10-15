import type { Request } from 'express';
import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().regex(/^-?[a-zA-Z.]+$/).optional(),
});

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
export const pageMeta = (page: number, limit: number, total: number): PageMeta => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only allow sorting by whitelisted fields. */
export function parseSort(sort: string | undefined, allowed: string[], fallback: string) {
  const s = sort ?? fallback;
  const field = s.replace(/^-/, '');
  const use = allowed.includes(field) ? s : fallback;
  return { [use.replace(/^-/, '')]: use.startsWith('-') ? -1 : 1 } as Record<string, 1 | -1>;
}

export interface Actor {
  id: string;
  role: string;
}
export const actorOf = (req: Request): Actor => ({ id: req.auth!.sub, role: req.auth!.role });
