import { sequelize } from '../../config/db.js';
import {
  PayableAllocation,
  PaymentMethod,
  PurchaseReturn,
  SupplierBill,
  SupplierPayment,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { assertBranchAccess, companyToday } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { by, postSource, unpostSource } from '../accounting/posting.service.js';
import {
  D,
  branchRef,
  dateRange,
  findSupplier,
  fixed,
  inScope,
  invalid,
  lockDoc,
  supplierRef,
  userRef,
} from './purchase.common.js';
import { refreshBillPayment } from './bills.service.js';

/**
 * Supplier payments. A payment is posted when saved and can settle several bills; whatever is
 * not allocated stays as an advance that can be applied to bills later (applyCredit), as can a
 * debit note's value. Voiding a payment removes its allocations and reopens the bills.
 */

const LABEL = 'Payment';

const LIST_OPTIONS = {
  sortable: ['number', 'paymentDate', 'amount', 'createdAt'],
  searchable: ['number', 'reference', 'notes'],
  filterable: ['status', 'supplierId', 'paymentMethodId'],
  defaultSort: '-createdAt',
};

export async function listPayments(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await SupplierPayment.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('paymentDate', query) },
    include: [
      supplierRef(),
      userRef('creator'),
      { model: PaymentMethod, as: 'paymentMethod', attributes: ['id', 'name', 'type'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return {
    rows: rows.map((r) => ({ ...r.toJSON(), unallocated: fixed(D(r.amount).minus(r.allocatedAmount)) })),
    count,
    page: q.page,
    limit: q.limit,
  };
}

export async function getPayment(ctx, id) {
  const doc = await SupplierPayment.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      supplierRef(),
      branchRef(),
      userRef('creator'),
      userRef('voider'),
      { model: PaymentMethod, as: 'paymentMethod', attributes: ['id', 'name', 'type', 'requiresReference'] },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const allocations = await PayableAllocation.findAll({
    where: { sourceType: 'payment', sourceId: doc.id },
    include: [
      {
        model: SupplierBill,
        as: 'bill',
        attributes: ['id', 'number', 'billDate', 'dueDate', 'total', 'supplierInvoiceNo'],
      },
    ],
    order: [['id', 'ASC']],
  });
  return {
    ...doc.toJSON(),
    unallocated: fixed(D(doc.amount).minus(doc.allocatedAmount)),
    allocations: allocations.map((a) => a.toJSON()),
  };
}

/**
 * Apply `allocations` from one source (payment or debit note) to bills of `supplierId`.
 * Each bill is locked; an allocation can't exceed the bill's open balance or the source's
 * remaining amount. Returns the total applied.
 */
export async function allocateToBills(ctx, { sourceType, sourceId, supplierId, available, allocations }, t) {
  let applied = D(0);
  const seen = new Set();
  for (const [i, a] of allocations.entries()) {
    if (seen.has(String(a.billId)))
      throw invalid(`allocations.${i}.billId`, 'Each bill can only be listed once');
    seen.add(String(a.billId));
    const bill = await SupplierBill.findOne({
      where: { id: a.billId, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!bill || String(bill.supplierId) !== String(supplierId))
      throw invalid(`allocations.${i}.billId`, 'Bill not found for this supplier');
    if (!['unpaid', 'partially_paid'].includes(bill.status))
      throw invalid(`allocations.${i}.billId`, `Bill ${bill.number} is not open`);
    const open = D(bill.total).minus(bill.paidAmount);
    if (D(a.amount).gt(open))
      throw invalid(`allocations.${i}.amount`, `Bill ${bill.number} has only ${open.toFixed(2)} outstanding`);
    applied = applied.plus(a.amount);
    if (applied.gt(available))
      throw invalid(`allocations.${i}.amount`, 'Allocations exceed the amount available');
    await PayableAllocation.create(
      {
        companyId: ctx.auth.companyId,
        billId: bill.id,
        sourceType,
        sourceId,
        amount: fixed(a.amount),
        createdBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await refreshBillPayment(bill.id, t);
  }
  return applied;
}

export async function createPayment(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const supplier = await findSupplier(ctx, input.supplierId, t);
    const method = await PaymentMethod.findOne({
      where: { id: input.paymentMethodId, companyId: ctx.auth.companyId, isActive: true },
      transaction: t,
    });
    if (!method) throw invalid('paymentMethodId', 'Payment method not found');
    if (method.requiresReference && !input.reference)
      throw invalid('reference', `${method.name} payments need a reference (e.g. cheque or transaction no.)`);
    const branchId =
      ctx.branchId ?? ctx.auth.branches?.find((b) => b.isDefault)?.id ?? ctx.auth.branchIds?.[0];
    if (!branchId) throw AppError.forbidden('You have no branch to record payments for');
    assertBranchAccess(ctx, branchId);
    const number = await nextNumber({
      companyId: ctx.auth.companyId,
      docType: 'payment_voucher',
      branchId,
      transaction: t,
    });
    const doc = await SupplierPayment.create(
      {
        companyId: ctx.auth.companyId,
        branchId,
        supplierId: supplier.id,
        paymentMethodId: method.id,
        number,
        paymentDate: input.paymentDate ?? (await companyToday(ctx.auth.companyId)),
        amount: fixed(input.amount),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        status: 'posted',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    const applied = await allocateToBills(
      ctx,
      {
        sourceType: 'payment',
        sourceId: doc.id,
        supplierId: supplier.id,
        available: D(input.amount),
        allocations: input.allocations,
      },
      t,
    );
    await doc.update({ allocatedAmount: fixed(applied) }, { transaction: t });
    await postSource('supplier_payment', doc.id, by(ctx, t));
    return doc.id;
  });
  return getPayment(ctx, id);
}

export async function voidPayment(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SupplierPayment, ctx, id, t, { label: LABEL, allowed: ['posted'] });
    await voidPaymentDoc(ctx, doc, reason, t);
  });
  return getPayment(ctx, id);
}

/** Void a locked, posted payment inside a transaction (also used when its cheque bounces). */
export async function voidPaymentDoc(ctx, doc, reason, t) {
  assertBranchAccess(ctx, doc.branchId);
  const allocations = await PayableAllocation.findAll({
    where: { sourceType: 'payment', sourceId: doc.id },
    transaction: t,
  });
  await PayableAllocation.destroy({ where: { sourceType: 'payment', sourceId: doc.id }, transaction: t });
  for (const a of allocations) await refreshBillPayment(a.billId, t);
  await doc.update(
    {
      status: 'void',
      allocatedAmount: '0',
      voidedBy: ctx.auth.userId,
      voidedAt: new Date(),
      voidReason: reason,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await unpostSource('supplier_payment', doc.id, by(ctx, t));
}

/** Apply an advance (unallocated payment) or a debit note to open bills. */
export async function applyCredit(ctx, { sourceType, sourceId, allocations }) {
  await sequelize.transaction(async (t) => {
    const model = sourceType === 'payment' ? SupplierPayment : PurchaseReturn;
    const source = await model.findOne({
      where: { id: sourceId, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!source || source.status !== 'posted')
      throw AppError.notFound(
        sourceType === 'payment' ? 'Posted payment not found' : 'Posted debit note not found',
      );
    assertBranchAccess(ctx, source.branchId);
    const used = sourceType === 'payment' ? source.allocatedAmount : source.appliedAmount;
    const total = sourceType === 'payment' ? source.amount : source.total;
    const available = D(total).minus(used);
    if (available.lte(0)) throw AppError.conflict('Nothing left to apply');
    const applied = await allocateToBills(
      ctx,
      { sourceType, sourceId: source.id, supplierId: source.supplierId, available, allocations },
      t,
    );
    const next = fixed(D(used).plus(applied));
    await source.update(sourceType === 'payment' ? { allocatedAmount: next } : { appliedAmount: next }, {
      transaction: t,
    });
  });
}
