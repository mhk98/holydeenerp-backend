import { AppError } from '../utils/AppError.js';

/**
 * Require at least one of the given permissions, e.g.
 *   router.post('/', authorize('users.create'), ...)
 *   router.get('/', authorize('reports.view', 'accounting.view'), ...)
 * Must run after `authenticate`. "*" (Super Admin) passes every check.
 */
export const authorize =
  (...required) =>
  (req, res, next) => {
    const granted = req.auth?.permissions;
    if (!granted) throw AppError.unauthorized('Authentication required');
    if (granted.includes('*') || required.some((p) => granted.includes(p))) return next();
    throw AppError.forbidden();
  };

/**
 * Branch scoping. Reads the optional `X-Branch-Id` header (the branch switcher) and
 * validates it against the user's branches. Sets:
 *   req.branchId   the selected branch, or null for "all my branches"
 *   req.branchIds  branches the request may touch — filter branch data with
 *                  { branchId: req.branchId ?? req.branchIds }
 */
export function branchScope(req, res, next) {
  const allowed = req.auth?.branchIds ?? [];
  const requested = req.get('x-branch-id');

  if (requested) {
    if (!allowed.includes(String(requested)))
      throw AppError.forbidden('You do not have access to this branch');
    req.branchId = String(requested);
    req.branchIds = [String(requested)];
  } else {
    req.branchId = null;
    req.branchIds = allowed;
  }
  next();
}

/** Installation-wide operations (e.g. database backups contain every tenant's data). */
export function requireSuperAdmin(req, res, next) {
  if (!req.auth) throw AppError.unauthorized('Authentication required');
  if (!req.auth.isSuperAdmin) throw AppError.forbidden('Only a Super Admin can do this');
  next();
}
