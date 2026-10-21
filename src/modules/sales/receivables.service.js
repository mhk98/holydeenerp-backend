import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Party } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { companyToday } from '../inventory/inventory.common.js';
import { OPENING_ATTRIBUTES, roleOpening } from '../parties/party-balance.js';
import { D, fixed } from './sales.common.js';

/**
 * Accounts receivable, derived from sales documents (no journal needed):
 *   + opening balance (debit = the customer owes us)
 *   + posted invoices
 *   − posted money receipts (void ones are ignored)
 *   − posted sales returns / credit notes
 *   + money refunded on a return (POS)
 * Balances are "receivable": positive = the customer owes us.
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const scope = (ctx) => (ctx.branchIds.length ? ctx.branchIds : [0]);
/** Customer-side opening balance (a customer who is also a supplier: only a debit balance). */
const openingOf = (p) => roleOpening(p, 'customer');

const ENTRIES = `
  SELECT 'invoice' AS type, i.id, i.number, i.invoice_date AS date, i.customer_reference AS reference,
         i.total AS debit, 0 AS credit, i.posted_at AS postedAt
    FROM sales_invoices i
   WHERE i.company_id = :companyId AND i.customer_id = :customerId AND i.branch_id IN (:branchIds)
     AND i.status IN ('unpaid', 'partially_paid', 'paid') AND i.deleted_at IS NULL
  UNION ALL
  SELECT 'receipt', r.id, r.number, r.receipt_date, r.reference, 0, r.amount, r.created_at
    FROM customer_receipts r
   WHERE r.company_id = :companyId AND r.customer_id = :customerId AND r.branch_id IN (:branchIds)
     AND r.status = 'posted' AND r.deleted_at IS NULL
  UNION ALL
  SELECT s.type, s.id, s.number, s.return_date, s.reason, 0, s.total, s.posted_at
    FROM sales_returns s
   WHERE s.company_id = :companyId AND s.customer_id = :customerId AND s.branch_id IN (:branchIds)
     AND s.status = 'posted' AND s.deleted_at IS NULL
  UNION ALL
  SELECT 'refund', s.id, s.number, s.return_date, s.reason, s.refunded_amount, 0, s.posted_at
    FROM sales_returns s
   WHERE s.company_id = :companyId AND s.customer_id = :customerId AND s.branch_id IN (:branchIds)
     AND s.status = 'posted' AND s.refunded_amount > 0 AND s.deleted_at IS NULL`;

async function findCustomer(ctx, customerId) {
  const customer = await Party.findOne({
    where: { id: customerId, companyId: ctx.auth.companyId, isCustomer: true },
    attributes: [
      'id',
      'code',
      'name',
      'phone',
      'email',
      'paymentTermsDays',
      'creditLimit',
      ...OPENING_ATTRIBUTES,
    ],
    paranoid: false,
  });
  if (!customer) throw AppError.notFound('Customer not found');
  return customer;
}

/** Customer ledger (statement) with a running balance; the opening line covers everything before `from`. */
export async function customerLedger(ctx, customerId, { from, to }) {
  const customer = await findCustomer(ctx, customerId);
  const replacements = {
    companyId: ctx.auth.companyId,
    customerId: customer.id,
    branchIds: scope(ctx),
    from: from ?? null,
    to: to ?? null,
  };
  const [rows, [before]] = await Promise.all([
    select(
      `SELECT * FROM (${ENTRIES}) e WHERE (:from IS NULL OR e.date >= :from) AND (:to IS NULL OR e.date <= :to) ORDER BY e.date, e.postedAt, e.id`,
      replacements,
    ),
    select(
      `SELECT COALESCE(SUM(debit - credit), 0) AS balance FROM (${ENTRIES}) e WHERE :from IS NOT NULL AND e.date < :from`,
      replacements,
    ),
  ]);
  const opening = openingOf(customer).plus(before.balance);
  let running = opening;
  const entries = rows.map((r) => {
    running = running.plus(r.debit).minus(r.credit);
    return {
      ...r,
      id: String(r.id),
      debit: fixed(r.debit),
      credit: fixed(r.credit),
      balance: fixed(running),
    };
  });
  const limit = D(customer.creditLimit);
  return {
    customer: customer.toJSON(),
    opening: fixed(opening),
    totalDebit: fixed(rows.reduce((s, r) => s.plus(r.debit), D(0))),
    totalCredit: fixed(rows.reduce((s, r) => s.plus(r.credit), D(0))),
    closing: fixed(running),
    creditAvailable: limit.gt(0) ? fixed(limit.minus(running)) : null,
    entries,
  };
}

/** Open invoices and unapplied credits (advances, credit notes) — for the receipt form. */
export async function openItems(ctx, customerId) {
  const customer = await findCustomer(ctx, customerId);
  const replacements = { companyId: ctx.auth.companyId, customerId: customer.id, branchIds: scope(ctx) };
  const [invoices, credits] = await Promise.all([
    select(
      `SELECT i.id, i.number, i.customer_reference AS customerReference, i.invoice_date AS invoiceDate, i.due_date AS dueDate,
              i.total, i.paid_amount AS paidAmount, i.total - i.paid_amount AS balance, i.status
         FROM sales_invoices i
        WHERE i.company_id = :companyId AND i.customer_id = :customerId AND i.branch_id IN (:branchIds)
          AND i.status IN ('unpaid', 'partially_paid') AND i.deleted_at IS NULL
        ORDER BY i.due_date, i.id`,
      replacements,
    ),
    select(
      `SELECT 'receipt' AS sourceType, r.id, r.number, r.receipt_date AS date, r.amount AS total, r.amount - r.allocated_amount AS available
         FROM customer_receipts r
        WHERE r.company_id = :companyId AND r.customer_id = :customerId AND r.branch_id IN (:branchIds)
          AND r.status = 'posted' AND r.amount > r.allocated_amount AND r.deleted_at IS NULL
       UNION ALL
       SELECT 'credit_note', s.id, s.number, s.return_date, s.total, s.total - s.applied_amount - s.refunded_amount
         FROM sales_returns s
        WHERE s.company_id = :companyId AND s.customer_id = :customerId AND s.branch_id IN (:branchIds)
          AND s.status = 'posted' AND s.total > s.applied_amount + s.refunded_amount AND s.deleted_at IS NULL
        ORDER BY date`,
      replacements,
    ),
  ]);
  const num = (r, keys) => ({
    ...r,
    id: String(r.id),
    ...Object.fromEntries(keys.map((k) => [k, fixed(r[k])])),
  });
  return {
    customer: customer.toJSON(),
    invoices: invoices.map((i) => num(i, ['total', 'paidAmount', 'balance'])),
    credits: credits.map((c) => num(c, ['total', 'available'])),
  };
}

const BUCKETS = ['current', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'];
/** By due date, "current" = not yet due; by invoice date every invoice is 0+ days old. */
const bucketOf = (days, basis) =>
  basis === 'due_date' && days <= 0
    ? 'current'
    : days <= 30
      ? 'd0_30'
      : days <= 60
        ? 'd31_60'
        : days <= 90
          ? 'd61_90'
          : 'd90_plus';

/**
 * Receivables aging per customer as of a date: open invoice balances by days past due
 * (basis=due_date) or since the invoice date (basis=invoice_date). Unapplied receipts and credit
 * notes are shown as credits; the opening balance has its own column.
 */
export async function receivablesAging(ctx, { asOf, basis = 'due_date', customerId }) {
  const date = asOf ?? (await companyToday(ctx.auth.companyId));
  const replacements = {
    companyId: ctx.auth.companyId,
    branchIds: scope(ctx),
    asOf: date,
    customerId: customerId ?? null,
  };
  const ageColumn = basis === 'invoice_date' ? 'i.invoice_date' : 'i.due_date';
  const [invoices, credits, customers] = await Promise.all([
    select(
      `SELECT i.customer_id AS customerId, i.id,
              i.total - COALESCE((SELECT SUM(a.amount) FROM receivable_allocations a WHERE a.invoice_id = i.id AND DATE(a.created_at) <= :asOf), 0) AS balance,
              DATEDIFF(:asOf, ${ageColumn}) AS days
         FROM sales_invoices i
        WHERE i.company_id = :companyId AND i.branch_id IN (:branchIds) AND i.deleted_at IS NULL
          AND i.status IN ('unpaid', 'partially_paid', 'paid') AND i.invoice_date <= :asOf
          AND (:customerId IS NULL OR i.customer_id = :customerId)
       HAVING balance > 0`,
      replacements,
    ),
    select(
      `SELECT customerId, SUM(available) AS credit FROM (
         SELECT r.customer_id AS customerId,
                r.amount - COALESCE((SELECT SUM(a.amount) FROM receivable_allocations a WHERE a.source_type = 'receipt' AND a.source_id = r.id AND DATE(a.created_at) <= :asOf), 0) AS available
           FROM customer_receipts r
          WHERE r.company_id = :companyId AND r.branch_id IN (:branchIds) AND r.status = 'posted' AND r.deleted_at IS NULL
            AND r.receipt_date <= :asOf AND (:customerId IS NULL OR r.customer_id = :customerId)
         UNION ALL
         SELECT s.customer_id,
                s.total - s.refunded_amount - COALESCE((SELECT SUM(a.amount) FROM receivable_allocations a WHERE a.source_type = 'credit_note' AND a.source_id = s.id AND DATE(a.created_at) <= :asOf), 0)
           FROM sales_returns s
          WHERE s.company_id = :companyId AND s.branch_id IN (:branchIds) AND s.status = 'posted' AND s.deleted_at IS NULL
            AND s.return_date <= :asOf AND (:customerId IS NULL OR s.customer_id = :customerId)
       ) c GROUP BY customerId HAVING credit > 0`,
      replacements,
    ),
    Party.findAll({
      where: { companyId: ctx.auth.companyId, isCustomer: true, ...(customerId && { id: customerId }) },
      attributes: ['id', 'code', 'name', 'email', 'creditLimit', ...OPENING_ATTRIBUTES],
      paranoid: false,
    }),
  ]);

  const rows = new Map();
  const customerOf = new Map(customers.map((c) => [String(c.id), c]));
  const rowFor = (c) => {
    const key = String(c.id);
    if (!rows.has(key)) {
      rows.set(key, {
        customerId: key,
        code: c.code,
        name: c.name,
        email: c.email,
        creditLimit: fixed(c.creditLimit),
        opening: D(0),
        credits: D(0),
        ...Object.fromEntries(BUCKETS.map((b) => [b, D(0)])),
        invoices: 0,
      });
    }
    return rows.get(key);
  };
  for (const c of customers) if (!openingOf(c).isZero()) rowFor(c).opening = openingOf(c);
  for (const inv of invoices) {
    const c = customerOf.get(String(inv.customerId));
    if (!c) continue;
    const r = rowFor(c);
    const bucket = bucketOf(Number(inv.days), basis);
    r[bucket] = r[bucket].plus(inv.balance);
    r.invoices += 1;
  }
  for (const cr of credits) {
    const c = customerOf.get(String(cr.customerId));
    if (c) rowFor(c).credits = D(cr.credit);
  }
  const out = [...rows.values()]
    .map((r) => {
      const gross = BUCKETS.reduce((s, b) => s.plus(r[b]), D(0)).plus(r.opening);
      return {
        ...r,
        ...Object.fromEntries(BUCKETS.map((b) => [b, fixed(r[b])])),
        opening: fixed(r.opening),
        credits: fixed(r.credits),
        total: fixed(gross.minus(r.credits)),
      };
    })
    .filter((r) => !D(r.total).isZero() || r.invoices > 0)
    .sort((a, b) => D(b.total).comparedTo(a.total));
  const sum = (k) => fixed(out.reduce((s, r) => s.plus(r[k]), D(0)));
  return {
    asOf: date,
    basis,
    rows: out,
    totals: Object.fromEntries(['opening', 'credits', ...BUCKETS, 'total'].map((k) => [k, sum(k)])),
  };
}
