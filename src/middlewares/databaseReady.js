import { isDatabaseReady } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

/**
 * While server.js is still (re)connecting to the database at boot, answer API calls with a clear
 * 503 instead of letting each one wait on Sequelize. Health checks stay reachable so
 * /health/ready can report the outage.
 */
export function requireDatabase(req, res, next) {
  if (isDatabaseReady() || req.path === '/health' || req.path.startsWith('/health/')) return next();
  res.set('Retry-After', '30');
  return next(AppError.serviceUnavailable('Service is starting, please try again shortly'));
}
