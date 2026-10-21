import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import * as bills from './bills.service.js';
import * as conversions from './conversions.service.js';
import * as orders from './orders.service.js';
import * as payables from './payables.service.js';
import * as payments from './payments.service.js';
import * as receipts from './receipts.service.js';
import * as requisitions from './requisitions.service.js';
import * as returns from './returns.service.js';
import * as rfqs from './rfqs.service.js';
import * as v from './purchase.validation.js';

/**
 * Purchase module (/api/v1/purchase). Permission module: purchase.*
 *   view     documents, supplier ledger, payables
 *   create   new documents and "convert to" actions, submit
 *   update   edit drafts, post GRNs / bills / returns, record quotes, close orders
 *   approve  approve/reject requisitions and orders, award RFQs, cancel posted bills, void payments
 *   delete   delete drafts
 *   print    print / email purchase orders
 * Payments also accept accounting.create (and accounting.approve for voiding).
 */
const router = Router();
router.use(authenticate, branchScope);
const can = (...actions) => authorize(...actions.map((a) => (a.includes('.') ? a : `purchase.${a}`)));
const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });
const withMeta = (res, data) => sendSuccess(res, { data });

/** Standard CRUD + actions for a document type. */
function mountDocument(base, svc, { schema, actions = [], update = true, edit = ['update'] }) {
  router.get(base, can('view'), validate({ query: v.listQuery }), async (req, res) =>
    paginated(res, await svc.list(ctxOf(req), req.validated.query)),
  );
  router.post(base, can('create'), validate({ body: schema }), async (req, res) =>
    sendCreated(res, await svc.create(ctxOf(req), req.validated.body), `${svc.label} saved`),
  );
  router.get(`${base}/:id`, can('view'), validate({ params: idParams }), async (req, res) =>
    sendSuccess(res, { data: await svc.get(ctxOf(req), req.validated.params.id) }),
  );
  if (update) {
    router.put(`${base}/:id`, can(...edit), validate({ params: idParams, body: schema }), async (req, res) =>
      sendSuccess(res, {
        data: await svc.update(ctxOf(req), req.validated.params.id, req.validated.body),
        message: `${svc.label} updated`,
      }),
    );
  }
  if (svc.remove) {
    router.delete(`${base}/:id`, can('delete'), validate({ params: idParams }), async (req, res) => {
      await svc.remove(ctxOf(req), req.validated.params.id);
      return sendSuccess(res, { message: `${svc.label} deleted` });
    });
  }
  for (const a of actions) {
    router.post(
      `${base}/:id/${a.path}`,
      can(...a.permissions),
      validate({ params: idParams, ...(a.body && { body: a.body }) }),
      async (req, res) => {
        const data = await a.run(ctxOf(req), req.validated.params.id, req.validated.body);
        return a.created ? sendCreated(res, data, a.message) : sendSuccess(res, { data, message: a.message });
      },
    );
  }
}

// ── Lookups ────────────────────────────────────────────────────────────────
router.get('/lookups', can('view'), async (req, res) =>
  sendSuccess(res, { data: await conversions.purchaseLookups(ctxOf(req)) }),
);
router.post('/calculate', can('view'), validate({ body: v.calculateSchema }), async (req, res) =>
  sendSuccess(res, { data: await conversions.calculateTotals(ctxOf(req), req.validated.body.items) }),
);

// ── Requisitions ───────────────────────────────────────────────────────────
mountDocument(
  '/requisitions',
  {
    label: 'Requisition',
    list: requisitions.listRequisitions,
    get: requisitions.getRequisition,
    create: requisitions.createRequisition,
    update: requisitions.updateRequisition,
    remove: requisitions.deleteRequisition,
  },
  {
    schema: v.requisitionSchema,
    actions: [
      {
        path: 'submit',
        permissions: ['create', 'update'],
        run: requisitions.submitRequisition,
        message: 'Requisition submitted',
      },
      {
        path: 'approve',
        permissions: ['approve'],
        run: requisitions.approveRequisition,
        message: 'Requisition approved',
      },
      {
        path: 'reject',
        permissions: ['approve'],
        body: v.rejectSchema,
        run: (c, id, b) => requisitions.rejectRequisition(c, id, b.reason),
        message: 'Requisition rejected',
      },
      {
        path: 'cancel',
        permissions: ['update'],
        run: requisitions.cancelRequisition,
        message: 'Requisition cancelled',
      },
      {
        path: 'convert-to-order',
        permissions: ['create'],
        body: v.convertRequisitionToOrderSchema,
        run: conversions.requisitionToOrder,
        message: 'Purchase order created',
        created: true,
      },
      {
        path: 'convert-to-rfq',
        permissions: ['create'],
        body: v.convertRequisitionToRfqSchema,
        run: conversions.requisitionToRfq,
        message: 'RFQ created',
        created: true,
      },
    ],
  },
);

// ── RFQs ───────────────────────────────────────────────────────────────────
router.put(
  '/rfqs/:id/suppliers/:rfqSupplierId/quote',
  can('update'),
  validate({ params: v.rfqSupplierParams, body: v.rfqQuoteSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await rfqs.saveQuote(
        ctxOf(req),
        req.validated.params.id,
        req.validated.params.rfqSupplierId,
        req.validated.body,
      ),
      message: 'Quote saved',
    }),
);
mountDocument(
  '/rfqs',
  {
    label: 'RFQ',
    list: rfqs.listRfqs,
    get: rfqs.getRfq,
    create: rfqs.createRfq,
    update: rfqs.updateRfq,
    remove: rfqs.deleteRfq,
  },
  {
    schema: v.rfqSchema,
    actions: [
      { path: 'send', permissions: ['update'], run: rfqs.sendRfq, message: 'RFQ marked as sent' },
      {
        path: 'award',
        permissions: ['approve'],
        body: v.awardSchema,
        run: rfqs.awardRfq,
        message: 'Supplier awarded — purchase order created',
        created: true,
      },
      { path: 'cancel', permissions: ['update'], run: rfqs.cancelRfq, message: 'RFQ cancelled' },
    ],
  },
);

// ── Purchase orders ────────────────────────────────────────────────────────
router.get('/orders/:id/print', can('view'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, { data: await orders.orderPrintData(ctxOf(req), req.validated.params.id) }),
);
mountDocument(
  '/orders',
  {
    label: 'Purchase order',
    list: orders.listOrders,
    get: orders.getOrder,
    create: orders.createOrder,
    update: orders.updateOrder,
    remove: orders.deleteOrder,
  },
  {
    schema: v.orderSchema,
    actions: [
      {
        path: 'submit',
        permissions: ['create', 'update'],
        run: orders.submitOrder,
        message: 'Order submitted',
      },
      {
        path: 'approve',
        permissions: ['approve'],
        run: (c, id) => orders.approveOrder(c, id),
        message: 'Approval recorded',
      },
      {
        path: 'reject',
        permissions: ['approve'],
        body: v.rejectSchema,
        run: (c, id, b) => orders.rejectOrder(c, id, b.reason),
        message: 'Order sent back',
      },
      { path: 'cancel', permissions: ['update'], run: orders.cancelOrder, message: 'Order cancelled' },
      { path: 'close', permissions: ['update'], run: orders.closeOrder, message: 'Order closed' },
      {
        path: 'email',
        permissions: ['print'],
        body: v.emailSchema,
        run: orders.emailOrder,
        message: 'Order emailed to the supplier',
      },
      {
        path: 'convert-to-receipt',
        permissions: ['create'],
        run: receipts.receiptFromOrder,
        message: 'Goods receipt created',
        created: true,
      },
      {
        path: 'convert-to-bill',
        permissions: ['create'],
        run: bills.billFromOrder,
        message: 'Bill created',
        created: true,
      },
    ],
  },
);

// ── Goods receipts ─────────────────────────────────────────────────────────
mountDocument(
  '/receipts',
  {
    label: 'Goods receipt',
    list: receipts.listReceipts,
    get: receipts.getReceipt,
    create: receipts.createReceipt,
    update: receipts.updateReceipt,
    remove: receipts.deleteReceipt,
  },
  {
    schema: v.receiptSchema,
    // Receiving is the storekeeper's job: purchase.create is enough to complete and post a GRN.
    edit: ['create', 'update'],
    actions: [
      {
        path: 'post',
        permissions: ['create', 'update'],
        run: receipts.postReceipt,
        message: 'Goods received into stock',
      },
      {
        path: 'cancel',
        permissions: ['create', 'update'],
        run: receipts.cancelReceipt,
        message: 'Goods receipt cancelled',
      },
      {
        path: 'convert-to-bill',
        permissions: ['create'],
        run: bills.billFromReceipt,
        message: 'Bill created',
        created: true,
      },
      {
        path: 'convert-to-return',
        permissions: ['create'],
        run: returns.returnFromReceipt,
        message: 'Return created',
        created: true,
      },
    ],
  },
);

// ── Bills ──────────────────────────────────────────────────────────────────
mountDocument(
  '/bills',
  {
    label: 'Bill',
    list: bills.listBills,
    get: bills.getBill,
    create: bills.createBill,
    update: bills.updateBill,
    remove: bills.deleteBill,
  },
  {
    schema: v.billSchema,
    actions: [
      { path: 'post', permissions: ['update'], run: bills.postBill, message: 'Bill posted' },
      { path: 'cancel', permissions: ['approve'], run: bills.cancelBill, message: 'Bill cancelled' },
      {
        path: 'convert-to-debit-note',
        permissions: ['create'],
        run: returns.debitNoteFromBill,
        message: 'Debit note created',
        created: true,
      },
    ],
  },
);

// ── Payments ───────────────────────────────────────────────────────────────
router.get('/payments', can('view', 'accounting.view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await payments.listPayments(ctxOf(req), req.validated.query)),
);
router.post(
  '/payments',
  can('create', 'accounting.create'),
  validate({ body: v.paymentSchema }),
  async (req, res) =>
    sendCreated(res, await payments.createPayment(ctxOf(req), req.validated.body), 'Payment recorded'),
);
router.get(
  '/payments/:id',
  can('view', 'accounting.view'),
  validate({ params: idParams }),
  async (req, res) =>
    sendSuccess(res, { data: await payments.getPayment(ctxOf(req), req.validated.params.id) }),
);
router.post(
  '/payments/:id/void',
  can('approve', 'accounting.approve'),
  validate({ params: idParams, body: v.voidSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await payments.voidPayment(ctxOf(req), req.validated.params.id, req.validated.body.reason),
      message: 'Payment voided',
    }),
);
router.post(
  '/payables/apply-credit',
  can('create', 'accounting.create'),
  validate({ body: v.applyCreditSchema }),
  async (req, res) => {
    await payments.applyCredit(ctxOf(req), req.validated.body);
    return sendSuccess(res, { message: 'Credit applied' });
  },
);

// ── Returns / debit notes ──────────────────────────────────────────────────
mountDocument(
  '/returns',
  {
    label: 'Purchase return',
    list: returns.listReturns,
    get: returns.getReturn,
    create: returns.createReturn,
    update: returns.updateReturn,
    remove: returns.deleteReturn,
  },
  {
    schema: v.returnSchema,
    edit: ['create', 'update'],
    actions: [
      { path: 'post', permissions: ['create', 'update'], run: returns.postReturn, message: 'Return posted' },
      {
        path: 'cancel',
        permissions: ['create', 'update'],
        run: returns.cancelReturn,
        message: 'Return cancelled',
      },
    ],
  },
);

// ── Payables ───────────────────────────────────────────────────────────────
router.get(
  '/payables/aging',
  can('view', 'accounting.view'),
  validate({ query: v.agingQuery }),
  async (req, res) => withMeta(res, await payables.payablesAging(ctxOf(req), req.validated.query)),
);
router.get(
  '/payables/outstanding',
  can('view', 'accounting.view'),
  validate({ query: v.agingQuery }),
  async (req, res) => withMeta(res, await payables.outstandingPayables(ctxOf(req), req.validated.query)),
);
router.get(
  '/suppliers/:supplierId/ledger',
  can('view', 'accounting.view'),
  validate({ params: v.supplierParams, query: v.ledgerQuery }),
  async (req, res) =>
    withMeta(
      res,
      await payables.supplierLedger(ctxOf(req), req.validated.params.supplierId, req.validated.query),
    ),
);
router.get(
  '/suppliers/:supplierId/open-items',
  can('view', 'accounting.view'),
  validate({ params: v.supplierParams }),
  async (req, res) => withMeta(res, await payables.openItems(ctxOf(req), req.validated.params.supplierId)),
);

// ── Docs ───────────────────────────────────────────────────────────────────
const crud = (label, schema, extra = []) => [
  { method: 'get', path: '', summary: `List ${label}s`, permission: 'purchase.view', list: true },
  { method: 'post', path: '', summary: `Create a ${label}`, permission: 'purchase.create', body: schema },
  { method: 'get', path: '/:id', summary: `Get a ${label}`, permission: 'purchase.view' },
  {
    method: 'put',
    path: '/:id',
    summary: `Replace a draft ${label}`,
    permission: 'purchase.update',
    body: schema,
  },
  { method: 'delete', path: '/:id', summary: `Delete a draft ${label}`, permission: 'purchase.delete' },
  ...extra,
];
const action = (path, summary, permission, body) => ({
  method: 'post',
  path: `/:id/${path}`,
  summary,
  permission: `purchase.${permission}`,
  body,
  noCreate: true,
});
documentRoutes('/purchase', 'Purchase', [
  {
    method: 'get',
    path: '/lookups',
    summary: 'Tax groups, payment methods, roles and approval rules for the forms',
    permission: 'purchase.view',
  },
  {
    method: 'post',
    path: '/calculate',
    summary: 'Preview line and document totals (prices exclude tax)',
    permission: 'purchase.view',
    body: v.calculateSchema,
    noCreate: true,
  },
]);
documentRoutes(
  '/purchase/requisitions',
  'Purchase · Requisitions',
  crud('requisition', v.requisitionSchema, [
    action('submit', 'Submit (approves directly when requisition approval is off)', 'create'),
    action('approve', 'Approve', 'approve'),
    action('reject', 'Reject with a reason', 'approve', v.rejectSchema),
    action('cancel', 'Cancel', 'update'),
    action(
      'convert-to-order',
      'Create a draft PO from the lines still to order',
      'create',
      v.convertRequisitionToOrderSchema,
    ),
    action(
      'convert-to-rfq',
      'Create a draft RFQ to several suppliers',
      'create',
      v.convertRequisitionToRfqSchema,
    ),
  ]),
);
documentRoutes(
  '/purchase/rfqs',
  'Purchase · RFQs',
  crud('RFQ', v.rfqSchema, [
    action('send', 'Mark as sent', 'update'),
    {
      method: 'put',
      path: '/:id/suppliers/:rfqSupplierId/quote',
      summary: 'Record a supplier’s quote',
      permission: 'purchase.update',
      body: v.rfqQuoteSchema,
    },
    action('award', 'Award a supplier → draft PO at the quoted prices', 'approve', v.awardSchema),
    action('cancel', 'Cancel', 'update'),
  ]),
);
documentRoutes(
  '/purchase/orders',
  'Purchase · Orders',
  crud('purchase order', v.orderSchema, [
    action('submit', 'Submit for approval (levels by amount from Settings → Purchase)', 'create'),
    action('approve', 'Approve the next level', 'approve'),
    action('reject', 'Send back to draft with a reason', 'approve', v.rejectSchema),
    action('cancel', 'Cancel (nothing received yet)', 'update'),
    action('close', 'Close / short-close', 'update'),
    action('email', 'Email the PO (PDF attached) to the supplier', 'print', v.emailSchema),
    action('convert-to-receipt', 'Draft GRN for the quantities still to receive', 'create'),
    action('convert-to-bill', 'Draft bill for received, unbilled quantities', 'create'),
    {
      method: 'get',
      path: '/:id/print',
      summary: 'Order, company and print template for printing / PDF',
      permission: 'purchase.view',
    },
  ]),
);
documentRoutes(
  '/purchase/receipts',
  'Purchase · Goods receipts',
  crud('goods receipt', v.receiptSchema, [
    action('post', 'Post: stock in at landed cost', 'update'),
    action('cancel', 'Cancel a draft', 'update'),
    action('convert-to-bill', 'Draft bill for the unbilled lines', 'create'),
    action('convert-to-return', 'Draft return to the supplier', 'create'),
  ]),
);
documentRoutes(
  '/purchase/bills',
  'Purchase · Bills',
  crud('bill', v.billSchema, [
    action('post', 'Post (three-way match against received quantities)', 'update'),
    action('cancel', 'Cancel a draft or unpaid bill', 'approve'),
    action('convert-to-debit-note', 'Draft debit note against the bill', 'create'),
  ]),
);
documentRoutes('/purchase/payments', 'Purchase · Payments', [
  { method: 'get', path: '', summary: 'List payments', permission: 'purchase.view', list: true },
  {
    method: 'post',
    path: '',
    summary: 'Record a payment and allocate it to bills',
    permission: 'purchase.create',
    body: v.paymentSchema,
  },
  { method: 'get', path: '/:id', summary: 'Get a payment', permission: 'purchase.view' },
  action('void', 'Void a payment (reopens its bills)', 'approve', v.voidSchema),
]);
documentRoutes(
  '/purchase/returns',
  'Purchase · Returns & debit notes',
  crud('purchase return', v.returnSchema, [
    action('post', 'Post (returns take stock out; applies to the linked bill)', 'update'),
    action('cancel', 'Cancel a draft', 'update'),
  ]),
);
documentRoutes('/purchase', 'Purchase · Payables', [
  {
    method: 'post',
    path: '/payables/apply-credit',
    summary: 'Apply an advance or debit note to bills',
    permission: 'purchase.create',
    body: v.applyCreditSchema,
    noCreate: true,
  },
  {
    method: 'get',
    path: '/payables/aging',
    summary: 'Payables aging (not due, 1–30, 31–60, 61–90, 90+)',
    permission: 'purchase.view',
  },
  {
    method: 'get',
    path: '/payables/outstanding',
    summary: 'Outstanding payables per supplier',
    permission: 'purchase.view',
  },
  {
    method: 'get',
    path: '/suppliers/:supplierId/ledger',
    summary: 'Supplier ledger with running balance',
    permission: 'purchase.view',
  },
  {
    method: 'get',
    path: '/suppliers/:supplierId/open-items',
    summary: 'Open bills and unapplied credits of a supplier',
    permission: 'purchase.view',
  },
]);

export default router;
