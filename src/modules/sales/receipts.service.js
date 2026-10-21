import { sequelize } from '../../config/db.js';
import {
  CustomerReceipt,
  PaymentMethod,
  ReceivableAllocation,
  SalesInvoice,
  SalesReturn,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { assertBranchAccess, companyToday } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { by, postSource, unpostSource } from '../accounting/posting.service.js';
import {
  D,
  branchRef,
  currentBranch,
  customerRef,
  dateRange,
  findCustomer,
  fixed,
  inScope,
  invalid,
  lockDoc,
  userRef,
} from './sales.common.js';
import { refreshInvoicePayment } from './invoices.service.js';

/**
 * Money receipts from customers. Posted on save; a receipt can settle several invoices and the rest
 * stays as an advance, which — like a credit note — can be applied later (applyCredit). Voiding a
 * receipt removes its allocations and reopens the invoices.
 */

const LABEL = 'Money receipt';

const LIST_OPTIONS = {
  sortable: ['number', 'receiptDate', 'amount', 'createdAt'],
  searchable: ['number', 'reference', 'notes'],
  filterable: ['status', 'customerId', 'paymentMethodId'],
  defaultSort: '-createdAt',
};

export async function listReceipts(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await CustomerReceipt.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('receiptDate', query) },
    include: [
      customerRef(),
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

export async function getReceipt(ctx, id) {
  const doc = await CustomerReceipt.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      customerRef(),
      branchRef(),
      userRef('creator'),
      userRef('voider'),
      { model: PaymentMethod, as: 'paymentMethod', attributes: ['id', 'name', 'type', 'requiresReference'] },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const allocations = await ReceivableAllocation.findAll({
    where: { sourceType: 'receipt', sourceId: doc.id },
    include: [
      { model: SalesInvoice, as: 'invoice', attributes: ['id', 'number', 'invoiceDate', 'dueDate', 'total'] },
    ],
    order: [['id', 'ASC']],
  });
  return {
    ...doc.toJSON(),
    unallocated: fixed(D(doc.amount).minus(doc.allocatedAmount)),
    allocations: allocations.map((a) => a.toJSON()),
  };
}

/** Apply `allocations` from a receipt or credit note to invoices of `customerId` (each locked). */
export async function allocateToInvoices(
  ctx,
  { sourceType, sourceId, customerId, available, allocations },
  t,
) {
  let applied = D(0);
  const seen = new Set();
  for (const [i, a] of allocations.entries()) {
    if (seen.has(String(a.invoiceId)))
      throw invalid(`allocations.${i}.invoiceId`, 'Each invoice can only be listed once');
    seen.add(String(a.invoiceId));
    const inv = await SalesInvoice.findOne({
      where: { id: a.invoiceId, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!inv || String(inv.customerId) !== String(customerId))
      throw invalid(`allocations.${i}.invoiceId`, 'Invoice not found for this customer');
    if (!['unpaid', 'partially_paid'].includes(inv.status))
      throw invalid(`allocations.${i}.invoiceId`, `Invoice ${inv.number} is not open`);
    const open = D(inv.total).minus(inv.paidAmount);
    if (D(a.amount).gt(open))
      throw invalid(
        `allocations.${i}.amount`,
        `Invoice ${inv.number} has only ${open.toFixed(2)} outstanding`,
      );
    applied = applied.plus(a.amount);
    if (applied.gt(available))
      throw invalid(`allocations.${i}.amount`, 'Allocations exceed the amount available');
    await ReceivableAllocation.create(
      {
        companyId: ctx.auth.companyId,
        invoiceId: inv.id,
        sourceType,
        sourceId,
        amount: fixed(a.amount),
        createdBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await refreshInvoicePayment(inv.id, t);
  }
  return applied;
}

/**
 * Record a receipt and its allocations inside a transaction. `extra.branchId` / `extra.posSessionId`
 * come from the POS register.
 */
export async function createReceiptDoc(ctx, input, t, extra = {}) {
  const customer = await findCustomer(ctx, input.customerId, t);
  const method = await PaymentMethod.findOne({
    where: { id: input.paymentMethodId, companyId: ctx.auth.companyId, isActive: true },
    transaction: t,
  });
  if (!method) throw invalid('paymentMethodId', 'Payment method not found');
  if (method.requiresReference && !input.reference)
    throw invalid('reference', `${method.name} receipts need a reference (e.g. cheque or transaction no.)`);
  const branchId = extra.branchId ?? currentBranch(ctx);
  assertBranchAccess(ctx, branchId);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'money_receipt',
    branchId,
    transaction: t,
  });
  const doc = await CustomerReceipt.create(
    {
      companyId: ctx.auth.companyId,
      branchId,
      customerId: customer.id,
      paymentMethodId: method.id,
      number,
      receiptDate: input.receiptDate ?? (await companyToday(ctx.auth.companyId)),
      amount: fixed(input.amount),
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      status: 'posted',
      posSessionId: extra.posSessionId ?? null,
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  const applied = await allocateToInvoices(
    ctx,
    {
      sourceType: 'receipt',
      sourceId: doc.id,
      customerId: customer.id,
      available: D(input.amount),
      allocations: input.allocations,
    },
    t,
  );
  await doc.update({ allocatedAmount: fixed(applied) }, { transaction: t });
  await postSource('customer_receipt', doc.id, by(ctx, t));
  return doc;
}

export async function createReceipt(ctx, input) {
  const doc = await sequelize.transaction((t) => createReceiptDoc(ctx, input, t));
  return getReceipt(ctx, doc.id);
}

export async function voidReceipt(ctx, id, reason) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(CustomerReceipt, ctx, id, t, { label: LABEL, allowed: ['posted'] });
    await voidReceiptDoc(ctx, doc, reason, t);
  });
  return getReceipt(ctx, id);
}

/** Void a locked, posted receipt inside a transaction (also used when its cheque bounces). */
export async function voidReceiptDoc(ctx, doc, reason, t) {
  assertBranchAccess(ctx, doc.branchId);
  const allocations = await ReceivableAllocation.findAll({
    where: { sourceType: 'receipt', sourceId: doc.id },
    transaction: t,
  });
  await ReceivableAllocation.destroy({
    where: { sourceType: 'receipt', sourceId: doc.id },
    transaction: t,
  });
  for (const a of allocations) await refreshInvoicePayment(a.invoiceId, t);
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
  await unpostSource('customer_receipt', doc.id, by(ctx, t));
}

/** Apply an advance (unallocated receipt) or a credit note to open invoices. */
export async function applyCredit(ctx, { sourceType, sourceId, allocations }) {
  await sequelize.transaction(async (t) => {
    const model = sourceType === 'receipt' ? CustomerReceipt : SalesReturn;
    const source = await model.findOne({
      where: { id: sourceId, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!source || source.status !== 'posted')
      throw AppError.notFound(
        sourceType === 'receipt' ? 'Posted receipt not found' : 'Posted credit note not found',
      );
    assertBranchAccess(ctx, source.branchId);
    const used = sourceType === 'receipt' ? source.allocatedAmount : source.appliedAmount;
    const total = sourceType === 'receipt' ? source.amount : D(source.total).minus(source.refundedAmount);
    const available = D(total).minus(used);
    if (available.lte(0)) throw AppError.conflict('Nothing left to apply');
    const applied = await allocateToInvoices(
      ctx,
      { sourceType, sourceId: source.id, customerId: source.customerId, available, allocations },
      t,
    );
    const next = fixed(D(used).plus(applied));
    await source.update(sourceType === 'receipt' ? { allocatedAmount: next } : { appliedAmount: next }, {
      transaction: t,
    });
  });
}
