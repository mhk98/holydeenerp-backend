import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import * as adjustments from './adjustments.service.js';
import * as counts from './counts.service.js';
import * as stock from './stock.service.js';
import * as transfers from './transfers.service.js';
import * as v from './inventory.validation.js';

/**
 * Inventory module (/api/v1/inventory). Permission module: inventory.*
 *   view     stock, ledger, reports, documents
 *   create   create drafts, submit adjustments/counts
 *   update   edit drafts, enter counts, dispatch/receive transfers
 *   approve  approve/reject adjustments and counts, cancel dispatched transfers
 *   delete   delete drafts
 */
const router = Router();
router.use(authenticate, branchScope);
const can = (...actions) => authorize(...actions.map((a) => (a.includes('.') ? a : `inventory.${a}`)));
/** Lookups that purchase and sales documents need as well. */
const LOOKUP = ['view', 'purchase.view', 'sales.view', 'pos.view'];

const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });
const withMeta = (res, { data, meta }) => sendSuccess(res, { data, meta });

// ── Stock ──────────────────────────────────────────────────────────────────
router.get('/warehouses', can(...LOOKUP), async (req, res) =>
  sendSuccess(res, { data: await stock.listWarehouses(ctxOf(req)) }),
);
router.get('/warehouses/destinations', can('create', 'update'), async (req, res) =>
  sendSuccess(res, { data: await stock.listTransferDestinations(ctxOf(req)) }),
);
router.get('/stock', can('view'), validate({ query: v.stockQuery }), async (req, res) =>
  paginated(res, await stock.stockOverview(ctxOf(req), req.validated.query)),
);
router.get('/stock/summary', can('view'), validate({ query: v.stockQuery }), async (req, res) =>
  sendSuccess(res, { data: await stock.stockSummary(ctxOf(req), req.validated.query) }),
);
router.get('/items/search', can(...LOOKUP), validate({ query: v.itemSearchQuery }), async (req, res) =>
  sendSuccess(res, { data: await stock.searchItems(ctxOf(req), req.validated.query) }),
);
router.get(
  '/products/:productId',
  can('view'),
  validate({ params: v.productParams, query: v.stockCardQuery }),
  async (req, res) =>
    sendSuccess(res, {
      data: await stock.productStock(ctxOf(req), req.validated.params.productId, req.validated.query),
    }),
);
router.get(
  '/products/:productId/card',
  can('view'),
  validate({ params: v.productParams, query: v.stockCardQuery }),
  async (req, res) =>
    withMeta(res, await stock.stockCard(ctxOf(req), req.validated.params.productId, req.validated.query)),
);
router.get('/movements', can('view'), validate({ query: v.movementsQuery }), async (req, res) =>
  paginated(res, await stock.listMovements(ctxOf(req), req.validated.query)),
);
router.get('/batches', can(...LOOKUP), validate({ query: v.batchesQuery }), async (req, res) =>
  sendSuccess(res, { data: await stock.listBatches(ctxOf(req), req.validated.query) }),
);
router.get('/serials', can('view'), validate({ query: v.serialsQuery }), async (req, res) =>
  paginated(res, await stock.listSerials(ctxOf(req), req.validated.query)),
);
router.get('/alerts', can('view'), validate({ query: v.alertsQuery }), async (req, res) =>
  sendSuccess(res, { data: await stock.stockAlerts(ctxOf(req), req.validated.query) }),
);

// ── Reports ────────────────────────────────────────────────────────────────
const reports = {
  valuation: stock.valuationReport,
  'slow-moving': stock.slowMovingReport,
  abc: stock.abcReport,
  expiry: stock.expiryReport,
};
for (const [path, fn] of Object.entries(reports)) {
  router.get(`/reports/${path}`, can('view'), validate({ query: v.reportQuery }), async (req, res) =>
    withMeta(res, await fn(ctxOf(req), req.validated.query)),
  );
}

// ── Workflow documents ─────────────────────────────────────────────────────
/** CRUD + workflow actions for one document type. */
function mountDocument(base, svc, { schema, listQuery, actions }) {
  router.get(base, can('view'), validate({ query: listQuery }), async (req, res) =>
    paginated(res, await svc.list(ctxOf(req), req.validated.query)),
  );
  router.post(base, can('create'), validate({ body: schema }), async (req, res) =>
    sendCreated(res, await svc.create(ctxOf(req), req.validated.body), `${svc.label} saved as draft`),
  );
  router.get(`${base}/:id`, can('view'), validate({ params: idParams }), async (req, res) =>
    sendSuccess(res, { data: await svc.get(ctxOf(req), req.validated.params.id) }),
  );
  if (svc.update) {
    router.put(`${base}/:id`, can('update'), validate({ params: idParams, body: schema }), async (req, res) =>
      sendSuccess(res, {
        data: await svc.update(ctxOf(req), req.validated.params.id, req.validated.body),
        message: `${svc.label} updated`,
      }),
    );
  }
  router.delete(`${base}/:id`, can('delete'), validate({ params: idParams }), async (req, res) => {
    await svc.remove(ctxOf(req), req.validated.params.id);
    return sendSuccess(res, { message: `${svc.label} deleted` });
  });
  for (const a of actions) {
    router.post(
      `${base}/:id/${a.path}`,
      can(...a.permissions),
      validate({ params: idParams, ...(a.body && { body: a.body }) }),
      async (req, res) =>
        sendSuccess(res, {
          data: await a.run(ctxOf(req), req.validated.params.id, req.validated.body),
          message: a.message,
        }),
    );
  }
}

mountDocument(
  '/adjustments',
  {
    label: 'Stock adjustment',
    list: adjustments.listAdjustments,
    get: adjustments.getAdjustment,
    create: adjustments.createAdjustment,
    update: adjustments.updateAdjustment,
    remove: adjustments.deleteAdjustment,
  },
  {
    schema: v.adjustmentSchema,
    listQuery: v.listAdjustmentQuery,
    actions: [
      {
        path: 'submit',
        permissions: ['create', 'update'],
        run: adjustments.submitAdjustment,
        message: 'Adjustment submitted',
      },
      {
        path: 'approve',
        permissions: ['approve'],
        run: adjustments.approveAdjustment,
        message: 'Adjustment approved and posted',
      },
      {
        path: 'reject',
        permissions: ['approve'],
        body: v.rejectSchema,
        run: (ctx, id, b) => adjustments.rejectAdjustment(ctx, id, b.reason),
        message: 'Adjustment rejected',
      },
      {
        path: 'cancel',
        permissions: ['update'],
        run: adjustments.cancelAdjustment,
        message: 'Adjustment cancelled',
      },
    ],
  },
);

mountDocument(
  '/transfers',
  {
    label: 'Stock transfer',
    list: transfers.listTransfers,
    get: transfers.getTransfer,
    create: transfers.createTransfer,
    update: transfers.updateTransfer,
    remove: transfers.deleteTransfer,
  },
  {
    schema: v.transferSchema,
    listQuery: v.listTransferQuery,
    actions: [
      {
        path: 'dispatch',
        permissions: ['update'],
        run: transfers.dispatchTransfer,
        message: 'Transfer dispatched',
      },
      {
        path: 'receive',
        permissions: ['update'],
        run: transfers.receiveTransfer,
        message: 'Transfer received',
      },
      {
        path: 'cancel',
        permissions: ['update'],
        run: transfers.cancelTransfer,
        message: 'Transfer cancelled',
      },
    ],
  },
);

router.put(
  '/counts/:id/items',
  can('update'),
  validate({ params: idParams, body: v.countEntriesSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await counts.saveCountEntries(ctxOf(req), req.validated.params.id, req.validated.body.items),
      message: 'Counts saved',
    }),
);
mountDocument(
  '/counts',
  {
    label: 'Stock count',
    list: counts.listCounts,
    get: counts.getCount,
    create: counts.createCount,
    remove: counts.deleteCount,
  },
  {
    schema: v.countSchema,
    listQuery: v.listCountQuery,
    actions: [
      {
        path: 'submit',
        permissions: ['create', 'update'],
        run: counts.submitCount,
        message: 'Count submitted',
      },
      {
        path: 'approve',
        permissions: ['approve'],
        run: counts.approveCount,
        message: 'Count approved and posted',
      },
      {
        path: 'reject',
        permissions: ['approve'],
        body: v.rejectSchema,
        run: (ctx, id, b) => counts.rejectCount(ctx, id, b.reason),
        message: 'Count rejected',
      },
      { path: 'cancel', permissions: ['update'], run: counts.cancelCount, message: 'Count cancelled' },
    ],
  },
);

// ── Docs ───────────────────────────────────────────────────────────────────
documentRoutes('/inventory', 'Inventory · Stock', [
  {
    method: 'get',
    path: '/warehouses',
    summary: 'Warehouses of my branches (pickers)',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/warehouses/destinations',
    summary: 'All active warehouses (transfer destinations)',
    permission: 'inventory.create',
  },
  {
    method: 'get',
    path: '/stock',
    summary: 'Stock overview (warehouseId, categoryId, brandId, status=in_stock|low|out|negative, search)',
    permission: 'inventory.view',
    list: true,
  },
  {
    method: 'get',
    path: '/stock/summary',
    summary: 'Stock totals per warehouse',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/items/search',
    summary: 'Find items by name/SKU/barcode for document lines (exact=true for scans)',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/products/:productId',
    summary: 'Stock of one product per warehouse, batches and serials',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/products/:productId/card',
    summary: 'Stock card: movements with running balance (from, to, warehouseId, variantId)',
    permission: 'inventory.view',
  },
  { method: 'get', path: '/movements', summary: 'Stock ledger', permission: 'inventory.view', list: true },
  {
    method: 'get',
    path: '/batches',
    summary: 'Batches of a product with quantities',
    permission: 'inventory.view',
  },
  { method: 'get', path: '/serials', summary: 'Serial numbers', permission: 'inventory.view', list: true },
  {
    method: 'get',
    path: '/alerts',
    summary: 'Low stock, out of stock, near-expiry and expired batches, pending work',
    permission: 'inventory.view',
  },
]);
documentRoutes('/inventory/reports', 'Inventory · Reports', [
  {
    method: 'get',
    path: '/valuation',
    summary: 'Stock valuation (groupBy=item|category|warehouse)',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/slow-moving',
    summary: 'Slow-moving and dead stock (class=slow|dead, days)',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/abc',
    summary: 'ABC analysis (basis=consumption|stock_value, from, to)',
    permission: 'inventory.view',
  },
  {
    method: 'get',
    path: '/expiry',
    summary: 'Batches by expiry (status=expired|near|ok|all, days)',
    permission: 'inventory.view',
  },
]);
const docRoutes = (label, schema, actions) => [
  { method: 'get', path: '', summary: `List ${label}s`, permission: 'inventory.view', list: true },
  {
    method: 'post',
    path: '',
    summary: `Create a ${label} (draft)`,
    permission: 'inventory.create',
    body: schema,
  },
  { method: 'get', path: '/:id', summary: `Get a ${label}`, permission: 'inventory.view' },
  { method: 'delete', path: '/:id', summary: `Delete a draft ${label}`, permission: 'inventory.delete' },
  ...actions,
];
documentRoutes('/inventory/adjustments', 'Inventory · Adjustments', [
  ...docRoutes('stock adjustment', v.adjustmentSchema, [
    {
      method: 'put',
      path: '/:id',
      summary: 'Replace a draft or rejected adjustment',
      permission: 'inventory.update',
      body: v.adjustmentSchema,
    },
    {
      method: 'post',
      path: '/:id/submit',
      summary: 'Submit (posts directly when approval is off)',
      permission: 'inventory.create',
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/approve',
      summary: 'Approve and post',
      permission: 'inventory.approve',
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/reject',
      summary: 'Reject with a reason',
      permission: 'inventory.approve',
      body: v.rejectSchema,
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/cancel',
      summary: 'Cancel',
      permission: 'inventory.update',
      noCreate: true,
    },
  ]),
]);
documentRoutes('/inventory/transfers', 'Inventory · Transfers', [
  ...docRoutes('stock transfer', v.transferSchema, [
    {
      method: 'put',
      path: '/:id',
      summary: 'Replace a draft transfer',
      permission: 'inventory.update',
      body: v.transferSchema,
    },
    {
      method: 'post',
      path: '/:id/dispatch',
      summary: 'Dispatch: stock leaves the source (in transit)',
      permission: 'inventory.update',
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/receive',
      summary: 'Receive into the destination',
      permission: 'inventory.update',
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/cancel',
      summary: 'Cancel (dispatched: returns stock, needs inventory.approve)',
      permission: 'inventory.update',
      noCreate: true,
    },
  ]),
]);
documentRoutes('/inventory/counts', 'Inventory · Stock counts', [
  ...docRoutes('stock count', v.countSchema, [
    {
      method: 'put',
      path: '/:id/items',
      summary: 'Save counted quantities',
      permission: 'inventory.update',
      body: v.countEntriesSchema,
    },
    {
      method: 'post',
      path: '/:id/submit',
      summary: 'Submit (posts directly when approval is off)',
      permission: 'inventory.create',
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/approve',
      summary: 'Approve and post the variance',
      permission: 'inventory.approve',
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/reject',
      summary: 'Reject with a reason',
      permission: 'inventory.approve',
      body: v.rejectSchema,
      noCreate: true,
    },
    {
      method: 'post',
      path: '/:id/cancel',
      summary: 'Cancel',
      permission: 'inventory.update',
      noCreate: true,
    },
  ]),
]);

export default router;
