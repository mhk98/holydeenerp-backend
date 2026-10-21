import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import * as challans from './challans.service.js';
import * as invoices from './invoices.service.js';
import * as orders from './orders.service.js';
import * as priceLists from './price-lists.service.js';
import * as quotations from './quotations.service.js';
import * as receipts from './receipts.service.js';
import * as receivables from './receivables.service.js';
import * as recurring from './recurring.service.js';
import * as returns from './returns.service.js';
import { priceSalesDocument, resolvePrices } from './sales.common.js';
import * as v from './sales.validation.js';

/**
 * Sales module (/api/v1/sales). Permission module: sales.*
 *   view     documents, customer ledger, receivables
 *   create   new documents, "convert to" actions, submit/confirm, challans and returns
 *   update   edit drafts, post challans / invoices / returns, close orders, reminders
 *   approve  override credit limits, cancel posted invoices, void receipts
 *   delete   delete drafts
 *   print    print / email invoices
 * Money receipts also accept accounting.create (accounting.approve to void).
 */
const router = Router();
router.use(authenticate, branchScope);
const can = (...actions) => authorize(...actions.map((a) => (a.includes('.') ? a : `sales.${a}`)));
const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });

function mountDocument(base, svc, { schema, actions = [], edit = ['update'] }) {
  router.get(base, can('view'), validate({ query: v.listQuery }), async (req, res) =>
    paginated(res, await svc.list(ctxOf(req), req.validated.query)),
  );
  router.post(base, can('create'), validate({ body: schema }), async (req, res) =>
    sendCreated(res, await svc.create(ctxOf(req), req.validated.body), `${svc.label} saved`),
  );
  router.get(`${base}/:id`, can('view'), validate({ params: idParams }), async (req, res) =>
    sendSuccess(res, { data: await svc.get(ctxOf(req), req.validated.params.id) }),
  );
  if (svc.update) {
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
        const data = await a.run(ctxOf(req), req.validated.params.id, req.validated.body ?? {});
        return a.created ? sendCreated(res, data, a.message) : sendSuccess(res, { data, message: a.message });
      },
    );
  }
}

// ── Pricing helpers ────────────────────────────────────────────────────────
router.get('/lookups', can('view', 'pos.view'), async (req, res) =>
  sendSuccess(res, { data: await priceLists.salesLookups(ctxOf(req)) }),
);
router.post('/prices', can('view', 'pos.view'), validate({ body: v.pricesQuery }), async (req, res) => {
  const { customerId, date, items } = req.validated.body;
  const today = date ?? new Date().toISOString().slice(0, 10);
  return sendSuccess(res, { data: await resolvePrices(ctxOf(req), { customerId, date: today, items }) });
});
router.post(
  '/calculate',
  can('view', 'pos.view'),
  validate({ body: v.calculateSchema }),
  async (req, res) => {
    const { items, ...header } = req.validated.body;
    const { lines, totals } = await priceSalesDocument(req.auth.companyId, items, header);
    return sendSuccess(res, {
      data: {
        lines: lines.map((l) => ({
          discountAmount: l.discountAmount,
          documentDiscount: l.documentDiscount,
          lineSubtotal: l.lineSubtotal,
          taxAmount: l.taxAmount,
          lineTotal: l.lineTotal,
        })),
        totals,
      },
    });
  },
);

// ── Price lists ────────────────────────────────────────────────────────────
mountDocument(
  '/price-lists',
  {
    label: 'Price list',
    list: priceLists.listPriceLists,
    get: priceLists.getPriceList,
    create: priceLists.createPriceList,
    update: priceLists.updatePriceList,
    remove: priceLists.deletePriceList,
  },
  { schema: v.priceListSchema },
);

// ── Quotations ─────────────────────────────────────────────────────────────
mountDocument(
  '/quotations',
  {
    label: 'Quotation',
    list: quotations.listQuotations,
    get: quotations.getQuotation,
    create: quotations.createQuotation,
    update: quotations.updateQuotation,
    remove: quotations.deleteQuotation,
  },
  {
    schema: v.quotationSchema,
    actions: [
      {
        path: 'send',
        permissions: ['create', 'update'],
        run: quotations.sendQuotation,
        message: 'Quotation marked as sent',
      },
      {
        path: 'accept',
        permissions: ['create', 'update'],
        run: quotations.acceptQuotation,
        message: 'Quotation accepted',
      },
      {
        path: 'decline',
        permissions: ['create', 'update'],
        run: quotations.declineQuotation,
        message: 'Quotation declined',
      },
      {
        path: 'cancel',
        permissions: ['update'],
        run: quotations.cancelQuotation,
        message: 'Quotation cancelled',
      },
      {
        path: 'convert-to-order',
        permissions: ['create'],
        body: v.convertWarehouseSchema,
        run: orders.orderFromQuotation,
        message: 'Sales order created',
        created: true,
      },
      {
        path: 'convert-to-invoice',
        permissions: ['create'],
        body: v.convertWarehouseSchema,
        run: invoices.invoiceFromQuotation,
        message: 'Invoice created',
        created: true,
      },
    ],
  },
);

// ── Orders ─────────────────────────────────────────────────────────────────
mountDocument(
  '/orders',
  {
    label: 'Sales order',
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
        path: 'confirm',
        permissions: ['create', 'update'],
        body: v.creditOverrideSchema,
        run: orders.confirmOrder,
        message: 'Order confirmed',
      },
      { path: 'cancel', permissions: ['update'], run: orders.cancelOrder, message: 'Order cancelled' },
      { path: 'close', permissions: ['update'], run: orders.closeOrder, message: 'Order closed' },
      {
        path: 'convert-to-challan',
        permissions: ['create'],
        run: challans.challanFromOrder,
        message: 'Delivery challan created',
        created: true,
      },
      {
        path: 'convert-to-invoice',
        permissions: ['create'],
        run: invoices.invoiceFromOrder,
        message: 'Invoice created',
        created: true,
      },
    ],
  },
);

// ── Delivery challans ──────────────────────────────────────────────────────
mountDocument(
  '/challans',
  {
    label: 'Delivery challan',
    list: challans.listChallans,
    get: challans.getChallan,
    create: challans.createChallan,
    update: challans.updateChallan,
    remove: challans.deleteChallan,
  },
  {
    schema: v.challanSchema,
    edit: ['create', 'update'],
    actions: [
      {
        path: 'post',
        permissions: ['create', 'update'],
        run: challans.postChallan,
        message: 'Goods delivered',
      },
      {
        path: 'cancel',
        permissions: ['create', 'update'],
        run: challans.cancelChallan,
        message: 'Challan cancelled',
      },
      {
        path: 'convert-to-invoice',
        permissions: ['create'],
        run: invoices.invoiceFromChallan,
        message: 'Invoice created',
        created: true,
      },
    ],
  },
);

// ── Invoices ───────────────────────────────────────────────────────────────
router.get('/invoices/:id/print', can('view'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, { data: await invoices.invoicePrintData(ctxOf(req), req.validated.params.id) }),
);
mountDocument(
  '/invoices',
  {
    label: 'Invoice',
    list: invoices.listInvoices,
    get: invoices.getInvoice,
    create: invoices.createInvoice,
    update: invoices.updateInvoice,
    remove: invoices.deleteInvoice,
  },
  {
    schema: v.invoiceSchema,
    actions: [
      {
        path: 'post',
        permissions: ['update'],
        body: v.creditOverrideSchema,
        run: invoices.postInvoice,
        message: 'Invoice posted',
      },
      { path: 'cancel', permissions: ['approve'], run: invoices.cancelInvoice, message: 'Invoice cancelled' },
      {
        path: 'email',
        permissions: ['print'],
        body: v.emailSchema,
        run: invoices.emailInvoice,
        message: 'Invoice emailed',
      },
      {
        path: 'remind',
        permissions: ['update'],
        body: v.remindSchema,
        run: invoices.remindInvoice,
        message: 'Reminder sent',
      },
      {
        path: 'make-recurring',
        permissions: ['create'],
        body: v.recurringSchema,
        run: recurring.makeRecurring,
        message: 'Recurring schedule created',
        created: true,
      },
      {
        path: 'convert-to-return',
        permissions: ['create'],
        body: v.returnFromInvoiceSchema,
        run: returns.returnFromInvoice,
        message: 'Return created',
        created: true,
      },
    ],
  },
);

// ── Receipts ───────────────────────────────────────────────────────────────
router.get('/receipts', can('view', 'accounting.view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await receipts.listReceipts(ctxOf(req), req.validated.query)),
);
router.post(
  '/receipts',
  can('create', 'accounting.create'),
  validate({ body: v.receiptSchema }),
  async (req, res) =>
    sendCreated(res, await receipts.createReceipt(ctxOf(req), req.validated.body), 'Money receipt recorded'),
);
router.get(
  '/receipts/:id',
  can('view', 'accounting.view'),
  validate({ params: idParams }),
  async (req, res) =>
    sendSuccess(res, { data: await receipts.getReceipt(ctxOf(req), req.validated.params.id) }),
);
router.post(
  '/receipts/:id/void',
  can('approve', 'accounting.approve'),
  validate({ params: idParams, body: v.voidSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await receipts.voidReceipt(ctxOf(req), req.validated.params.id, req.validated.body.reason),
      message: 'Receipt voided',
    }),
);
router.post(
  '/receivables/apply-credit',
  can('create', 'accounting.create'),
  validate({ body: v.applyCreditSchema }),
  async (req, res) => {
    await receipts.applyCredit(ctxOf(req), req.validated.body);
    return sendSuccess(res, { message: 'Credit applied' });
  },
);

// ── Returns / credit notes ─────────────────────────────────────────────────
mountDocument(
  '/returns',
  {
    label: 'Sales return',
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
      { path: 'post', permissions: ['update'], run: returns.postReturn, message: 'Return posted' },
      {
        path: 'cancel',
        permissions: ['create', 'update'],
        run: returns.cancelReturn,
        message: 'Return cancelled',
      },
    ],
  },
);

// ── Recurring invoices ─────────────────────────────────────────────────────
router.get('/recurring', can('view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await recurring.listRecurring(ctxOf(req), req.validated.query)),
);
router.get('/recurring/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, { data: await recurring.getRecurring(ctxOf(req), req.validated.params.id) }),
);
router.patch(
  '/recurring/:id',
  can('update'),
  validate({ params: idParams, body: v.recurringUpdateSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await recurring.updateRecurring(ctxOf(req), req.validated.params.id, req.validated.body),
      message: 'Schedule updated',
    }),
);
router.delete('/recurring/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await recurring.deleteRecurring(ctxOf(req), req.validated.params.id);
  return sendSuccess(res, { message: 'Schedule deleted' });
});
router.post('/recurring/:id/run', can('create'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, {
    data: await recurring.runNow(ctxOf(req), req.validated.params.id),
    message: 'Invoice created',
  }),
);

// ── Receivables ────────────────────────────────────────────────────────────
router.get(
  '/receivables/aging',
  can('view', 'accounting.view'),
  validate({ query: v.agingQuery }),
  async (req, res) =>
    sendSuccess(res, { data: await receivables.receivablesAging(ctxOf(req), req.validated.query) }),
);
router.get(
  '/customers/:customerId/ledger',
  can('view', 'accounting.view'),
  validate({ params: v.customerParams, query: v.ledgerQuery }),
  async (req, res) =>
    sendSuccess(res, {
      data: await receivables.customerLedger(
        ctxOf(req),
        req.validated.params.customerId,
        req.validated.query,
      ),
    }),
);
router.get(
  '/customers/:customerId/open-items',
  can('view', 'accounting.view'),
  validate({ params: v.customerParams }),
  async (req, res) =>
    sendSuccess(res, { data: await receivables.openItems(ctxOf(req), req.validated.params.customerId) }),
);

// ── Docs ───────────────────────────────────────────────────────────────────
const crud = (label, schema, extra = []) => [
  { method: 'get', path: '', summary: `List ${label}s`, permission: 'sales.view', list: true },
  { method: 'post', path: '', summary: `Create a ${label}`, permission: 'sales.create', body: schema },
  { method: 'get', path: '/:id', summary: `Get a ${label}`, permission: 'sales.view' },
  {
    method: 'put',
    path: '/:id',
    summary: `Replace a draft ${label}`,
    permission: 'sales.update',
    body: schema,
  },
  { method: 'delete', path: '/:id', summary: `Delete a draft ${label}`, permission: 'sales.delete' },
  ...extra,
];
const action = (path, summary, permission, body) => ({
  method: 'post',
  path: `/:id/${path}`,
  summary,
  permission: `sales.${permission}`,
  body,
  noCreate: true,
});
documentRoutes('/sales', 'Sales', [
  {
    method: 'get',
    path: '/lookups',
    summary: 'Tax groups, payment methods, customer groups and sales settings for the forms',
    permission: 'sales.view',
  },
  {
    method: 'post',
    path: '/prices',
    summary: 'Selling prices for a customer (price list of their group, else standard)',
    permission: 'sales.view',
    body: v.pricesQuery,
    noCreate: true,
  },
  {
    method: 'post',
    path: '/calculate',
    summary: 'Preview totals: line and document discounts, tax, rounding',
    permission: 'sales.view',
    body: v.calculateSchema,
    noCreate: true,
  },
]);
documentRoutes('/sales/price-lists', 'Sales · Price lists', crud('price list', v.priceListSchema));
documentRoutes(
  '/sales/quotations',
  'Sales · Quotations',
  crud('quotation', v.quotationSchema, [
    action('send', 'Mark as sent', 'create'),
    action('accept', 'Mark as accepted', 'create'),
    action('decline', 'Mark as declined', 'create'),
    action('cancel', 'Cancel', 'update'),
    action('convert-to-order', 'Create a draft sales order', 'create', v.convertWarehouseSchema),
    action('convert-to-invoice', 'Create a draft invoice', 'create', v.convertWarehouseSchema),
  ]),
);
documentRoutes(
  '/sales/orders',
  'Sales · Orders',
  crud('sales order', v.orderSchema, [
    action(
      'confirm',
      'Confirm (credit limit check; creditOverride.reason with sales.approve)',
      'create',
      v.creditOverrideSchema,
    ),
    action('cancel', 'Cancel (nothing delivered or invoiced)', 'update'),
    action('close', 'Close / short-close', 'update'),
    action('convert-to-challan', 'Draft challan for what is still to deliver', 'create'),
    action('convert-to-invoice', 'Draft invoice: uninvoiced challan lines + undelivered lines', 'create'),
  ]),
);
documentRoutes(
  '/sales/challans',
  'Sales · Delivery challans',
  crud('delivery challan', v.challanSchema, [
    action('post', 'Post: goods leave stock', 'update'),
    action('cancel', 'Cancel a draft', 'update'),
    action('convert-to-invoice', 'Draft invoice for the uninvoiced lines', 'create'),
  ]),
);
documentRoutes(
  '/sales/invoices',
  'Sales · Invoices',
  crud('invoice', v.invoiceSchema, [
    action(
      'post',
      'Post (credit check; lines without a challan take stock out)',
      'update',
      v.creditOverrideSchema,
    ),
    action('cancel', 'Cancel a draft, or an unpaid invoice that moved no stock', 'approve'),
    action('email', 'Email the invoice PDF', 'print', v.emailSchema),
    action('remind', 'Send a payment reminder', 'update', v.remindSchema),
    action('make-recurring', 'Repeat this invoice on a schedule', 'create', v.recurringSchema),
    action('convert-to-return', 'Draft sales return / credit note', 'create', v.returnFromInvoiceSchema),
    {
      method: 'get',
      path: '/:id/print',
      summary: 'Invoice, branding, amount in words (en/bn) and QR code',
      permission: 'sales.view',
    },
  ]),
);
documentRoutes('/sales/receipts', 'Sales · Money receipts', [
  { method: 'get', path: '', summary: 'List money receipts', permission: 'sales.view', list: true },
  {
    method: 'post',
    path: '',
    summary: 'Record a receipt and allocate it to invoices',
    permission: 'sales.create',
    body: v.receiptSchema,
  },
  { method: 'get', path: '/:id', summary: 'Get a receipt', permission: 'sales.view' },
  action('void', 'Void (reopens its invoices)', 'approve', v.voidSchema),
]);
documentRoutes(
  '/sales/returns',
  'Sales · Returns & credit notes',
  crud('sales return', v.returnSchema, [
    action('post', 'Post (returns put stock back; applies to the linked invoice)', 'update'),
    action('cancel', 'Cancel a draft', 'update'),
  ]),
);
documentRoutes('/sales', 'Sales · Receivables & recurring', [
  {
    method: 'post',
    path: '/receivables/apply-credit',
    summary: 'Apply an advance or credit note to invoices',
    permission: 'sales.create',
    body: v.applyCreditSchema,
    noCreate: true,
  },
  {
    method: 'get',
    path: '/receivables/aging',
    summary: 'Receivables aging (not due, 1–30, 31–60, 61–90, 90+)',
    permission: 'sales.view',
  },
  {
    method: 'get',
    path: '/customers/:customerId/ledger',
    summary: 'Customer ledger with running balance',
    permission: 'sales.view',
  },
  {
    method: 'get',
    path: '/customers/:customerId/open-items',
    summary: 'Open invoices and unapplied credits',
    permission: 'sales.view',
  },
  {
    method: 'get',
    path: '/recurring',
    summary: 'Recurring invoice schedules',
    permission: 'sales.view',
    list: true,
  },
  {
    method: 'patch',
    path: '/recurring/:id',
    summary: 'Update / pause a schedule',
    permission: 'sales.update',
    body: v.recurringUpdateSchema,
  },
  {
    method: 'post',
    path: '/recurring/:id/run',
    summary: 'Create the next invoice now',
    permission: 'sales.create',
    noCreate: true,
  },
]);

export default router;
