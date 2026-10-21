import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { assertBranchAccess, companyToday } from '../inventory/inventory.common.js';
import { D, addDays, fixed } from '../purchase/purchase.common.js';

/**
 * Main dashboard: KPIs with the previous period, charts and widgets, aggregated in SQL over all modules.
 * Money figures come from the ledger (posted journals, year-closing entries left out) so they agree with
 * the financial reports; purchases come from posted supplier bills. Each part is only built when the user
 * may see it (see CAN) and results are cached per company / branches / period / permissions for a minute.
 *
 * Periods: today, this week (from Saturday), this month, or a custom from–to; the previous period is the
 * same length right before it.
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const POSTED = ['unpaid', 'partially_paid', 'paid'];
const OPEN_MO = ['draft', 'confirmed', 'material_issued', 'in_progress', 'quality_check'];

// ── Who sees what ─────────────────────────────────────────────────────────

const has = (ctx, key) => {
  const p = ctx.auth.permissions ?? [];
  return p.includes('*') || p.includes(key);
};
const any = (ctx, ...keys) => keys.some((k) => has(ctx, k));
const insight = (ctx) => any(ctx, 'reports.view', 'accounting.view');
export const CAN = {
  sales: (ctx) => has(ctx, 'sales.view') && insight(ctx),
  purchases: (ctx) => has(ctx, 'purchase.view') && insight(ctx),
  finance: (ctx) => has(ctx, 'accounting.view'),
  stock: (ctx) => has(ctx, 'inventory.view') && insight(ctx),
  production: (ctx) => has(ctx, 'manufacturing.view'),
  pos: (ctx) => has(ctx, 'pos.view'),
};

// ── Period and scope ──────────────────────────────────────────────────────

const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

export async function resolvePeriod(companyId, { range = 'month', from, to }) {
  const today = await companyToday(companyId);
  let start = today;
  let end = today;
  if (range === 'week') {
    // Bangladesh week: Saturday – Friday.
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    start = addDays(today, -((dow + 1) % 7));
  } else if (range === 'month') {
    start = `${today.slice(0, 8)}01`;
  } else if (range === 'custom') {
    start = from ?? today;
    end = to ?? today;
  }
  const length = days(start, end);
  return {
    range,
    today,
    from: start,
    to: end,
    previous: { from: addDays(start, -length), to: addDays(start, -1) },
    bucket: length > 62 ? 'month' : 'day',
  };
}

/** The branches a request covers: the chosen one (checked) or all the user's. */
export function scopeOf(ctx, branchId) {
  if (branchId) {
    assertBranchAccess(ctx, branchId);
    return { ...ctx, branchIds: [String(branchId)], branchId: String(branchId), allBranches: false };
  }
  return { ...ctx, allBranches: true };
}

/** Journal-line branch filter: one branch, or the user's branches plus company-level lines. */
function lineBranches(ctx) {
  if (!ctx.allBranches)
    return { sql: 'AND l.branch_id IN (:branchIds)', params: { branchIds: ctx.branchIds } };
  if (ctx.auth.isSuperAdmin) return { sql: '', params: {} };
  return {
    sql: 'AND (l.branch_id IS NULL OR l.branch_id IN (:branchIds))',
    params: { branchIds: ctx.branchIds.length ? ctx.branchIds : [0] },
  };
}
const docBranches = (ctx, alias) => ({
  sql: `AND ${alias}.branch_id IN (:branchIds)`,
  params: { branchIds: ctx.branchIds.length ? ctx.branchIds : [0] },
});

// ── Cache ─────────────────────────────────────────────────────────────────

const TTL = 60_000;
const cache = new Map();
async function cached(ctx, part, extra, build, { refresh = false } = {}) {
  const key = JSON.stringify([
    part,
    ctx.auth.companyId,
    ctx.auth.isSuperAdmin ? '*' : ctx.branchIds,
    ctx.allBranches,
    [...(ctx.auth.permissions ?? [])].sort(),
    extra,
  ]);
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await build();
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
/** Drop cached dashboards of a company (e.g. after an approval from the dashboard). */
export function forgetDashboard(companyId) {
  for (const key of cache.keys()) if (JSON.parse(key)[1] === companyId) cache.delete(key);
}

// ── Ledger helpers ────────────────────────────────────────────────────────

/** Signed debit − credit per (type, subtype, system key) over a date range, optionally bucketed. */
async function ledgerBy(ctx, { from, to, bucket }) {
  const b = lineBranches(ctx);
  const fmt = bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
  return select(
    `SELECT a.type, a.subtype, a.system_key AS systemKey,
            ${bucket ? `DATE_FORMAT(j.entry_date, '${fmt}')` : 'NULL'} AS bucket,
            SUM(l.debit) - SUM(l.credit) AS amount
       FROM journal_lines l
       JOIN journal_entries j ON j.id = l.journal_id
       JOIN accounts a ON a.id = l.account_id
      WHERE l.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL
        AND j.entry_type <> 'closing' AND j.entry_date BETWEEN :from AND :to ${b.sql}
      GROUP BY a.type, a.subtype, a.system_key, bucket`,
    { companyId: ctx.auth.companyId, from, to, ...b.params },
  );
}

/** Profit figures from ledger rows (natural sign): net sales, COGS, expenses, gross / net profit. */
function profitOf(rows) {
  let sales = D(0);
  let cogs = D(0);
  let expenses = D(0);
  let other = D(0);
  for (const r of rows) {
    const v = D(r.amount);
    if (r.type === 'income' && ['revenue', 'contra_revenue'].includes(r.subtype)) sales = sales.minus(v);
    else if (r.type === 'income') other = other.minus(v);
    else if (r.type === 'expense' && r.subtype === 'cogs') cogs = cogs.plus(v);
    else if (r.type === 'expense') expenses = expenses.plus(v);
  }
  return {
    sales,
    cogs,
    grossProfit: sales.minus(cogs),
    netProfit: sales.minus(cogs).minus(expenses).plus(other),
  };
}

/** Balances as of a date: receivables, payables, cash & bank. */
async function balancesAsOf(ctx, asOf) {
  const b = lineBranches(ctx);
  const rows = await select(
    `SELECT SUM(CASE WHEN a.system_key = 'ar' THEN l.debit - l.credit ELSE 0 END) AS receivables,
            SUM(CASE WHEN a.system_key = 'ap' THEN l.credit - l.debit ELSE 0 END) AS payables,
            SUM(CASE WHEN a.type = 'asset' AND a.subtype IN ('cash', 'bank') THEN l.debit - l.credit ELSE 0 END) AS cash
       FROM journal_lines l
       JOIN journal_entries j ON j.id = l.journal_id
       JOIN accounts a ON a.id = l.account_id
      WHERE l.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL
        AND j.entry_date <= :asOf ${b.sql}`,
    { companyId: ctx.auth.companyId, asOf, ...b.params },
  );
  return { receivables: D(rows[0]?.receivables), payables: D(rows[0]?.payables), cash: D(rows[0]?.cash) };
}

async function purchasesBy(ctx, { from, to, bucket }) {
  const b = docBranches(ctx, 'sb');
  const fmt = bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
  return select(
    `SELECT ${bucket ? `DATE_FORMAT(sb.bill_date, '${fmt}')` : 'NULL'} AS bucket,
            SUM(sb.subtotal - sb.discount_total) AS amount
       FROM supplier_bills sb
      WHERE sb.company_id = :companyId AND sb.deleted_at IS NULL AND sb.status IN (:posted)
        AND sb.bill_date BETWEEN :from AND :to ${b.sql}
      GROUP BY bucket`,
    { companyId: ctx.auth.companyId, from, to, posted: POSTED, ...b.params },
  );
}

async function stockValueAsOf(ctx, asOf) {
  const b = docBranches(ctx, 'm');
  const [row] = await select(
    `SELECT COALESCE(SUM(m.total_cost), 0) AS value FROM stock_movements m
      WHERE m.company_id = :companyId AND m.movement_date <= :asOf ${b.sql}`,
    { companyId: ctx.auth.companyId, asOf, ...b.params },
  );
  return D(row.value);
}

const kpi = (current, previous) => {
  const c = D(current);
  const p = previous == null ? null : D(previous);
  return {
    value: fixed(c),
    previous: p == null ? null : fixed(p),
    changePercent: p == null || p.isZero() ? null : fixed(c.minus(p).dividedBy(p.abs()).times(100), 1),
  };
};

// ── KPIs ──────────────────────────────────────────────────────────────────

export async function dashboardKpis(ctx, query) {
  const period = await resolvePeriod(ctx.auth.companyId, query);
  return cached(
    ctx,
    'kpis',
    [period.from, period.to],
    async () => {
      const out = { period, kpis: {} };
      const tasks = [];
      if (CAN.sales(ctx) || CAN.finance(ctx)) {
        tasks.push(
          Promise.all([ledgerBy(ctx, period), ledgerBy(ctx, period.previous)]).then(([cur, prev]) => {
            const [c, p] = [profitOf(cur), profitOf(prev)];
            if (CAN.sales(ctx)) out.kpis.sales = kpi(c.sales, p.sales);
            if (CAN.finance(ctx)) out.kpis.grossProfit = kpi(c.grossProfit, p.grossProfit);
          }),
        );
      }
      if (CAN.purchases(ctx)) {
        tasks.push(
          Promise.all([purchasesBy(ctx, period), purchasesBy(ctx, period.previous)]).then(([cur, prev]) => {
            out.kpis.purchases = kpi(cur[0]?.amount ?? 0, prev[0]?.amount ?? 0);
          }),
        );
      }
      if (CAN.finance(ctx)) {
        tasks.push(
          Promise.all([balancesAsOf(ctx, period.to), balancesAsOf(ctx, period.previous.to)]).then(
            ([cur, prev]) => {
              out.kpis.receivables = kpi(cur.receivables, prev.receivables);
              out.kpis.payables = kpi(cur.payables, prev.payables);
              out.kpis.cashBalance = kpi(cur.cash, prev.cash);
            },
          ),
        );
      }
      if (CAN.stock(ctx)) {
        tasks.push(
          Promise.all([stockValueAsOf(ctx, period.to), stockValueAsOf(ctx, period.previous.to)]).then(
            ([c, p]) => {
              out.kpis.stockValue = kpi(c, p);
            },
          ),
        );
      }
      if (CAN.production(ctx)) {
        tasks.push(
          select(
            `SELECT COUNT(*) AS n, SUM(planned_end < :today) AS late FROM manufacturing_orders mo
            WHERE mo.company_id = :companyId AND mo.deleted_at IS NULL AND mo.status IN (:open) ${docBranches(ctx, 'mo').sql}`,
            {
              companyId: ctx.auth.companyId,
              open: OPEN_MO,
              today: period.today,
              ...docBranches(ctx, 'mo').params,
            },
          ).then(([r]) => {
            out.kpis.pendingProduction = { ...kpi(r.n, null), late: Number(r.late ?? 0) };
          }),
        );
      }
      await Promise.all(tasks);
      return out;
    },
    { refresh: query.refresh === 'true' },
  );
}

// ── Charts ────────────────────────────────────────────────────────────────

/** Every bucket key between from and to (so charts have no gaps). */
function bucketsOf({ from, to, bucket }) {
  const keys = [];
  if (bucket === 'month') {
    let [y, m] = from.slice(0, 7).split('-').map(Number);
    const last = to.slice(0, 7);
    for (;;) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      keys.push(k);
      if (k >= last) break;
      m += 1;
      if (m > 12) [y, m] = [y + 1, 1];
    }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) keys.push(d);
  }
  return keys;
}

async function salesLines(ctx, { from, to }, groupBy, limit) {
  const b = docBranches(ctx, 'i');
  return select(
    `SELECT ${groupBy.select}, SUM(it.line_subtotal) AS amount, SUM(it.base_quantity) AS quantity
       FROM sales_invoice_items it
       JOIN sales_invoices i ON i.id = it.invoice_id
       JOIN products p ON p.id = it.product_id
       ${groupBy.join ?? ''}
      WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.status IN (:posted)
        AND i.invoice_date BETWEEN :from AND :to ${b.sql}
      GROUP BY ${groupBy.group}
      ORDER BY amount DESC LIMIT ${limit}`,
    { companyId: ctx.auth.companyId, from, to, posted: POSTED, ...b.params },
  );
}

export async function dashboardCharts(ctx, query) {
  const period = await resolvePeriod(ctx.auth.companyId, query);
  return cached(
    ctx,
    'charts',
    [period.from, period.to],
    async () => {
      const out = { period, charts: {} };
      const keys = bucketsOf(period);
      const tasks = [];

      if (CAN.sales(ctx) || CAN.purchases(ctx)) {
        tasks.push(
          Promise.all([
            CAN.sales(ctx) ? ledgerBy(ctx, period) : [],
            CAN.purchases(ctx) ? purchasesBy(ctx, period) : [],
          ]).then(([ledger, bills]) => {
            const sales = new Map();
            for (const r of ledger) {
              if (r.type === 'income' && ['revenue', 'contra_revenue'].includes(r.subtype))
                sales.set(r.bucket, (sales.get(r.bucket) ?? D(0)).minus(r.amount));
            }
            const buys = new Map(bills.map((r) => [r.bucket, D(r.amount)]));
            out.charts.salesVsPurchases = keys.map((k) => ({
              bucket: k,
              ...(CAN.sales(ctx) && { sales: fixed(sales.get(k) ?? 0) }),
              ...(CAN.purchases(ctx) && { purchases: fixed(buys.get(k) ?? 0) }),
            }));
          }),
        );
      }
      if (CAN.sales(ctx)) {
        tasks.push(
          salesLines(
            ctx,
            period,
            {
              select: 'c.id AS categoryId, COALESCE(c.name, NULL) AS name',
              join: 'LEFT JOIN product_categories c ON c.id = p.category_id',
              group: 'c.id, c.name',
            },
            12,
          ).then((rows) => {
            out.charts.salesByCategory = rows.map((r) => ({
              categoryId: r.categoryId,
              name: r.name,
              amount: fixed(r.amount),
            }));
          }),
          salesLines(
            ctx,
            period,
            { select: 'p.id AS productId, p.name, p.sku', group: 'p.id, p.name, p.sku' },
            10,
          ).then((rows) => {
            out.charts.topProducts = rows.map((r) => ({
              ...r,
              amount: fixed(r.amount),
              quantity: fixed(r.quantity),
            }));
          }),
        );
      }
      if (CAN.finance(ctx)) {
        // Last 12 months ending with the period.
        const end = period.to;
        const [y, m] = end.slice(0, 7).split('-').map(Number);
        const back = new Date(Date.UTC(y, m - 12, 1)); // first day, 11 months before the period's month
        const start = back.toISOString().slice(0, 10);
        tasks.push(
          ledgerBy(ctx, { from: start, to: end, bucket: 'month' }).then((rows) => {
            const months = bucketsOf({ from: start, to: end, bucket: 'month' });
            out.charts.monthlyProfit = months.map((m) => {
              const p = profitOf(rows.filter((r) => r.bucket === m));
              return {
                bucket: m,
                sales: fixed(p.sales),
                grossProfit: fixed(p.grossProfit),
                netProfit: fixed(p.netProfit),
              };
            });
          }),
        );
      }
      if (CAN.production(ctx)) {
        const fmt = period.bucket === 'month' ? '%Y-%m' : '%Y-%m-%d';
        const b = docBranches(ctx, 'mo');
        tasks.push(
          select(
            `SELECT DATE_FORMAT(o.output_date, '${fmt}') AS bucket, SUM(o.quantity) AS quantity, SUM(o.total_cost) AS cost
             FROM mo_outputs o JOIN manufacturing_orders mo ON mo.id = o.order_id
            WHERE mo.company_id = :companyId AND mo.deleted_at IS NULL AND o.kind = 'product'
              AND o.output_date BETWEEN :from AND :to ${b.sql}
            GROUP BY bucket`,
            { companyId: ctx.auth.companyId, from: period.from, to: period.to, ...b.params },
          ).then((rows) => {
            const by = new Map(rows.map((r) => [r.bucket, r]));
            out.charts.productionOutput = keys.map((k) => ({
              bucket: k,
              quantity: fixed(by.get(k)?.quantity ?? 0),
              cost: fixed(by.get(k)?.cost ?? 0),
            }));
          }),
        );
      }
      await Promise.all(tasks);
      return out;
    },
    { refresh: query.refresh === 'true' },
  );
}

// ── Widgets ───────────────────────────────────────────────────────────────

/** Documents waiting for this user's approval, newest first, with the endpoint that approves them. */
const APPROVALS = [
  {
    type: 'stock_adjustment',
    permission: 'inventory.approve',
    table: 'stock_adjustments',
    date: 'adjustment_date',
    amount: 'NULL',
    path: '/inventory/adjustments',
  },
  {
    type: 'stock_count',
    permission: 'inventory.approve',
    table: 'stock_counts',
    date: 'count_date',
    amount: 'NULL',
    path: '/inventory/counts',
  },
  {
    type: 'purchase_requisition',
    permission: 'purchase.approve',
    table: 'purchase_requisitions',
    date: 'requisition_date',
    amount: 'NULL',
    path: '/purchase/requisitions',
  },
  {
    type: 'purchase_order',
    permission: 'purchase.approve',
    table: 'purchase_orders',
    date: 'order_date',
    amount: 't.total',
    path: '/purchase/orders',
  },
];

async function pendingApprovals(ctx) {
  const parts = APPROVALS.filter((a) => has(ctx, a.permission));
  if (!parts.length) return null;
  const b = docBranches(ctx, 't');
  const rows = await select(
    parts
      .map(
        (a) => `(SELECT '${a.type}' AS type, t.id, t.number, t.${a.date} AS date, ${a.amount} AS amount,
                        u.name AS requestedBy, t.updated_at AS at
                   FROM ${a.table} t LEFT JOIN users u ON u.id = t.created_by
                  WHERE t.company_id = :companyId AND t.deleted_at IS NULL AND t.status = 'pending_approval' ${b.sql}
                  ORDER BY t.updated_at DESC LIMIT 10)`,
      )
      .join(' UNION ALL '),
    { companyId: ctx.auth.companyId, ...b.params },
  );
  const pathOf = Object.fromEntries(parts.map((a) => [a.type, a.path]));
  rows.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return rows
    .slice(0, 12)
    .map((r) => ({ ...r, id: String(r.id), approvePath: `${pathOf[r.type]}/${r.id}/approve` }));
}

async function overdueInvoices(ctx, today) {
  const b = docBranches(ctx, 'i');
  const [rows, [totals]] = await Promise.all([
    select(
      `SELECT i.id, i.number, i.due_date AS dueDate, i.total - i.paid_amount AS balance, p.name AS customer,
              DATEDIFF(:today, i.due_date) AS daysOverdue
         FROM sales_invoices i JOIN parties p ON p.id = i.customer_id
        WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.status IN ('unpaid', 'partially_paid')
          AND i.due_date < :today ${b.sql}
        ORDER BY balance DESC LIMIT 8`,
      { companyId: ctx.auth.companyId, today, ...b.params },
    ),
    select(
      `SELECT COUNT(*) AS count, COALESCE(SUM(i.total - i.paid_amount), 0) AS total FROM sales_invoices i
        WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.status IN ('unpaid', 'partially_paid')
          AND i.due_date < :today ${b.sql}`,
      { companyId: ctx.auth.companyId, today, ...b.params },
    ),
  ]);
  return {
    count: Number(totals.count),
    total: fixed(totals.total),
    rows: rows.map((r) => ({
      ...r,
      id: String(r.id),
      balance: fixed(r.balance),
      daysOverdue: Number(r.daysOverdue),
    })),
  };
}

/** Latest documents across the modules the user can see (only their own without reports access). */
const ACTIVITY = [
  {
    type: 'sales_invoice',
    permission: 'sales.view',
    table: 'sales_invoices',
    amount: 't.total',
    status: "t.status <> 'draft'",
  },
  { type: 'customer_receipt', permission: 'sales.view', table: 'customer_receipts', amount: 't.amount' },
  {
    type: 'supplier_bill',
    permission: 'purchase.view',
    table: 'supplier_bills',
    amount: 't.total',
    status: "t.status <> 'draft'",
  },
  { type: 'supplier_payment', permission: 'purchase.view', table: 'supplier_payments', amount: 't.amount' },
  { type: 'goods_receipt', permission: 'purchase.view', table: 'goods_receipts', amount: 'NULL' },
  { type: 'stock_adjustment', permission: 'inventory.view', table: 'stock_adjustments', amount: 'NULL' },
  { type: 'stock_transfer', permission: 'inventory.view', table: 'stock_transfers', amount: 'NULL' },
  { type: 'voucher', permission: 'accounting.view', table: 'vouchers', amount: 't.amount' },
  { type: 'expense', permission: 'accounting.view', table: 'expenses', amount: 't.total' },
  {
    type: 'manufacturing_order',
    permission: 'manufacturing.view',
    table: 'manufacturing_orders',
    amount: 'NULL',
  },
];

async function recentActivity(ctx) {
  const parts = ACTIVITY.filter((a) => has(ctx, a.permission));
  if (!parts.length) return [];
  const mine = !insight(ctx);
  const b = docBranches(ctx, 't');
  const rows = await select(
    parts
      .map(
        (a) => `(SELECT '${a.type}' AS type, t.id, t.number, t.status, ${a.amount} AS amount, u.name AS user,
                        t.updated_at AS at
                   FROM ${a.table} t LEFT JOIN users u ON u.id = COALESCE(t.updated_by, t.created_by)
                  WHERE t.company_id = :companyId AND t.deleted_at IS NULL ${b.sql}
                    ${a.status ? `AND ${a.status}` : ''} ${mine ? 'AND t.created_by = :userId' : ''}
                  ORDER BY t.updated_at DESC LIMIT 15)`,
      )
      .join(' UNION ALL '),
    { companyId: ctx.auth.companyId, userId: ctx.auth.userId, ...b.params },
  );
  rows.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return rows
    .slice(0, 15)
    .map((r) => ({ ...r, id: String(r.id), amount: r.amount == null ? null : fixed(r.amount) }));
}

/** The cashier's day: own POS sales today and the open shift. */
async function mySales(ctx, today) {
  const [[sales], [session]] = await Promise.all([
    select(
      `SELECT COUNT(*) AS count, COALESCE(SUM(i.total), 0) AS total FROM sales_invoices i
        WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.channel = 'pos' AND i.status IN (:posted)
          AND i.invoice_date = :today AND i.created_by = :userId`,
      { companyId: ctx.auth.companyId, today, userId: ctx.auth.userId, posted: POSTED },
    ),
    select(
      `SELECT s.id, s.number, s.opened_at AS openedAt, r.name AS register FROM pos_sessions s
         JOIN pos_registers r ON r.id = s.register_id
        WHERE s.company_id = :companyId AND s.status = 'open' AND s.opened_by = :userId LIMIT 1`,
      { companyId: ctx.auth.companyId, userId: ctx.auth.userId },
    ),
  ]);
  return {
    count: Number(sales.count),
    total: fixed(sales.total),
    session: session ? { ...session, id: String(session.id) } : null,
  };
}

export async function dashboardWidgets(ctx, query) {
  const today = await companyToday(ctx.auth.companyId);
  return cached(
    ctx,
    'widgets',
    [today],
    async () => {
      const out = { widgets: {} };
      const tasks = [];
      if (CAN.sales(ctx))
        tasks.push(overdueInvoices(ctx, today).then((v) => (out.widgets.overdueInvoices = v)));
      tasks.push(pendingApprovals(ctx).then((v) => v && (out.widgets.pendingApprovals = v)));
      tasks.push(recentActivity(ctx).then((v) => (out.widgets.recentActivity = v)));
      if (CAN.pos(ctx)) tasks.push(mySales(ctx, today).then((v) => (out.widgets.mySales = v)));
      // Fixed assets is not built yet: the widget appears once it is.
      out.widgets.assetMaintenance = { available: false, rows: [] };
      await Promise.all(tasks);
      return out;
    },
    { refresh: query.refresh === 'true' },
  );
}
