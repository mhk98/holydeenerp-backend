import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { dashboardCharts, dashboardKpis, dashboardWidgets, scopeOf } from './dashboard.service.js';
import { dashboardQuery } from './dashboard.validation.js';

/**
 * Dashboard under /api/v1/dashboard (dashboard.view). Each part only contains what the user's other
 * permissions allow (sales, purchase, accounting, inventory, manufacturing, POS). Approving from the
 * dashboard uses each module's own approve endpoint (`approvePath`).
 */
const router = Router();
router.use(authenticate, branchScope, authorize('dashboard.view'));

const handler = (build) => async (req, res) => {
  const { branchId, ...query } = req.validated.query;
  // The topbar branch switcher (X-Branch-Id) applies unless the query names a branch.
  sendSuccess(res, { data: await build(scopeOf(ctxOf(req), branchId ?? req.branchId), query) });
};
router.get('/kpis', validate({ query: dashboardQuery }), handler(dashboardKpis));
router.get('/charts', validate({ query: dashboardQuery }), handler(dashboardCharts));
router.get('/widgets', validate({ query: dashboardQuery }), handler(dashboardWidgets));

const doc = (path, summary) => ({ method: 'get', path, summary, permission: 'dashboard.view' });
documentRoutes('/dashboard', 'Dashboard', [
  doc(
    '/kpis',
    'KPI cards with the previous period (sales, purchases, gross profit, balances, stock, production)',
  ),
  doc('/charts', 'Sales vs purchases, sales by category, top products, monthly profit, production output'),
  doc('/widgets', 'Overdue invoices, pending approvals, recent activity, my POS day'),
]);

export default router;
