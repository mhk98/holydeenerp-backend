import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const handler = (req, res, next, options) =>
  res.status(options.statusCode).json({ success: false, message: options.message });

/** Applied to all /api routes. */
export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many requests, please try again later',
  skip: () => env.isTest,
  handler,
});

/** Stricter limiter for login / refresh / password reset routes. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many attempts, please try again in 15 minutes',
  skip: () => env.isTest,
  handler,
});
