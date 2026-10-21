import { Router } from 'express';
import { authorize } from '../../middlewares/rbac.js';
import { attachmentUpload, statementUpload } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { AppError } from '../../utils/AppError.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { createCrudRouter, ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import * as attachments from './attachments.service.js';
import { bankAccountOptions, bankAccounts } from './bank-accounts.service.js';
import * as recon from './bank-reconciliation.service.js';
import * as cheques from './cheques.service.js';
import * as expenses from './expenses.service.js';
import * as vouchers from './vouchers.service.js';
import * as v from './banking.validation.js';

/**
 * Cash & bank under /api/v1/accounting: money accounts, vouchers, cheques, bank reconciliation,
 * expenses and attachments. Mounted by accounting.routes.js after authentication and branch scope.
 *   view · create (vouchers, expenses, reconciliations) · update (edit drafts, cheque actions, matching)
 *   approve (void, complete / reopen reconciliations) · delete (drafts, unused accounts / categories)
 */
const router = Router();
const can = (...actions) => authorize(...actions.map((a) => `accounting.${a}`));
const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });
const ok = (res, data, message) => sendSuccess(res, { data, ...(message && { message }) });

// ── Money accounts and expense categories (CRUD) ──────────────────────────
router.use(
  '/bank-accounts',
  createCrudRouter({
    service: bankAccounts,
    basePath: '/accounting/bank-accounts',
    tag: 'Accounting · Cash & bank',
    label: 'Bank account',
    permission: 'accounting',
    createSchema: v.bankAccountSchema,
    updateSchema: v.bankAccountUpdateSchema,
    listQuerySchema: v.bankAccountListQuery,
    extend: (r) => {
      r.get('/options', can('view', 'create'), async (req, res) =>
        ok(res, await bankAccountOptions(ctxOf(req))),
      );
    },
  }),
);
router.use(
  '/expense-categories',
  createCrudRouter({
    service: expenses.expenseCategories,
    basePath: '/accounting/expense-categories',
    tag: 'Accounting · Expenses',
    label: 'Expense category',
    permission: 'accounting',
    createSchema: v.expenseCategorySchema,
    updateSchema: v.expenseCategoryUpdateSchema,
    listQuerySchema: v.listQuery,
  }),
);

// ── Vouchers ──────────────────────────────────────────────────────────────
router.get('/vouchers', can('view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await vouchers.listVouchers(ctxOf(req), req.validated.query)),
);
router.post('/vouchers', can('create'), validate({ body: v.voucherSchema }), async (req, res) =>
  sendCreated(res, await vouchers.createVoucher(ctxOf(req), req.validated.body), 'Voucher saved'),
);
router.get('/vouchers/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  ok(res, await vouchers.getVoucher(ctxOf(req), req.validated.params.id)),
);
router.put(
  '/vouchers/:id',
  can('update'),
  validate({ params: idParams, body: v.voucherSchema }),
  async (req, res) =>
    ok(
      res,
      await vouchers.updateVoucher(ctxOf(req), req.validated.params.id, req.validated.body),
      'Voucher updated',
    ),
);
router.delete('/vouchers/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await vouchers.deleteVoucher(ctxOf(req), req.validated.params.id);
  return ok(res, null, 'Voucher deleted');
});
router.post('/vouchers/:id/post', can('create'), validate({ params: idParams }), async (req, res) =>
  ok(res, await vouchers.postVoucher(ctxOf(req), req.validated.params.id), 'Voucher posted'),
);
router.post(
  '/vouchers/:id/void',
  can('approve'),
  validate({ params: idParams, body: v.voidSchema }),
  async (req, res) =>
    ok(
      res,
      await vouchers.voidVoucher(ctxOf(req), req.validated.params.id, req.validated.body.reason),
      'Voucher voided',
    ),
);

// ── Expenses ──────────────────────────────────────────────────────────────
router.get('/expenses', can('view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await expenses.listExpenses(ctxOf(req), req.validated.query)),
);
router.post('/expenses', can('create'), validate({ body: v.expenseSchema }), async (req, res) =>
  sendCreated(res, await expenses.createExpense(ctxOf(req), req.validated.body), 'Expense saved'),
);
router.get('/expenses/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  ok(res, await expenses.getExpense(ctxOf(req), req.validated.params.id)),
);
router.put(
  '/expenses/:id',
  can('update'),
  validate({ params: idParams, body: v.expenseSchema }),
  async (req, res) =>
    ok(
      res,
      await expenses.updateExpense(ctxOf(req), req.validated.params.id, req.validated.body),
      'Expense updated',
    ),
);
router.delete('/expenses/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await expenses.deleteExpense(ctxOf(req), req.validated.params.id);
  return ok(res, null, 'Expense deleted');
});
router.post('/expenses/:id/post', can('create'), validate({ params: idParams }), async (req, res) =>
  ok(res, await expenses.postExpense(ctxOf(req), req.validated.params.id), 'Expense posted'),
);
router.post(
  '/expenses/:id/void',
  can('approve'),
  validate({ params: idParams, body: v.voidSchema }),
  async (req, res) =>
    ok(
      res,
      await expenses.voidExpense(ctxOf(req), req.validated.params.id, req.validated.body.reason),
      'Expense voided',
    ),
);

// ── Attachments ───────────────────────────────────────────────────────────
router.post(
  '/attachments/:entityType/:entityId',
  can('create', 'update'),
  attachmentUpload,
  validate({ params: v.attachmentParams }),
  async (req, res) =>
    sendCreated(
      res,
      await attachments.addAttachments(
        ctxOf(req),
        req.validated.params.entityType,
        req.validated.params.entityId,
        req.files,
      ),
      'Files attached',
    ),
);
router.get('/attachments/:id', can('view'), validate({ params: idParams }), async (req, res) => {
  const file = await attachments.attachmentFile(ctxOf(req), req.validated.params.id);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
  );
  res.sendFile(file.path, (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: 'File not found' });
  });
});
router.delete('/attachments/:id', can('update'), validate({ params: idParams }), async (req, res) => {
  await attachments.removeAttachment(ctxOf(req), req.validated.params.id);
  return ok(res, null, 'File removed');
});

// ── Cheques ───────────────────────────────────────────────────────────────
router.get('/cheques', can('view'), validate({ query: v.listQuery }), async (req, res) =>
  paginated(res, await cheques.listCheques(ctxOf(req), req.validated.query)),
);
router.get('/cheques/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  ok(res, await cheques.getCheque(ctxOf(req), req.validated.params.id)),
);
router.patch(
  '/cheques/:id',
  can('update'),
  validate({ params: idParams, body: v.chequeUpdateSchema }),
  async (req, res) =>
    ok(
      res,
      await cheques.updateCheque(ctxOf(req), req.validated.params.id, req.validated.body),
      'Cheque updated',
    ),
);
for (const [action, schema, run, message, permission] of [
  ['deposit', v.chequeActionSchema, cheques.depositCheque, 'Cheque deposited', 'update'],
  ['clear', v.chequeActionSchema, cheques.clearCheque, 'Cheque cleared', 'update'],
  ['bounce', v.chequeBounceSchema, cheques.bounceCheque, 'Cheque marked as bounced', 'approve'],
]) {
  router.post(
    `/cheques/:id/${action}`,
    can(permission),
    validate({ params: idParams, body: schema }),
    async (req, res) => ok(res, await run(ctxOf(req), req.validated.params.id, req.validated.body), message),
  );
}

// ── Bank reconciliation ───────────────────────────────────────────────────
const R = '/reconciliations';
router.get(R, can('view'), async (req, res) =>
  ok(res, await recon.listReconciliations(ctxOf(req), req.query)),
);
router.post(R, can('create'), validate({ body: v.reconciliationSchema }), async (req, res) =>
  sendCreated(
    res,
    await recon.createReconciliation(ctxOf(req), req.validated.body),
    'Reconciliation started',
  ),
);
router.get(`${R}/:id`, can('view'), validate({ params: idParams }), async (req, res) =>
  ok(res, await recon.getReconciliation(ctxOf(req), req.validated.params.id)),
);
router.patch(
  `${R}/:id`,
  can('update'),
  validate({ params: idParams, body: v.reconciliationUpdateSchema }),
  async (req, res) =>
    ok(res, await recon.updateReconciliation(ctxOf(req), req.validated.params.id, req.validated.body)),
);
router.delete(`${R}/:id`, can('delete'), validate({ params: idParams }), async (req, res) => {
  await recon.deleteReconciliation(ctxOf(req), req.validated.params.id);
  return ok(res, null, 'Reconciliation deleted');
});
router.post(
  `${R}/:id/clear`,
  can('update'),
  validate({ params: idParams, body: v.clearLineSchema }),
  async (req, res) =>
    ok(res, await recon.setLineCleared(ctxOf(req), req.validated.params.id, req.validated.body)),
);
router.post(
  `${R}/:id/match`,
  can('update'),
  validate({ params: idParams, body: v.matchSchema }),
  async (req, res) =>
    ok(res, await recon.matchLines(ctxOf(req), req.validated.params.id, req.validated.body)),
);
router.post(`${R}/:id/auto-match`, can('update'), validate({ params: idParams }), async (req, res) =>
  ok(res, await recon.autoMatch(ctxOf(req), req.validated.params.id)),
);
router.post(
  `${R}/:id/statement`,
  can('update'),
  statementUpload,
  validate({ params: idParams }),
  async (req, res) => {
    let mapping = null;
    if (req.body?.mapping) {
      let raw;
      try {
        raw = JSON.parse(req.body.mapping);
      } catch {
        throw AppError.unprocessable('Invalid column mapping');
      }
      const parsed = v.statementMappingSchema.safeParse(raw);
      if (!parsed.success)
        throw AppError.unprocessable(
          'Invalid column mapping',
          parsed.error.issues.map((i) => ({ field: `mapping.${i.path.join('.')}`, message: i.message })),
        );
      mapping = parsed.data;
    }
    return ok(res, await recon.importStatement(ctxOf(req), req.validated.params.id, req.file, mapping));
  },
);
router.delete(
  `${R}/:id/statement/:lineId`,
  can('update'),
  validate({ params: v.statementParams }),
  async (req, res) =>
    ok(
      res,
      await recon.deleteStatementLine(ctxOf(req), req.validated.params.id, req.validated.params.lineId),
    ),
);
router.post(
  `${R}/:id/statement/:lineId/unmatch`,
  can('update'),
  validate({ params: v.statementParams }),
  async (req, res) =>
    ok(res, await recon.unmatchLine(ctxOf(req), req.validated.params.id, req.validated.params.lineId)),
);
router.post(
  `${R}/:id/statement/:lineId/book`,
  can('create'),
  validate({ params: v.statementParams, body: v.bookLineSchema }),
  async (req, res) =>
    ok(
      res,
      await recon.bookStatementLine(
        ctxOf(req),
        req.validated.params.id,
        req.validated.params.lineId,
        req.validated.body,
      ),
    ),
);
router.post(`${R}/:id/complete`, can('approve'), validate({ params: idParams }), async (req, res) =>
  ok(
    res,
    await recon.completeReconciliation(ctxOf(req), req.validated.params.id),
    'Reconciliation completed',
  ),
);
router.post(`${R}/:id/reopen`, can('approve'), validate({ params: idParams }), async (req, res) =>
  ok(res, await recon.reopenReconciliation(ctxOf(req), req.validated.params.id), 'Reconciliation reopened'),
);

const doc = (method, path, summary, permission, extra = {}) => ({
  method,
  path,
  summary,
  permission: `accounting.${permission}`,
  ...extra,
});
documentRoutes('/accounting', 'Accounting · Cash & bank', [
  doc('get', '/bank-accounts/options', 'Active cash / bank accounts with balances', 'view'),
  doc('get', '/vouchers', 'List vouchers', 'view', { list: true }),
  doc('post', '/vouchers', 'Create a receipt / payment / contra voucher (post: true to post)', 'create', {
    body: v.voucherSchema,
  }),
  doc('get', '/vouchers/:id', 'Get a voucher', 'view'),
  doc('put', '/vouchers/:id', 'Edit a draft voucher', 'update', { body: v.voucherSchema }),
  doc('delete', '/vouchers/:id', 'Delete a draft voucher', 'delete'),
  doc('post', '/vouchers/:id/post', 'Post a draft voucher', 'create'),
  doc('post', '/vouchers/:id/void', 'Void a posted voucher (reversing entry)', 'approve', {
    body: v.voidSchema,
  }),
  doc('get', '/expenses', 'List expenses', 'view', { list: true }),
  doc('post', '/expenses', 'Record an expense (post: true to post)', 'create', { body: v.expenseSchema }),
  doc('get', '/expenses/:id', 'Get an expense with its files', 'view'),
  doc('put', '/expenses/:id', 'Edit a draft expense', 'update', { body: v.expenseSchema }),
  doc('delete', '/expenses/:id', 'Delete a draft expense', 'delete'),
  doc('post', '/expenses/:id/post', 'Post a draft expense', 'create'),
  doc('post', '/expenses/:id/void', 'Void a posted expense', 'approve', { body: v.voidSchema }),
  doc(
    'post',
    '/attachments/:entityType/:entityId',
    'Attach files (field "files": JPG, PNG, WEBP, PDF)',
    'create',
    { multipart: true },
  ),
  doc('get', '/attachments/:id', 'Download / view an attached file', 'view'),
  doc('delete', '/attachments/:id', 'Remove an attached file', 'update'),
  doc('get', '/cheques', 'Cheque register', 'view', { list: true }),
  doc('get', '/cheques/:id', 'Get a cheque', 'view'),
  doc('patch', '/cheques/:id', 'Edit cheque details', 'update', { body: v.chequeUpdateSchema }),
  doc('post', '/cheques/:id/deposit', 'Deposit a received cheque', 'update', { body: v.chequeActionSchema }),
  doc('post', '/cheques/:id/clear', 'Mark a cheque cleared', 'update', { body: v.chequeActionSchema }),
  doc('post', '/cheques/:id/bounce', 'Mark a cheque bounced (voids its receipt / payment)', 'approve', {
    body: v.chequeBounceSchema,
  }),
  doc('get', '/reconciliations', 'Bank reconciliations', 'view'),
  doc('post', '/reconciliations', 'Start a reconciliation', 'create', { body: v.reconciliationSchema }),
  doc('get', '/reconciliations/:id', 'Reconciliation workspace (ledger, statement, summary)', 'view'),
  doc('patch', '/reconciliations/:id', 'Change the statement balance / notes', 'update', {
    body: v.reconciliationUpdateSchema,
  }),
  doc('delete', '/reconciliations/:id', 'Delete an in-progress reconciliation', 'delete'),
  doc('post', '/reconciliations/:id/clear', 'Tick / untick a ledger line', 'update', {
    body: v.clearLineSchema,
  }),
  doc('post', '/reconciliations/:id/match', 'Match a statement line to a ledger line', 'update', {
    body: v.matchSchema,
  }),
  doc('post', '/reconciliations/:id/auto-match', 'Match statement lines automatically', 'update'),
  doc(
    'post',
    '/reconciliations/:id/statement',
    'Import a CSV / XLSX statement (without mapping: preview)',
    'update',
    { multipart: true },
  ),
  doc('delete', '/reconciliations/:id/statement/:lineId', 'Delete an unmatched statement line', 'update'),
  doc('post', '/reconciliations/:id/statement/:lineId/unmatch', 'Unmatch a statement line', 'update'),
  doc(
    'post',
    '/reconciliations/:id/statement/:lineId/book',
    'Book a statement line as a voucher and match it',
    'create',
    { body: v.bookLineSchema },
  ),
  doc('post', '/reconciliations/:id/complete', 'Complete (difference must be zero)', 'approve'),
  doc('post', '/reconciliations/:id/reopen', 'Reopen the latest completed reconciliation', 'approve'),
]);

export default router;
