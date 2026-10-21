import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, branchScope } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { createCrudRouter, ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import { accountOptions, accounts, accountTree } from './accounts.service.js';
import { backfillCompany } from './backfill.service.js';
import * as fiscal from './fiscal.service.js';
import * as journals from './journals.service.js';
import { getMapping, saveMapping } from './mapping.service.js';
import { reconciliation } from './reconciliation.service.js';
import * as reports from './reports.service.js';
import bankingRoutes from './banking.routes.js';
import * as v from './accounting.validation.js';

/**
 * Accounting (/api/v1/accounting). Permission module: accounting.*
 *   view     chart, journals, fiscal years, mapping, ledger health check
 *   create   manual journals (draft and post), fiscal years
 *   update   edit accounts / drafts, opening balances, account mapping
 *   approve  reverse journals, lock / unlock periods, close / reopen years, rebuild journals
 *   delete   delete accounts, drafts and open fiscal years
 */
const router = Router();
const can = (...actions) => authorize(...actions.map((a) => (a.includes('.') ? a : `accounting.${a}`)));
const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });

// ── Chart of accounts ─────────────────────────────────────────────────────
router.use(
  '/accounts',
  createCrudRouter({
    service: accounts,
    basePath: '/accounting/accounts',
    tag: 'Accounting · Chart of accounts',
    label: 'Account',
    permission: 'accounting',
    createSchema: v.accountSchema,
    updateSchema: v.accountUpdateSchema,
    listQuerySchema: v.accountListQuery,
    extend: (r, { can: canDo }) => {
      r.get('/tree', canDo('view'), validate({ query: v.treeQuery }), async (req, res) =>
        sendSuccess(res, { data: await accountTree(ctxOf(req), req.validated.query) }),
      );
      r.get('/options', can('view', 'accounting.create', 'settings.view'), async (req, res) =>
        sendSuccess(res, { data: await accountOptions(ctxOf(req), req.query) }),
      );
    },
  }),
);

router.use(authenticate, branchScope);

// ── Journals ──────────────────────────────────────────────────────────────
router.get('/journals', can('view'), validate({ query: v.journalListQuery }), async (req, res) =>
  paginated(res, await journals.listJournals(ctxOf(req), req.validated.query)),
);
router.get(
  '/journals/source/:sourceType/:sourceId',
  can('view', 'sales.view', 'purchase.view', 'inventory.view', 'pos.view'),
  validate({ params: v.sourceParams }),
  async (req, res) =>
    sendSuccess(res, {
      data: await journals.sourceJournals(
        ctxOf(req),
        req.validated.params.sourceType,
        req.validated.params.sourceId,
      ),
    }),
);
router.get('/journals/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, { data: await journals.getJournal(ctxOf(req), req.validated.params.id) }),
);
router.post('/journals', can('create'), validate({ body: v.journalSchema }), async (req, res) =>
  sendCreated(
    res,
    await journals.createJournal(ctxOf(req), req.validated.body),
    req.validated.body.post ? 'Journal posted' : 'Journal saved as draft',
  ),
);
router.put(
  '/journals/:id',
  can('update'),
  validate({ params: idParams, body: v.journalSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await journals.updateJournal(ctxOf(req), req.validated.params.id, req.validated.body),
      message: 'Journal updated',
    }),
);
router.delete('/journals/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await journals.deleteJournal(ctxOf(req), req.validated.params.id);
  return sendSuccess(res, { message: 'Journal deleted' });
});
router.post('/journals/:id/post', can('create'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, {
    data: await journals.postJournalEntry(ctxOf(req), req.validated.params.id),
    message: 'Journal posted',
  }),
);
router.post(
  '/journals/:id/reverse',
  can('approve'),
  validate({ params: idParams, body: v.reverseSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await journals.reverseJournalEntry(ctxOf(req), req.validated.params.id, req.validated.body),
      message: 'Reversing entry posted',
    }),
);

// ── Opening balances ──────────────────────────────────────────────────────
router.get('/opening-balances', can('view'), async (req, res) =>
  sendSuccess(res, { data: await journals.getOpeningBalances(ctxOf(req)) }),
);
router.put(
  '/opening-balances',
  can('update'),
  validate({ body: v.openingBalancesSchema }),
  async (req, res) =>
    sendSuccess(res, {
      data: await journals.saveOpeningBalances(ctxOf(req), req.validated.body),
      message: 'Opening balances saved',
    }),
);

// ── Fiscal years and periods ──────────────────────────────────────────────
router.get('/fiscal-years', can('view'), async (req, res) =>
  sendSuccess(res, { data: await fiscal.listFiscalYears(ctxOf(req)) }),
);
router.post('/fiscal-years', can('create'), validate({ body: v.fiscalYearSchema }), async (req, res) =>
  sendCreated(res, await fiscal.createFiscalYear(ctxOf(req), req.validated.body), 'Fiscal year created'),
);
router.get('/fiscal-years/:id', can('view'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, { data: await fiscal.getFiscalYear(ctxOf(req), req.validated.params.id) }),
);
router.delete('/fiscal-years/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await fiscal.deleteFiscalYear(ctxOf(req), req.validated.params.id);
  return sendSuccess(res, { message: 'Fiscal year deleted' });
});
router.post('/fiscal-years/:id/close', can('approve'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, {
    data: await fiscal.closeFiscalYear(ctxOf(req), req.validated.params.id),
    message: 'Fiscal year closed',
  }),
);
router.post('/fiscal-years/:id/reopen', can('approve'), validate({ params: idParams }), async (req, res) =>
  sendSuccess(res, {
    data: await fiscal.reopenFiscalYear(ctxOf(req), req.validated.params.id),
    message: 'Fiscal year reopened',
  }),
);
router.patch(
  '/periods/:id',
  can('approve'),
  validate({ params: idParams, body: v.periodStatusSchema }),
  async (req, res) => {
    await fiscal.setPeriodStatus(ctxOf(req), req.validated.params.id, req.validated.body.status);
    return sendSuccess(res, {
      message: req.validated.body.status === 'locked' ? 'Period locked' : 'Period unlocked',
    });
  },
);

// ── Account mapping, health check, rebuild ────────────────────────────────
router.get('/mapping', can('view', 'settings.view'), async (req, res) =>
  sendSuccess(res, { data: await getMapping(ctxOf(req)) }),
);
router.put('/mapping', can('update'), validate({ body: v.mappingSchema }), async (req, res) =>
  sendSuccess(res, {
    data: await saveMapping(ctxOf(req), req.validated.body),
    message: 'Account mapping saved',
  }),
);
router.get('/reconciliation', can('view'), async (req, res) =>
  sendSuccess(res, { data: await reconciliation(ctxOf(req)) }),
);
router.post('/backfill', can('approve'), async (req, res) =>
  sendSuccess(res, {
    data: await backfillCompany(req.auth.companyId, { userId: req.auth.userId }),
    message: 'Missing journals posted',
  }),
);

// ── Cash & bank (vouchers, cheques, reconciliation, expenses) ─────────────
router.use(bankingRoutes);

// ── Financial reports ─────────────────────────────────────────────────────
const REPORTS = {
  'trial-balance': reports.trialBalance,
  'profit-loss': reports.profitLoss,
  'balance-sheet': reports.balanceSheet,
  'cash-flow': reports.cashFlow,
  'general-ledger': reports.generalLedger,
  'day-book': reports.dayBook,
  vat: reports.vatReport,
};
for (const [name, run] of Object.entries(REPORTS)) {
  router.get(`/reports/${name}`, can('view'), validate({ query: v.reportQuery }), async (req, res) =>
    sendSuccess(res, { data: await run(ctxOf(req), req.validated.query) }),
  );
}
documentRoutes(
  '/accounting/reports',
  'Accounting · Reports',
  Object.keys(REPORTS).map((name) => ({
    method: 'get',
    path: `/${name}`,
    summary: `${name.replace('-', ' ')} (from, to | asOf, branchId, compareFrom / compareTo / compareAsOf, accountId)`,
    permission: 'accounting.view',
  })),
);

documentRoutes('/accounting', 'Accounting', [
  {
    method: 'get',
    path: '/accounts/tree',
    summary: 'Chart of accounts as a tree (with balances)',
    permission: 'accounting.view',
  },
  {
    method: 'get',
    path: '/accounts/options',
    summary: 'Postable accounts for pickers',
    permission: 'accounting.view',
  },
  {
    method: 'get',
    path: '/journals',
    summary: 'List journal entries',
    permission: 'accounting.view',
    list: true,
  },
  {
    method: 'get',
    path: '/journals/source/:sourceType/:sourceId',
    summary: 'Journals posted by a document',
    permission: 'accounting.view',
  },
  {
    method: 'get',
    path: '/journals/:id',
    summary: 'Get a journal entry with its lines',
    permission: 'accounting.view',
  },
  {
    method: 'post',
    path: '/journals',
    summary: 'Create a manual journal (draft, or post: true)',
    permission: 'accounting.create',
    body: v.journalSchema,
  },
  {
    method: 'put',
    path: '/journals/:id',
    summary: 'Edit a draft journal',
    permission: 'accounting.update',
    body: v.journalSchema,
  },
  {
    method: 'delete',
    path: '/journals/:id',
    summary: 'Delete a draft journal',
    permission: 'accounting.delete',
  },
  {
    method: 'post',
    path: '/journals/:id/post',
    summary: 'Post a draft journal',
    permission: 'accounting.create',
  },
  {
    method: 'post',
    path: '/journals/:id/reverse',
    summary: 'Reverse a posted manual / opening journal',
    permission: 'accounting.approve',
    body: v.reverseSchema,
  },
  {
    method: 'get',
    path: '/opening-balances',
    summary: 'Current opening balances entry',
    permission: 'accounting.view',
  },
  {
    method: 'put',
    path: '/opening-balances',
    summary: 'Replace the opening balances',
    permission: 'accounting.update',
    body: v.openingBalancesSchema,
  },
  {
    method: 'get',
    path: '/fiscal-years',
    summary: 'Fiscal years with their periods',
    permission: 'accounting.view',
  },
  {
    method: 'post',
    path: '/fiscal-years',
    summary: 'Create a fiscal year (monthly periods)',
    permission: 'accounting.create',
    body: v.fiscalYearSchema,
  },
  { method: 'get', path: '/fiscal-years/:id', summary: 'Get a fiscal year', permission: 'accounting.view' },
  {
    method: 'delete',
    path: '/fiscal-years/:id',
    summary: 'Delete an open fiscal year',
    permission: 'accounting.delete',
  },
  {
    method: 'post',
    path: '/fiscal-years/:id/close',
    summary: 'Close a year (lock periods, closing entry)',
    permission: 'accounting.approve',
  },
  {
    method: 'post',
    path: '/fiscal-years/:id/reopen',
    summary: 'Reopen a closed year',
    permission: 'accounting.approve',
  },
  {
    method: 'patch',
    path: '/periods/:id',
    summary: 'Lock or unlock a period',
    permission: 'accounting.approve',
    body: v.periodStatusSchema,
  },
  {
    method: 'get',
    path: '/mapping',
    summary: 'Account mapping for automatic postings',
    permission: 'accounting.view',
  },
  {
    method: 'put',
    path: '/mapping',
    summary: 'Save the account mapping',
    permission: 'accounting.update',
    body: v.mappingSchema,
  },
  {
    method: 'get',
    path: '/reconciliation',
    summary: 'Ledger health check (trial balance, AR, AP, stock)',
    permission: 'accounting.view',
  },
  {
    method: 'post',
    path: '/backfill',
    summary: 'Post journals missing for existing documents',
    permission: 'accounting.approve',
  },
]);

export default router;
