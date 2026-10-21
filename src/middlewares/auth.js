import { AppError } from '../utils/AppError.js';
import { loadAccessContext, assertCanSignIn } from '../modules/auth/access.service.js';
import { isSessionActive, verifyAccessToken } from '../modules/auth/token.service.js';

/**
 * Verifies the Bearer access token and loads the user's access context.
 * Sets:
 *   req.user        Sequelize User (without secrets)
 *   req.auth        { userId, companyId, sessionId, permissions, isSuperAdmin, branchIds, branches }
 */
export async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw AppError.unauthorized('Authentication required');

  const payload = verifyAccessToken(token);

  // Both lookups run together — one database round trip less on every request.
  const [active, ctx] = await Promise.all([isSessionActive(payload.sid), loadAccessContext(payload.sub)]);
  // Revoked sessions ("log out other devices", password reset) lose access immediately.
  if (!active) throw AppError.unauthorized('Session has ended. Please sign in again.');
  if (!ctx) throw AppError.unauthorized('Account no longer exists');
  assertCanSignIn(ctx.user);

  req.user = ctx.user;
  req.auth = {
    userId: ctx.user.id,
    companyId: ctx.user.companyId,
    sessionId: payload.sid,
    permissions: ctx.permissions,
    isSuperAdmin: ctx.isSuperAdmin,
    branchIds: ctx.branchIds,
    branches: ctx.branches,
    ctx,
  };
  next();
}
