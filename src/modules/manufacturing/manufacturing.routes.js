import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { createCrudRouter, ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import * as boms from './bom.service.js';
import * as mrp from './mrp.service.js';
import * as orders from './orders.service.js';
import { manufacturingReport } from './reports.service.js';
import * as v from './manufacturing.validation.js';

/**
 * Manufacturing under /api/v1/manufacturing: work centers, bills of materials and manufacturing orders.
 *   view · create (BOMs, orders) · update (edit drafts, shop-floor steps: issue, operations, QC, scrap)
 *   approve (activate BOMs, confirm / complete / close / reopen / cancel orders) · delete (drafts)
 */
const router = Router();
router.use(authenticate, branchScope);
const can = (...actions) => authorize(...actions.map((a) => `manufacturing.${a}`));
const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });
const ok = (res, data, message) => sendSuccess(res, { data, ...(message && { message }) });
const id = (req) => req.validated.params.id;

// ── Work centers (CRUD) ───────────────────────────────────────────────────
router.use(
  '/work-centers',
  createCrudRouter({
    service: boms.workCenters,
    basePath: '/manufacturing/work-centers',
    tag: 'Manufacturing',
    label: 'Work center',
    permission: 'manufacturing',
    createSchema: v.workCenterSchema,
    updateSchema: v.workCenterUpdateSchema,
    listQuerySchema: v.workCenterListQuery,
  }),
);

// ── Bills of materials ────────────────────────────────────────────────────
router.get('/boms', can('view'), validate({ query: v.bomListQuery }), async (req, res) =>
  paginated(res, await boms.listBoms(ctxOf(req), req.validated.query)),
);
router.post('/boms', can('create'), validate({ body: v.bomSchema }), async (req, res) =>
  sendCreated(res, await boms.createBom(ctxOf(req), req.validated.body), 'Bill of materials saved'),
);
router.get('/boms/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  ok(res, await boms.getBom(ctxOf(req), id(req))),
);
router.get(
  '/boms/:id/tree',
  can('view'),
  validate({ params: idParams, query: v.treeQuery }),
  async (req, res) => ok(res, await boms.bomTree(ctxOf(req), id(req), req.validated.query.quantity)),
);
router.put(
  '/boms/:id',
  can('update'),
  validate({ params: idParams, body: v.bomUpdateSchema }),
  async (req, res) =>
    ok(res, await boms.updateBom(ctxOf(req), id(req), req.validated.body), 'Bill of materials updated'),
);
router.delete('/boms/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await boms.deleteBom(ctxOf(req), id(req));
  ok(res, null, 'Bill of materials deleted');
});
router.post(
  '/boms/:id/activate',
  can('approve'),
  validate({ params: idParams, body: v.activateBomSchema }),
  async (req, res) =>
    ok(res, await boms.activateBom(ctxOf(req), id(req), req.validated.body), 'BOM activated'),
);
router.post('/boms/:id/archive', can('approve'), validate({ params: idParams }), async (req, res) =>
  ok(res, await boms.archiveBom(ctxOf(req), id(req)), 'BOM archived'),
);
router.post('/boms/:id/default', can('approve'), validate({ params: idParams }), async (req, res) =>
  ok(res, await boms.setDefaultBom(ctxOf(req), id(req)), 'Default BOM set'),
);
router.post('/boms/:id/new-version', can('create'), validate({ params: idParams }), async (req, res) =>
  sendCreated(res, await boms.newBomVersion(ctxOf(req), id(req)), 'New BOM version created'),
);

// ── Manufacturing orders ──────────────────────────────────────────────────
const O = '/orders';
router.get(O, can('view'), validate({ query: v.orderListQuery }), async (req, res) =>
  paginated(res, await orders.listOrders(ctxOf(req), req.validated.query)),
);
router.post(O, can('create'), validate({ body: v.orderSchema }), async (req, res) =>
  sendCreated(res, await orders.createOrder(ctxOf(req), req.validated.body), 'Manufacturing order created'),
);
router.post(
  `${O}/from-sales-order`,
  can('create'),
  validate({ body: v.fromSalesOrderSchema }),
  async (req, res) => {
    const { salesOrderId, ...rest } = req.validated.body;
    sendCreated(
      res,
      await orders.ordersFromSalesOrder(ctxOf(req), salesOrderId, rest),
      'Manufacturing orders created',
    );
  },
);
router.get(`${O}/:id`, can('view'), validate({ params: idParams }), async (req, res) =>
  ok(res, await orders.getOrder(ctxOf(req), id(req))),
);
router.put(`${O}/:id`, can('update'), validate({ params: idParams, body: v.orderSchema }), async (req, res) =>
  ok(res, await orders.updateOrder(ctxOf(req), id(req), req.validated.body), 'Manufacturing order updated'),
);
router.delete(`${O}/:id`, can('delete'), validate({ params: idParams }), async (req, res) => {
  await orders.deleteOrder(ctxOf(req), id(req));
  ok(res, null, 'Manufacturing order deleted');
});
router.patch(
  `${O}/:id/schedule`,
  can('update'),
  validate({ params: idParams, body: v.rescheduleSchema }),
  async (req, res) =>
    ok(res, await orders.rescheduleOrder(ctxOf(req), id(req), req.validated.body), 'Schedule updated'),
);

/** Simple workflow steps: POST /orders/:id/<step> with an optional body schema. */
const steps = [
  ['confirm', 'approve', orders.confirmOrder, null, 'Order confirmed'],
  ['cancel', 'approve', orders.cancelOrder, null, 'Order cancelled'],
  ['issue', 'update', orders.issueMaterials, v.issueSchema, 'Materials issued'],
  ['return', 'update', orders.returnMaterials, v.returnSchema, 'Materials returned'],
  ['start', 'update', orders.startOrder, null, 'Production started'],
  ['submit', 'update', orders.submitForQuality, v.submitSchema, 'Sent to quality check'],
  ['quality', 'update', orders.recordQuality, v.qualitySchema, 'Quality check recorded'],
  ['scrap', 'update', orders.recordScrap, v.scrapSchema, 'Scrap recorded'],
  ['complete', 'approve', orders.completeOrder, v.completeSchema, 'Order completed'],
  ['close', 'approve', orders.closeOrder, null, 'Order closed'],
  ['reopen', 'approve', orders.reopenOrder, null, 'Order reopened'],
];
for (const [step, action, handler, body, message] of steps) {
  router.post(
    `${O}/:id/${step}`,
    can(action),
    validate({ params: idParams, ...(body && { body }) }),
    async (req, res) => ok(res, await handler(ctxOf(req), id(req), req.validated.body), message),
  );
}
router.post(
  `${O}/:id/operations/:opId/start`,
  can('update'),
  validate({ params: v.operationParams }),
  async (req, res) =>
    ok(res, await orders.startOperation(ctxOf(req), id(req), req.validated.params.opId), 'Operation started'),
);
router.post(
  `${O}/:id/operations/:opId/finish`,
  can('update'),
  validate({ params: v.operationParams, body: v.finishOperationSchema }),
  async (req, res) =>
    ok(
      res,
      await orders.finishOperation(ctxOf(req), id(req), req.validated.params.opId, req.validated.body),
      'Operation finished',
    ),
);

// ── Planning: MRP, schedule, reports ──────────────────────────────────────
router.get('/schedule', can('view'), validate({ query: v.scheduleQuery }), async (req, res) =>
  ok(res, await orders.scheduleOrders(ctxOf(req), req.validated.query)),
);
router.get('/mrp', can('view'), validate({ query: v.mrpQuery }), async (req, res) => {
  const { orderId, ...rest } = req.validated.query;
  ok(res, await mrp.mrp(ctxOf(req), { ...rest, orderIds: orderId ? [orderId] : undefined }));
});
// Only a draft request: the buyer reviews, submits and orders it in Purchase.
router.post('/mrp/requisition', can('create'), validate({ body: v.mrpRequisitionSchema }), async (req, res) =>
  sendCreated(
    res,
    await mrp.requisitionFromMrp(ctxOf(req), req.validated.body),
    'Draft purchase requisition created',
  ),
);
router.post('/mrp/sub-assemblies', can('create'), validate({ body: v.subAssemblySchema }), async (req, res) =>
  sendCreated(
    res,
    await mrp.subAssemblyOrders(ctxOf(req), req.validated.body),
    'Sub-assembly orders created',
  ),
);
router.get(
  '/reports/:name',
  can('view'),
  validate({ params: v.reportParams, query: v.reportQuery }),
  async (req, res) =>
    ok(res, await manufacturingReport(ctxOf(req), req.validated.params.name, req.validated.query)),
);

const doc = (method, path, summary, permission, extra = {}) => ({
  method,
  path,
  summary,
  permission: `manufacturing.${permission}`,
  ...extra,
});
documentRoutes('/manufacturing', 'Manufacturing', [
  doc('get', '/boms', 'List bills of materials', 'view', { list: true }),
  doc('post', '/boms', 'Create a draft BOM', 'create', { body: v.bomSchema }),
  doc('get', '/boms/:id', 'Get a BOM with its standard cost', 'view'),
  doc('get', '/boms/:id/tree', 'Multi-level BOM tree for a quantity', 'view'),
  doc('put', '/boms/:id', 'Edit a draft BOM', 'update', { body: v.bomUpdateSchema }),
  doc('delete', '/boms/:id', 'Delete a draft or unused BOM', 'delete'),
  doc('post', '/boms/:id/activate', 'Activate a BOM (default for its product)', 'approve', {
    body: v.activateBomSchema,
  }),
  doc('post', '/boms/:id/archive', 'Archive a BOM', 'approve'),
  doc('post', '/boms/:id/default', 'Make an active BOM the default', 'approve'),
  doc('post', '/boms/:id/new-version', 'Copy a BOM into a new draft version', 'create'),
  doc('get', '/orders', 'List manufacturing orders', 'view', { list: true }),
  doc('post', '/orders', 'Create a draft manufacturing order', 'create', { body: v.orderSchema }),
  doc('post', '/orders/from-sales-order', 'Draft orders for a sales order’s manufactured lines', 'create', {
    body: v.fromSalesOrderSchema,
  }),
  doc('get', '/orders/:id', 'Get a manufacturing order', 'view'),
  doc('put', '/orders/:id', 'Edit a draft order', 'update', { body: v.orderSchema }),
  doc('delete', '/orders/:id', 'Delete a draft / cancelled order', 'delete'),
  doc('patch', '/orders/:id/schedule', 'Change planned dates or priority', 'update', {
    body: v.rescheduleSchema,
  }),
  ...steps.map(([step, action, , body, message]) =>
    doc('post', `/orders/:id/${step}`, message, action, body ? { body } : {}),
  ),
  doc('post', '/orders/:id/operations/:opId/start', 'Start an operation', 'update'),
  doc(
    'post',
    '/orders/:id/operations/:opId/finish',
    'Finish an operation (labour & overhead to WIP)',
    'update',
    {
      body: v.finishOperationSchema,
    },
  ),
  doc('get', '/schedule', 'Orders and operations planned in a date range (Gantt)', 'view'),
  doc('get', '/mrp', 'Material requirements of open orders: demand, supply and shortages', 'view'),
  doc('post', '/mrp/requisition', 'Draft purchase requisition for shortages', 'create', {
    body: v.mrpRequisitionSchema,
  }),
  doc('post', '/mrp/sub-assemblies', 'Draft orders for sub-assemblies', 'create', {
    body: v.subAssemblySchema,
  }),
  doc('get', '/reports/:name', 'production · consumption · wastage · cost-variance · work-centers', 'view'),
]);

export default router;
