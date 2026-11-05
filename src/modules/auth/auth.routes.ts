import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { authenticate } from '../../common/auth.middleware';
import * as c from './auth.controller';

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts, try later' } },
});

// Tighter limit for account creation.
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts, try later' } },
});

export const authRouter = Router();
authRouter.post('/login', loginLimiter, c.login);
authRouter.get('/register-options', c.registerOptions);
authRouter.post('/register', sensitiveLimiter, c.register);
authRouter.post('/forgot', sensitiveLimiter, c.forgotRequest);
authRouter.post('/forgot/confirm', sensitiveLimiter, c.forgotConfirm);
authRouter.post('/refresh', c.refresh);
authRouter.post('/logout', c.logout);
authRouter.get('/me', authenticate, c.me);
