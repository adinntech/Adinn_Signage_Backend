import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { asyncHandler, ok } from '../../common/http';
import { AppError } from '../../common/errors';
import * as service from './auth.service';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from './auth.validators';

const COOKIE = 'refresh_token';
const baseCookie = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: 'lax' as const,
  path: '/api/v1/auth',
};
// No maxAge => browser-session cookie (when "remember me" is off).
const cookieOpts = (remember: boolean) =>
  remember ? { ...baseCookie, maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 } : baseCookie;
const meta = (req: Request, device?: string): service.ClientMeta => ({
  userAgent: req.get('user-agent'),
  ip: req.ip,
  device,
});
const tokenFrom = (req: Request, body?: string) => body ?? (req.cookies?.[COOKIE] as string | undefined);

export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = loginSchema.parse(req.body);
  const session = await service.login(body, meta(req, body.device));
  res.cookie(COOKIE, session.refreshToken, cookieOpts(session.remember));
  ok(res, session);
});

export const refresh = asyncHandler(async (req, res) => {
  const body = refreshSchema.parse(req.body ?? {});
  const token = tokenFrom(req, body.refreshToken);
  if (!token) throw AppError.unauthorized('Refresh token missing', 'REFRESH_INVALID');
  try {
    const session = await service.refresh(token, meta(req));
    res.cookie(COOKIE, session.refreshToken, cookieOpts(session.remember));
    ok(res, session);
  } catch (e) {
    res.clearCookie(COOKIE, { path: baseCookie.path });
    throw e;
  }
});

export const logout = asyncHandler(async (req, res) => {
  const body = logoutSchema.parse(req.body ?? {});
  await service.logout(tokenFrom(req, body.refreshToken));
  res.clearCookie(COOKIE, { path: baseCookie.path });
  ok(res, { loggedOut: true });
});

export const me = asyncHandler(async (req, res) => {
  ok(res, await service.getMe(req.auth!.sub));
});

export const register = asyncHandler(async (req, res) => {
  const body = registerSchema.parse(req.body);
  const session = await service.register(body, meta(req, body.device));
  res.cookie(COOKIE, session.refreshToken, cookieOpts(session.remember));
  ok(res, session, undefined, 201);
});

/** Public: lets the register screen disable the Admin option once an admin exists. */
export const registerOptions = asyncHandler(async (_req, res) => {
  ok(res, { adminAvailable: await service.adminRegistrationOpen() });
});
