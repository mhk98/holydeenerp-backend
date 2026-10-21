import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Party } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { companyToday } from '../inventory/inventory.common.js';
import { OPENING_ATTRIBUTES, roleOpening } from '../parties/party-balance.js';
import { D, fixed } from './purchase.common.js';

/**
 * Accounts payable, derived from purchase documents (no journal needed):
 *   + opening balance (credit = we owe the supplier)
 *   + posted bills
 *   − posted payments (void ones are ignored)
 *   − posted returns / debit notes
 * Balances are "payable": positive = we owe the supplier.
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const scope = (ctx) => (ctx.branchIds.length ? ctx.branchIds : [0]);

/** Supplier-side opening balance (credit = payable; a supplier who is also a customer: only a credit balance). */
const openingOf = (p) => roleOpening(p, 'supplier');

/** Ledger entries of one supplier as a UNION of its documents. */
const ENTRIES = `
  SELECT 'bill' AS type, b.id, b.number, b.bill_date AS date, b.supplier_invoice_no AS reference,
         b.total AS credit, 0 AS debit, b.posted_at AS postedAt
    FROM supplier_bills b
   WHERE b.company_id = :companyId AND b.supplier_id = :supplierId AND b.branch_id IN (:branchIds)
     AND b.status IN ('unpaid', 'partially_paid', 'paid') AND b.deleted_at IS NULL
  UNION ALL
  SELECT 'payment', p.id, p.number, p.payment_date, p.reference, 0, p.amount, p.created_at
    FROM supplier_payments p
   WHERE p.company_id = :companyId AND p.supplier_id = :supplierId AND p.branch_id IN (:branchIds)
     AND p.status = 'posted' AND p.deleted_at IS NULL
  UNION ALL
  SELECT r.type, r.id, r.number, r.return_date, r.reason, 0, r.total, r.posted_at
    FROM purchase_returns r
   WHERE r.company_id = :companyId AND r.supplier_id = :supplierId AND r.branch_id IN (:branchIds)
     AND r.status = 'posted' AND r.deleted_at IS NULL`;

async function findSupplier(ctx, supplierId) {
  const supplier = await Party.findOne({
    where: { id: supplierId, companyId: ctx.auth.companyId, isSupplier: true },
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
  if (!supplier) throw AppError.notFound('Supplier not found');
  return supplier;
}

/** Supplier ledger with a running balance; the opening line covers everything before `from`. */
export async function supplierLedger(ctx, supplierId, { from, to }) {
  const supplier = await findSupplier(ctx, supplierId);
  const replacements = {
    companyId: ctx.auth.companyId,
    supplierId: supplier.id,
    branchIds: scope(ctx),
    from: from ?? null,
    to: to ?? null,
  };
  const [rows, [before]] = await Promise.all([
    select(
      `SELECT * FROM (${ENTRIES}) e
        WHERE (:from IS NULL OR e.date >= :from) AND (:to IS NULL OR e.date <= :to)
        ORDER BY e.date, e.postedAt, e.id`,
      replacements,
    ),
    select(
      `SELECT COALESCE(SUM(credit - debit), 0) AS balance FROM (${ENTRIES}) e WHERE :from IS NOT NULL AND e.date < :from`,
      replacements,
    ),
  ]);
  const opening = openingOf(supplier).plus(before.balance);
  let running = opening;
  const entries = rows.map((r) => {
    running = running.plus(r.credit).minus(r.debit);
    return {
      ...r,
      id: String(r.id),
      credit: fixed(r.credit),
      debit: fixed(r.debit),
      balance: fixed(running),
    };
  });
  const credits = rows.reduce((s, r) => s.plus(r.credit), D(0));
  const debits = rows.reduce((s, r) => s.plus(r.debit), D(0));
  return {
    supplier: supplier.toJSON(),
    opening: fixed(opening),
    totalCredit: fixed(credits),
    totalDebit: fixed(debits),
    closing: fixed(running),
    entries,
  };
}

/** Open bills and unapplied credits (advances, debit notes) of a supplier — for the payment form. */
export async function openItems(ctx, supplierId) {
  const supplier = await findSupplier(ctx, supplierId);
  const replacements = { companyId: ctx.auth.companyId, supplierId: supplier.id, branchIds: scope(ctx) };
  const [bills, credits] = await Promise.all([
    select(
      `SELECT b.id, b.number, b.supplier_invoice_no AS supplierInvoiceNo, b.bill_date AS billDate, b.due_date AS dueDate,
              b.total, b.paid_amount AS paidAmount, b.total - b.paid_amount AS balance, b.status
         FROM supplier_bills b
        WHERE b.company_id = :companyId AND b.supplier_id = :supplierId AND b.branch_id IN (:branchIds)
          AND b.status IN ('unpaid', 'partially_paid') AND b.deleted_at IS NULL
        ORDER BY b.due_date, b.id`,
      replacements,
    ),
    select(
      `SELECT 'payment' AS sourceType, p.id, p.number, p.payment_date AS date, p.amount AS total, p.amount - p.allocated_amount AS available
         FROM supplier_payments p
        WHERE p.company_id = :companyId AND p.supplier_id = :supplierId AND p.branch_id IN (:branchIds)
          AND p.status = 'posted' AND p.amount > p.allocated_amount AND p.deleted_at IS NULL
       UNION ALL
       SELECT 'debit_note', r.id, r.number, r.return_date, r.total, r.total - r.applied_amount
         FROM purchase_returns r
        WHERE r.company_id = :companyId AND r.supplier_id = :supplierId AND r.branch_id IN (:branchIds)
          AND r.status = 'posted' AND r.total > r.applied_amount AND r.deleted_at IS NULL
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
    supplier: supplier.toJSON(),
    bills: bills.map((b) => num(b, ['total', 'paidAmount', 'balance'])),
    credits: credits.map((c) => num(c, ['total', 'available'])),
  };
}

const BUCKETS = ['current', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'];
/** By due date, "current" = not yet due; by bill date every bill is 0+ days old. */
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
 * Payables aging per supplier as of a date. Each open bill balance falls in a bucket by days past
 * its due date (basis=due_date, "current" = not yet due) or since its bill date (basis=bill_date).
 * Unapplied payments and debit notes are shown as credits; the opening balance has its own column.
 */
export async function payablesAging(ctx, { asOf, basis = 'due_date', supplierId }) {
  const date = asOf ?? (await companyToday(ctx.auth.companyId));
  const replacements = {
    companyId: ctx.auth.companyId,
    branchIds: scope(ctx),
    asOf: date,
    supplierId: supplierId ?? null,
  };
  const ageColumn = basis === 'bill_date' ? 'b.bill_date' : 'b.due_date';
  const [bills, credits, suppliers] = await Promise.all([
    // Balance as of the date: allocations made after it don't count yet.
    select(
      `SELECT b.supplier_id AS supplierId, b.id, b.number, b.bill_date AS billDate, b.due_date AS dueDate,
              b.total - COALESCE((SELECT SUM(a.amount) FROM payable_allocations a WHERE a.bill_id = b.id AND DATE(a.created_at) <= :asOf), 0) AS balance,
              DATEDIFF(:asOf, ${ageColumn}) AS days
         FROM supplier_bills b
        WHERE b.company_id = :companyId AND b.branch_id IN (:branchIds) AND b.deleted_at IS NULL
          AND b.status IN ('unpaid', 'partially_paid', 'paid') AND b.bill_date <= :asOf
          AND (:supplierId IS NULL OR b.supplier_id = :supplierId)
       HAVING balance > 0`,
      replacements,
    ),
    select(
      `SELECT supplierId, SUM(available) AS credit FROM (
         SELECT p.supplier_id AS supplierId,
                p.amount - COALESCE((SELECT SUM(a.amount) FROM payable_allocations a WHERE a.source_type = 'payment' AND a.source_id = p.id AND DATE(a.created_at) <= :asOf), 0) AS available
           FROM supplier_payments p
          WHERE p.company_id = :companyId AND p.branch_id IN (:branchIds) AND p.status = 'posted' AND p.deleted_at IS NULL
            AND p.payment_date <= :asOf AND (:supplierId IS NULL OR p.supplier_id = :supplierId)
         UNION ALL
         SELECT r.supplier_id,
                r.total - COALESCE((SELECT SUM(a.amount) FROM payable_allocations a WHERE a.source_type = 'debit_note' AND a.source_id = r.id AND DATE(a.created_at) <= :asOf), 0)
           FROM purchase_returns r
          WHERE r.company_id = :companyId AND r.branch_id IN (:branchIds) AND r.status = 'posted' AND r.deleted_at IS NULL
            AND r.return_date <= :asOf AND (:supplierId IS NULL OR r.supplier_id = :supplierId)
       ) c GROUP BY supplierId HAVING credit > 0`,
      replacements,
    ),
    Party.findAll({
      where: { companyId: ctx.auth.companyId, isSupplier: true, ...(supplierId && { id: supplierId }) },
      attributes: ['id', 'code', 'name', ...OPENING_ATTRIBUTES],
      paranoid: false,
    }),
  ]);

  const rows = new Map();
  const rowFor = (s) => {
    const key = String(s.id);
    if (!rows.has(key)) {
      rows.set(key, {
        supplierId: key,
        code: s.code,
        name: s.name,
        opening: D(0),
        credits: D(0),
        ...Object.fromEntries(BUCKETS.map((b) => [b, D(0)])),
        bills: 0,
      });
    }
    return rows.get(key);
  };
  const supplierOf = new Map(suppliers.map((s) => [String(s.id), s]));
  for (const s of suppliers) if (!openingOf(s).isZero()) rowFor(s).opening = openingOf(s);
  for (const b of bills) {
    const s = supplierOf.get(String(b.supplierId));
    if (!s) continue;
    const r = rowFor(s);
    const bucket = bucketOf(Number(b.days), basis);
    r[bucket] = r[bucket].plus(b.balance);
    r.bills += 1;
  }
  for (const c of credits) {
    const s = supplierOf.get(String(c.supplierId));
    if (s) rowFor(s).credits = D(c.credit);
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
    .filter((r) => !D(r.total).isZero() || r.bills > 0)
    .sort((a, b) => D(b.total).comparedTo(a.total));

  const sum = (k) => fixed(out.reduce((s, r) => s.plus(r[k]), D(0)));
  return {
    asOf: date,
    basis,
    rows: out,
    totals: Object.fromEntries(['opening', 'credits', ...BUCKETS, 'total'].map((k) => [k, sum(k)])),
  };
}

/** Outstanding payables per supplier (net of credits), with overdue amount. Built on the aging. */
export async function outstandingPayables(ctx, query) {
  const aging = await payablesAging(ctx, { basis: 'due_date', ...query });
  return {
    asOf: aging.asOf,
    rows: aging.rows.map((r) => ({
      supplierId: r.supplierId,
      code: r.code,
      name: r.name,
      bills: r.bills,
      outstanding: r.total,
      overdue: fixed(D(r.d0_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus)),
      credits: r.credits,
    })),
    totals: { outstanding: aging.totals.total, credits: aging.totals.credits },
  };
}
