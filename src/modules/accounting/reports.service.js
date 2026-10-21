import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Account, JournalEntry, JournalLine, Party, Branch } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { assertBranchAccess, companyToday, invalid } from '../inventory/inventory.common.js';
import { addDays } from '../purchase/purchase.common.js';
import { DEBIT_NORMAL } from './accounting.model.js';
import { D, ensureLedger, fixed } from './ledger.service.js';

/**
 * Financial reports from posted journals: general ledger, trial balance, profit & loss, balance sheet,
 * cash flow (indirect), day book and VAT. Every report takes a date range (or as-of date) and an
 * optional branch; P&L and balance sheet also take a comparison period.
 *
 * Branches: with a branch chosen, only its lines count; otherwise every branch the user can see plus
 * company-level lines (no branch). Year-closing entries are left out of P&L-type figures (they only move
 * the year's result into retained earnings) but kept on the balance sheet.
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const nat = (type, signed) => (DEBIT_NORMAL.has(type) ? D(signed) : D(signed).neg());

/** SQL fragment + replacements limiting journal lines to the requested / visible branches. */
function branchFilter(ctx, query) {
  if (query.branchId) {
    assertBranchAccess(ctx, query.branchId);
    return { sql: 'AND l.branch_id = :branchId', params: { branchId: query.branchId } };
  }
  if (ctx.auth.isSuperAdmin) return { sql: '', params: {} };
  return {
    sql: 'AND (l.branch_id IS NULL OR l.branch_id IN (:branchIds))',
    params: { branchIds: ctx.branchIds.length ? ctx.branchIds : [0] },
  };
}

/** Debit / credit per account over [from, to] (either end optional). */
async function movements(ctx, query, { from, to, excludeClosing = false } = {}) {
  const b = branchFilter(ctx, query);
  const rows = await select(
    `SELECT l.account_id AS accountId, SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
      WHERE l.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL
        ${from ? 'AND j.entry_date >= :from' : ''} ${to ? 'AND j.entry_date <= :to' : ''}
        ${excludeClosing ? "AND j.entry_type <> 'closing'" : ''} ${b.sql}
      GROUP BY l.account_id`,
    { companyId: ctx.auth.companyId, from, to, ...b.params },
  );
  return new Map(rows.map((r) => [String(r.accountId), { debit: D(r.debit), credit: D(r.credit) }]));
}

async function chart(ctx) {
  await sequelize.transaction((t) => ensureLedger(ctx.auth.companyId, t));
  const rows = await Account.findAll({
    where: { companyId: ctx.auth.companyId },
    attributes: ['id', 'parentId', 'code', 'name', 'nameBn', 'type', 'subtype', 'isGroup', 'isActive'],
    order: [['code', 'ASC']],
    paranoid: false,
  });
  return rows.map((a) => ({
    ...a.toJSON(),
    id: String(a.id),
    parentId: a.parentId ? String(a.parentId) : null,
  }));
}

const accountRef = (a) => ({ accountId: a.id, code: a.code, name: a.name, nameBn: a.nameBn });

function period(query, defaults) {
  const from = query.from ?? defaults.from;
  const to = query.to ?? defaults.to;
  if (from && to && from > to) throw invalid('from', 'The start date is after the end date');
  return { from, to };
}

/** Start of the current fiscal year (Settings → Financial), as the default report start. */
async function fiscalYearStart(companyId, today) {
  const [row] = await select(
    `SELECT start_date AS startDate FROM fiscal_years
      WHERE company_id = :companyId AND start_date <= :today AND end_date >= :today AND deleted_at IS NULL LIMIT 1`,
    { companyId, today },
  );
  return row?.startDate ?? `${today.slice(0, 4)}-01-01`;
}

async function defaults(ctx) {
  const today = await companyToday(ctx.auth.companyId);
  return { today, from: await fiscalYearStart(ctx.auth.companyId, today), to: today };
}

// ── Trial balance ─────────────────────────────────────────────────────────

/** Opening, period debits / credits and closing per ledger account (signed debit − credit). */
export async function trialBalance(ctx, query) {
  const d = await defaults(ctx);
  const { from, to } = period(query, d);
  const accounts = await chart(ctx);
  const [before, during] = await Promise.all([
    from ? movements(ctx, query, { to: addDays(from, -1) }) : new Map(),
    movements(ctx, query, { from, to }),
  ]);
  const rows = [];
  const totals = {
    openingDebit: D(0),
    openingCredit: D(0),
    debit: D(0),
    credit: D(0),
    closingDebit: D(0),
    closingCredit: D(0),
  };
  for (const a of accounts.filter((x) => !x.isGroup)) {
    const b = before.get(a.id);
    const m = during.get(a.id);
    const opening = b ? b.debit.minus(b.credit) : D(0);
    const debit = m?.debit ?? D(0);
    const credit = m?.credit ?? D(0);
    const closing = opening.plus(debit).minus(credit);
    if (opening.isZero() && debit.isZero() && credit.isZero()) continue;
    rows.push({
      ...accountRef(a),
      type: a.type,
      opening: fixed(opening),
      debit: fixed(debit),
      credit: fixed(credit),
      closing: fixed(closing),
    });
    totals.openingDebit = totals.openingDebit.plus(opening.gt(0) ? opening : 0);
    totals.openingCredit = totals.openingCredit.plus(opening.lt(0) ? opening.neg() : 0);
    totals.debit = totals.debit.plus(debit);
    totals.credit = totals.credit.plus(credit);
    totals.closingDebit = totals.closingDebit.plus(closing.gt(0) ? closing : 0);
    totals.closingCredit = totals.closingCredit.plus(closing.lt(0) ? closing.neg() : 0);
  }
  return {
    from,
    to,
    rows,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, fixed(v)])),
    balanced: totals.closingDebit.eq(totals.closingCredit) && totals.debit.eq(totals.credit),
  };
}

// ── Profit & loss ─────────────────────────────────────────────────────────

const PL_SECTIONS = [
  ['revenue', (a) => a.type === 'income' && a.subtype === 'revenue'],
  ['salesReturns', (a) => a.type === 'income' && a.subtype === 'contra_revenue'],
  ['cogs', (a) => a.type === 'expense' && a.subtype === 'cogs'],
  ['expenses', (a) => a.type === 'expense' && a.subtype === 'expense'],
  ['otherIncome', (a) => a.type === 'income' && a.subtype === 'other_income'],
  ['otherExpenses', (a) => a.type === 'expense' && a.subtype === 'other_expense'],
];

/** Income-statement figures for one period: section → [{ account, amount }] (natural sign). */
async function plFigures(ctx, query, from, to, accounts) {
  const m = await movements(ctx, query, { from, to, excludeClosing: true });
  const amounts = new Map();
  for (const a of accounts.filter((x) => !x.isGroup && ['income', 'expense'].includes(x.type))) {
    const v = m.get(a.id);
    if (v) amounts.set(a.id, nat(a.type, v.debit.minus(v.credit)));
  }
  return amounts;
}

export async function profitLoss(ctx, query) {
  const d = await defaults(ctx);
  const { from, to } = period(query, d);
  const compare =
    query.compareFrom && query.compareTo ? { from: query.compareFrom, to: query.compareTo } : null;
  const accounts = await chart(ctx);
  const [current, previous] = await Promise.all([
    plFigures(ctx, query, from, to, accounts),
    compare ? plFigures(ctx, query, compare.from, compare.to, accounts) : null,
  ]);
  const sections = PL_SECTIONS.map(([key, match]) => {
    const rows = accounts
      .filter((a) => !a.isGroup && match(a) && (current.has(a.id) || previous?.has(a.id)))
      .map((a) => ({
        ...accountRef(a),
        amount: fixed(current.get(a.id) ?? 0),
        compare: previous ? fixed(previous.get(a.id) ?? 0) : null,
      }));
    const sum = (field) => rows.reduce((s, r) => s.plus(r[field] ?? 0), D(0));
    return { key, rows, total: fixed(sum('amount')), compareTotal: previous ? fixed(sum('compare')) : null };
  });
  const s = Object.fromEntries(sections.map((x) => [x.key, x]));
  const line = (pick) => {
    const value = (field) => pick((k) => D(s[k][field] ?? 0));
    return { amount: fixed(value('total')), compare: previous ? fixed(value('compareTotal')) : null };
  };
  // Sales returns are an income account with a debit balance: its natural amount is negative.
  const netSales = line((v) => v('revenue').plus(v('salesReturns')));
  const grossProfit = line((v) => v('revenue').plus(v('salesReturns')).minus(v('cogs')));
  const operatingProfit = line((v) =>
    v('revenue').plus(v('salesReturns')).minus(v('cogs')).minus(v('expenses')),
  );
  const netProfit = line((v) =>
    v('revenue')
      .plus(v('salesReturns'))
      .minus(v('cogs'))
      .minus(v('expenses'))
      .plus(v('otherIncome'))
      .minus(v('otherExpenses')),
  );
  return { from, to, compare, sections, netSales, grossProfit, operatingProfit, netProfit };
}

// ── Balance sheet ─────────────────────────────────────────────────────────

const BS_SECTIONS = [
  ['currentAssets', (a) => a.type === 'asset' && !['fixed_asset', 'contra_asset'].includes(a.subtype)],
  ['fixedAssets', (a) => a.type === 'asset' && ['fixed_asset', 'contra_asset'].includes(a.subtype)],
  ['currentLiabilities', (a) => a.type === 'liability' && a.subtype !== 'long_term_liability'],
  ['longTermLiabilities', (a) => a.type === 'liability' && a.subtype === 'long_term_liability'],
  ['equity', (a) => a.type === 'equity'],
];

/** Balances as of a date: per account (natural sign) + the profit not yet closed into equity. */
async function bsFigures(ctx, query, asOf, accounts) {
  const m = await movements(ctx, query, { to: asOf });
  const amounts = new Map();
  let earnings = D(0);
  for (const a of accounts.filter((x) => !x.isGroup)) {
    const v = m.get(a.id);
    if (!v) continue;
    const signed = v.debit.minus(v.credit);
    if (['income', 'expense'].includes(a.type)) earnings = earnings.minus(signed);
    else amounts.set(a.id, nat(a.type, signed));
  }
  return { amounts, earnings };
}

export async function balanceSheet(ctx, query) {
  const d = await defaults(ctx);
  const asOf = query.asOf ?? d.today;
  const compareAsOf = query.compareAsOf ?? null;
  const accounts = await chart(ctx);
  const [current, previous] = await Promise.all([
    bsFigures(ctx, query, asOf, accounts),
    compareAsOf ? bsFigures(ctx, query, compareAsOf, accounts) : null,
  ]);
  const sections = BS_SECTIONS.map(([key, match]) => {
    const rows = accounts
      .filter((a) => !a.isGroup && match(a) && (current.amounts.has(a.id) || previous?.amounts.has(a.id)))
      .map((a) => ({
        ...accountRef(a),
        // Contra assets (accumulated depreciation) reduce the section.
        amount: fixed(current.amounts.get(a.id) ?? 0),
        compare: previous ? fixed(previous.amounts.get(a.id) ?? 0) : null,
      }));
    if (key === 'equity') {
      rows.push({
        accountId: null,
        code: null,
        name: 'Current year earnings',
        nameBn: 'চলতি বছরের মুনাফা',
        amount: fixed(current.earnings),
        compare: previous ? fixed(previous.earnings) : null,
      });
    }
    const sum = (field) => rows.reduce((s, r) => s.plus(r[field] ?? 0), D(0));
    return { key, rows, total: fixed(sum('amount')), compareTotal: previous ? fixed(sum('compare')) : null };
  });
  const s = Object.fromEntries(sections.map((x) => [x.key, x]));
  const total = (keys, field) => keys.reduce((acc, k) => acc.plus(s[k][field] ?? 0), D(0));
  const assets = total(['currentAssets', 'fixedAssets'], 'total');
  const liabilitiesEquity = total(['currentLiabilities', 'longTermLiabilities', 'equity'], 'total');
  return {
    asOf,
    compareAsOf,
    sections,
    totalAssets: fixed(assets),
    totalLiabilitiesEquity: fixed(liabilitiesEquity),
    compareTotalAssets: previous ? fixed(total(['currentAssets', 'fixedAssets'], 'compareTotal')) : null,
    compareTotalLiabilitiesEquity: previous
      ? fixed(total(['currentLiabilities', 'longTermLiabilities', 'equity'], 'compareTotal'))
      : null,
    balanced: assets.eq(liabilitiesEquity),
  };
}

// ── Cash flow (indirect method) ───────────────────────────────────────────

const isCash = (a) => a.type === 'asset' && ['cash', 'bank'].includes(a.subtype);
/** Section of a non-cash balance-sheet account in the cash flow statement. */
function cashFlowLine(a) {
  if (a.type === 'asset' && a.subtype === 'contra_asset') return ['operating', 'depreciation'];
  if (a.type === 'asset' && a.subtype === 'fixed_asset') return ['investing', 'fixedAssets'];
  if (a.type === 'asset' && a.subtype === 'receivable') return ['operating', 'receivables'];
  if (a.type === 'asset' && a.subtype === 'inventory') return ['operating', 'inventory'];
  if (a.type === 'asset') return ['operating', 'otherCurrentAssets'];
  if (a.type === 'liability' && a.subtype === 'payable') return ['operating', 'payables'];
  if (a.type === 'liability' && a.subtype === 'long_term_liability') return ['financing', 'loans'];
  if (a.type === 'liability') return ['operating', 'otherCurrentLiabilities'];
  return ['financing', 'equity'];
}

export async function cashFlow(ctx, query) {
  const d = await defaults(ctx);
  const { from, to } = period(query, d);
  const accounts = await chart(ctx);
  const [during, before] = await Promise.all([
    movements(ctx, query, { from, to, excludeClosing: true }),
    movements(ctx, query, { to: addDays(from, -1) }),
  ]);
  let netProfit = D(0);
  let cashChange = D(0);
  let openingCash = D(0);
  const lines = new Map();
  for (const a of accounts.filter((x) => !x.isGroup)) {
    const v = during.get(a.id);
    const signed = v ? v.debit.minus(v.credit) : D(0);
    if (isCash(a)) {
      cashChange = cashChange.plus(signed);
      const o = before.get(a.id);
      if (o) openingCash = openingCash.plus(o.debit.minus(o.credit));
      continue;
    }
    if (!v) continue;
    if (['income', 'expense'].includes(a.type)) {
      netProfit = netProfit.minus(signed);
      continue;
    }
    // An increase in an asset uses cash; an increase in a liability / equity provides it.
    const key = cashFlowLine(a).join('.');
    lines.set(key, (lines.get(key) ?? D(0)).minus(signed));
  }
  const section = (name, extra = []) => {
    const rows = [
      ...extra,
      ...[...lines.entries()]
        .filter(([k]) => k.startsWith(`${name}.`))
        .map(([k, amount]) => ({ key: k.split('.')[1], amount: fixed(amount) })),
    ].filter((r) => !D(r.amount).isZero() || r.key === 'netProfit');
    return { rows, total: fixed(rows.reduce((s, r) => s.plus(r.amount), D(0))) };
  };
  const operating = section('operating', [{ key: 'netProfit', amount: fixed(netProfit) }]);
  const investing = section('investing');
  const financing = section('financing');
  const net = D(operating.total).plus(investing.total).plus(financing.total);
  return {
    from,
    to,
    operating,
    investing,
    financing,
    netChange: fixed(net),
    openingCash: fixed(openingCash),
    closingCash: fixed(openingCash.plus(cashChange)),
    balanced: net.eq(cashChange),
  };
}

// ── General ledger ────────────────────────────────────────────────────────

/** Lines of one or more accounts with an opening and running balance (natural sign). */
export async function generalLedger(ctx, query) {
  const d = await defaults(ctx);
  const { from, to } = period(query, d);
  const ids = String(query.accountId ?? '')
    .split(',')
    .filter((x) => /^\d+$/.test(x));
  if (!ids.length) throw invalid('accountId', 'Choose an account');
  const accounts = (await chart(ctx)).filter((a) => ids.includes(a.id) && !a.isGroup);
  if (!accounts.length) throw invalid('accountId', 'Account not found');
  const b = branchFilter(ctx, query);
  const before = await movements(ctx, query, { to: addDays(from, -1) });
  const lines = await select(
    `SELECT l.account_id AS accountId, l.debit, l.credit, l.description, j.id AS journalId, j.number, j.entry_date AS date,
            j.narration, j.reference, j.source_type AS sourceType, j.source_id AS sourceId, j.source_no AS sourceNo,
            p.name AS partyName
       FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
       LEFT JOIN parties p ON p.id = l.party_id
      WHERE l.company_id = :companyId AND l.account_id IN (:ids) AND j.status = 'posted' AND j.deleted_at IS NULL
        AND j.entry_date BETWEEN :from AND :to ${b.sql}
      ORDER BY j.entry_date, j.id, l.id
      LIMIT 20001`,
    { companyId: ctx.auth.companyId, ids, from, to, ...b.params },
  );
  if (lines.length > 20000) throw AppError.unprocessable('Too many lines; choose a shorter period');
  return {
    from,
    to,
    accounts: accounts.map((a) => {
      const o = before.get(a.id);
      const opening = nat(a.type, o ? o.debit.minus(o.credit) : 0);
      let running = opening;
      let debit = D(0);
      let credit = D(0);
      const rows = lines
        .filter((l) => String(l.accountId) === a.id)
        .map((l) => {
          debit = debit.plus(l.debit);
          credit = credit.plus(l.credit);
          running = running.plus(nat(a.type, D(l.debit).minus(l.credit)));
          return {
            date: l.date,
            journalId: String(l.journalId),
            number: l.number,
            narration: l.narration,
            description: l.description,
            reference: l.reference,
            sourceType: l.sourceType,
            sourceId: l.sourceId ? String(l.sourceId) : null,
            sourceNo: l.sourceNo,
            partyName: l.partyName,
            debit: fixed(l.debit),
            credit: fixed(l.credit),
            balance: fixed(running),
          };
        });
      return {
        ...accountRef(a),
        type: a.type,
        opening: fixed(opening),
        debit: fixed(debit),
        credit: fixed(credit),
        closing: fixed(running),
        rows,
      };
    }),
  };
}

// ── Day book ──────────────────────────────────────────────────────────────

/** Every posted journal in the period with its lines, in date order (paged). */
export async function dayBook(ctx, query) {
  const d = await defaults(ctx);
  const { from, to } = period(query, { from: d.today, to: d.today });
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const b = branchFilter(ctx, query);
  const where = `j.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL
    AND j.entry_date BETWEEN :from AND :to
    ${query.sourceType ? 'AND j.source_type = :sourceType' : ''}
    ${b.sql ? `AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.journal_id = j.id ${b.sql})` : ''}`;
  const params = { companyId: ctx.auth.companyId, from, to, sourceType: query.sourceType, ...b.params };
  const [[{ total, debit }], ids] = await Promise.all([
    select(
      `SELECT COUNT(*) AS total, COALESCE(SUM(j.total_debit), 0) AS debit FROM journal_entries j WHERE ${where}`,
      params,
    ),
    select(
      `SELECT j.id FROM journal_entries j WHERE ${where} ORDER BY j.entry_date, j.id LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset: (page - 1) * limit },
    ),
  ]);
  const entries = ids.length
    ? await JournalEntry.findAll({
        where: { id: ids.map((r) => r.id) },
        include: [
          { model: Branch, as: 'branch', attributes: ['id', 'name'] },
          {
            model: JournalLine,
            as: 'lines',
            separate: true,
            order: [['sortOrder', 'ASC']],
            include: [
              {
                model: Account,
                as: 'account',
                attributes: ['id', 'code', 'name', 'nameBn'],
                paranoid: false,
              },
              { model: Party, as: 'party', attributes: ['id', 'name'], paranoid: false },
            ],
          },
        ],
        order: [
          ['entryDate', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    : [];
  return {
    from,
    to,
    entries: entries.map((e) => e.toJSON()),
    totalDebit: fixed(debit),
    meta: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
  };
}

// ── VAT ───────────────────────────────────────────────────────────────────

/**
 * VAT for a period from the documents (by tax group): output on sales less credit notes, input on
 * supplier bills and expenses less debit notes; net payable = output − input.
 */
export async function vatReport(ctx, query) {
  const d = await defaults(ctx);
  const { from, to } = period(query, d);
  if (query.branchId) assertBranchAccess(ctx, query.branchId);
  const branchIds = query.branchId ? [query.branchId] : ctx.branchIds.length ? ctx.branchIds : [0];
  const p = { companyId: ctx.auth.companyId, from, to, branchIds };
  const byGroup = (doc, items, fk, dateCol, statuses, sign) =>
    select(
      `SELECT COALESCE(g.name, '—') AS taxGroup, ${sign} * SUM(i.line_subtotal) AS taxable, ${sign} * SUM(i.tax_amount) AS tax
         FROM ${items} i JOIN ${doc} d ON d.id = i.${fk}
         LEFT JOIN tax_groups g ON g.id = i.tax_group_id
        WHERE d.company_id = :companyId AND d.deleted_at IS NULL AND d.status IN (${statuses})
          AND d.${dateCol} BETWEEN :from AND :to AND d.branch_id IN (:branchIds)
        GROUP BY g.name HAVING SUM(i.tax_amount) <> 0 OR SUM(i.line_subtotal) <> 0`,
      p,
    );
  const POSTED = "'unpaid', 'partially_paid', 'paid'";
  const [sales, salesReturns, bills, purchaseReturns, [expenses]] = await Promise.all([
    byGroup('sales_invoices', 'sales_invoice_items', 'invoice_id', 'invoice_date', POSTED, 1),
    byGroup('sales_returns', 'sales_return_items', 'return_id', 'return_date', "'posted'", -1),
    byGroup('supplier_bills', 'supplier_bill_items', 'bill_id', 'bill_date', POSTED, 1),
    byGroup('purchase_returns', 'purchase_return_items', 'return_id', 'return_date', "'posted'", -1),
    select(
      `SELECT COALESCE(SUM(amount), 0) AS taxable, COALESCE(SUM(tax_amount), 0) AS tax FROM expenses
        WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
          AND expense_date BETWEEN :from AND :to AND branch_id IN (:branchIds) AND tax_amount <> 0`,
      p,
    ),
  ]);
  const block = (groups) => {
    const rows = groups.map((r) => ({ taxGroup: r.taxGroup, taxable: fixed(r.taxable), tax: fixed(r.tax) }));
    return {
      rows,
      taxable: fixed(rows.reduce((s, r) => s.plus(r.taxable), D(0))),
      tax: fixed(rows.reduce((s, r) => s.plus(r.tax), D(0))),
    };
  };
  const output = block([
    ...sales,
    ...salesReturns.map((r) => ({ ...r, taxGroup: `${r.taxGroup} (returns)` })),
  ]);
  const input = block([
    ...bills,
    ...purchaseReturns.map((r) => ({ ...r, taxGroup: `${r.taxGroup} (returns)` })),
    ...(D(expenses.tax).isZero()
      ? []
      : [{ taxGroup: 'Expenses', taxable: expenses.taxable, tax: expenses.tax }]),
  ]);
  return { from, to, output, input, netPayable: fixed(D(output.tax).minus(input.tax)) };
}
