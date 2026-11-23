import type { RequestHandler } from 'express';
import { User } from '../modules/users/user.model';

/**
 * One console line per request on the field and review routes, with the NAME of the person (not only the id):
 *   [recce] 14:02:11 S R Glass (VENDOR) POST /api/v1/recce/shops/6afa.../submit -> 200 143ms
 * Names are looked up once per person and kept in memory. Logging never breaks a request. Silent in tests.
 */
const names = new Map<string, string>();

async function nameOf(id: string): Promise<string> {
  const known = names.get(id);
  if (known) return known;
  try {
    const u = await User.findById(id).select('name').lean();
    const name = u?.name ?? id;
    names.set(id, name);
    return name;
  } catch {
    return id;
  }
}

export const requestLog =
  (tag: string): RequestHandler =>
  (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const started = Date.now();
    res.on('finish', () => {
      void (async () => {
        const a = req.auth;
        const who = a ? `${await nameOf(a.sub)} (${a.role})` : 'not signed in';
        const time = new Date().toTimeString().slice(0, 8);
        console.log(`[${tag}] ${time} ${who} ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} ${Date.now() - started}ms`);
      })();
    });
    next();
  };
