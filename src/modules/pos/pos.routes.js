import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import * as catalog from './catalog.service.js';
import * as held from './held.service.js';
import * as registers from './registers.service.js';
import * as sales from './sales.service.js';
import * as sessions from './sessions.service.js';
import * as v from './pos.validation.js';

/**
 * Point of sale (/api/v1/pos). Permission module: pos.*
 *   view    open the POS, catalog, receipts, session reports
 *   create  sell, open / close the register, cash in / out, hold carts, returns, quick customers
 *   update  change prices and give discounts above the cashier limit (Settings → POS)
 * Registers are configured with settings.update; session history is also open to sales.view.
 */
const router = Router();
router.use(authenticate, branchScope);
const can = (...perms) => authorize(...perms.map((p) => (p.includes('.') ? p : `pos.${p}`)));
const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });
const data = (fn) => async (req, res) => sendSuccess(res, { data: await fn(ctxOf(req), req) });

// ── Start-up & catalog ─────────────────────────────────────────────────────
router.get(
  '/bootstrap',
  can('view'),
  validate({ query: v.bootstrapQuery }),
  data((ctx, req) => catalog.bootstrap(ctx, req.validated.query)),
);
router.get(
  '/catalog',
  can('view'),
  validate({ query: v.registerQuery }),
  data((ctx, req) => catalog.catalog(ctx, req.validated.query)),
);
router.get('/customers', can('view'), data(catalog.customerList));
router.post(
  '/customers',
  can('create', 'sales.create'),
  validate({ body: v.quickCustomerSchema }),
  async (req, res) =>
    sendCreated(res, await catalog.quickCustomer(ctxOf(req), req.validated.body), 'Customer added'),
);

// ── Registers ──────────────────────────────────────────────────────────────
router.get('/registers', can('view', 'settings.view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await registers.listRegisters(ctxOf(req), req.validated.query)),
);
router.get(
  '/registers/:id',
  can('view', 'settings.view'),
  validate({ params: idParams }),
  data((ctx, req) => registers.getRegister(ctx, req.validated.params.id)),
);
router.post('/registers', can('settings.update'), validate({ body: v.registerSchema }), async (req, res) =>
  sendCreated(res, await registers.createRegister(ctxOf(req), req.validated.body), 'Register saved'),
);
router.put(
  '/registers/:id',
  can('settings.update'),
  validate({ params: idParams, body: v.registerSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await registers.updateRegister(ctxOf(req), req.validated.params.id, req.validated.body),
      message: 'Register updated',
    }),
);
router.delete('/registers/:id', can('settings.update'), validate({ params: idParams }), async (req, res) => {
  await registers.deleteRegister(ctxOf(req), req.validated.params.id);
  return sendSuccess(res, { message: 'Register deleted' });
});

// ── Sessions ───────────────────────────────────────────────────────────────
router.get(
  '/sessions',
  can('view', 'sales.view'),
  validate({ query: v.sessionListQuery }),
  async (req, res) => paginated(res, await sessions.listSessions(ctxOf(req), req.validated.query)),
);
router.get(
  '/sessions/current',
  can('view'),
  validate({ query: v.registerQuery }),
  data((ctx, req) => sessions.currentSession(ctx, req.validated.query.registerId)),
);
router.post('/sessions', can('create'), validate({ body: v.openSessionSchema }), async (req, res) =>
  sendCreated(res, await sessions.openSession(ctxOf(req), req.validated.body), 'Register opened'),
);
router.get(
  '/sessions/:id',
  can('view', 'sales.view'),
  validate({ params: idParams }),
  data((ctx, req) => sessions.getSession(ctx, req.validated.params.id)),
);
router.get(
  '/sessions/:id/sales',
  can('view'),
  validate({ params: idParams }),
  data((ctx, req) => sales.sessionSales(ctx, req.validated.params.id)),
);
router.post(
  '/sessions/:id/cash',
  can('create'),
  validate({ params: idParams, body: v.cashMovementSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await sessions.addCashMovement(ctxOf(req), req.validated.params.id, req.validated.body),
      message: req.validated.body.type === 'in' ? 'Cash added' : 'Cash taken out',
    }),
);
router.post(
  '/sessions/:id/close',
  can('create'),
  validate({ params: idParams, body: v.closeSessionSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await sessions.closeSession(ctxOf(req), req.validated.params.id, req.validated.body),
      message: 'Register closed',
    }),
);

// ── Sales ──────────────────────────────────────────────────────────────────
router.post('/sales', can('create'), validate({ body: v.saleSchema }), async (req, res) =>
  sendCreated(res, await sales.createSale(ctxOf(req), req.validated.body), 'Sale completed'),
);
router.post(
  '/sales/sync',
  can('create'),
  validate({ body: v.syncSchema }),
  data((ctx, req) => sales.syncSales(ctx, req.validated.body)),
);
router.get(
  '/sales/lookup',
  can('view'),
  validate({ query: v.lookupQuery }),
  data((ctx, req) => sales.lookupSale(ctx, req.validated.query)),
);
router.get(
  '/sales/:id/receipt',
  can('view', 'sales.view'),
  validate({ params: idParams }),
  data((ctx, req) => sales.receiptData(ctx, req.validated.params.id)),
);
router.post(
  '/sales/:id/return',
  can('create'),
  validate({ params: idParams, body: v.returnSchema }),
  async (req, res) =>
    sendCreated(
      res,
      await sales.createPosReturn(ctxOf(req), req.validated.params.id, req.validated.body),
      'Return posted',
    ),
);

// ── Held carts ─────────────────────────────────────────────────────────────
router.get(
  '/held',
  can('create'),
  validate({ query: v.registerQuery }),
  data((ctx, req) => held.listHeld(ctx, req.validated.query)),
);
router.post('/held', can('create'), validate({ body: v.holdSchema }), async (req, res) =>
  sendCreated(res, await held.holdOrder(ctxOf(req), req.validated.body), 'Order held'),
);
router.post(
  '/held/:id/recall',
  can('create'),
  validate({ params: idParams }),
  data((ctx, req) => held.recallOrder(ctx, req.validated.params.id)),
);

// ── Docs ───────────────────────────────────────────────────────────────────
const op = (method, path, summary, permission, extra = {}) => ({
  method,
  path,
  summary,
  permission,
  ...extra,
});
documentRoutes('/pos', 'POS', [
  op(
    'get',
    '/bootstrap',
    'Registers, open session, settings, tax rates, payment methods, categories',
    'pos.view',
  ),
  op(
    'get',
    '/catalog',
    'Sellable items with prices, barcodes and stock for a register (offline cache)',
    'pos.view',
  ),
  op('get', '/customers', 'Active customers (offline cache)', 'pos.view'),
  op('post', '/customers', 'Quick-add a customer', 'pos.create', { body: v.quickCustomerSchema }),
  op('get', '/registers', 'List registers', 'pos.view', { list: true }),
  op('post', '/registers', 'Create a register', 'settings.update', { body: v.registerSchema }),
  op('get', '/registers/:id', 'Get a register', 'pos.view'),
  op('put', '/registers/:id', 'Update a register', 'settings.update', { body: v.registerSchema }),
  op('delete', '/registers/:id', 'Delete a register without sessions', 'settings.update'),
  op('get', '/sessions', 'Register sessions (Z reports)', 'pos.view', { list: true }),
  op('get', '/sessions/current', 'Open session of a register (null when closed)', 'pos.view'),
  op('post', '/sessions', 'Open a register with the opening cash', 'pos.create', {
    body: v.openSessionSchema,
  }),
  op('get', '/sessions/:id', 'Session with its X report (Z report once closed)', 'pos.view'),
  op('get', '/sessions/:id/sales', 'Latest sales of a session', 'pos.view'),
  op('post', '/sessions/:id/cash', 'Cash in / out of the drawer', 'pos.create', {
    body: v.cashMovementSchema,
    noCreate: true,
  }),
  op('post', '/sessions/:id/close', 'Close with the counted cash (by denomination)', 'pos.create', {
    body: v.closeSessionSchema,
    noCreate: true,
  }),
  op(
    'post',
    '/sales',
    'Complete a sale: posted invoice, stock out, receipts per payment method',
    'pos.create',
    {
      body: v.saleSchema,
    },
  ),
  op('post', '/sales/sync', 'Sync sales made offline (idempotent by clientUuid)', 'pos.create', {
    body: v.syncSchema,
    noCreate: true,
  }),
  op('get', '/sales/lookup', 'Find a sale by receipt number (returns)', 'pos.view'),
  op('get', '/sales/:id/receipt', 'Receipt data for printing', 'pos.view'),
  op(
    'post',
    '/sales/:id/return',
    'Return items into the register warehouse, optionally refund',
    'pos.create',
    {
      body: v.returnSchema,
    },
  ),
  op('get', '/held', 'Held carts of the branch', 'pos.create'),
  op('post', '/held', 'Hold a cart', 'pos.create', { body: v.holdSchema }),
  op('post', '/held/:id/recall', 'Recall (and remove) a held cart', 'pos.create', { noCreate: true }),
]);

export default router;
