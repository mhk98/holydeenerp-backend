import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  GoodsReceipt,
  GoodsReceiptItem,
  PayableAllocation,
  PurchaseOrder,
  PurchaseOrderItem,
  SupplierBill,
  SupplierBillItem,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertBranchAccess, companyToday, normalizeLines } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { by, postSource, unpostSource } from '../accounting/posting.service.js';
import {
  D,
  addDays,
  branchRef,
  dateRange,
  findSupplier,
  fixed,
  inScope,
  invalid,
  lockDoc,
  priceLines,
  purchaseLineIncludes,
  purchaseSettings,
  supplierRef,
  userRef,
} from './purchase.common.js';
import { refreshOrderStatus } from './orders.service.js';

/**
 * Supplier bills (purchase invoices). A bill line can refer to a GRN line and/or a PO line;
 * billed quantities are capped by what was received (three-way match: PO, GRN, bill).
 *   draft → (post) → unpaid → partially_paid → paid; cancel a draft or an unpaid bill.
 * Paid status follows the payments and debit notes applied (payable_allocations).
 */

const LABEL = 'Bill';

const LIST_OPTIONS = {
  sortable: ['number', 'billDate', 'dueDate', 'total', 'createdAt'],
  searchable: ['number', 'supplierInvoiceNo', 'notes'],
  filterable: ['status', 'supplierId', 'orderId'],
  defaultSort: '-createdAt',
};

const balanceOf = (b) => fixed(D(b.total).minus(b.paidAmount));

export async function listBills(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = {
    ...q.where,
    companyId: ctx.auth.companyId,
    ...inScope(ctx),
    ...dateRange('billDate', query),
  };
  if (query.overdue === 'true') {
    where.dueDate = { [Op.lt]: await companyToday(ctx.auth.companyId) };
    where.status = { [Op.in]: ['unpaid', 'partially_paid'] };
  }
  const { rows, count } = await SupplierBill.findAndCountAll({
    where,
    include: [
      supplierRef(),
      userRef('creator'),
      { model: PurchaseOrder, as: 'order', attributes: ['id', 'number'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return {
    rows: rows.map((r) => ({ ...r.toJSON(), balance: balanceOf(r) })),
    count,
    page: q.page,
    limit: q.limit,
  };
}

export async function getBill(ctx, id) {
  const doc = await SupplierBill.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      supplierRef(),
      branchRef(),
      userRef('creator'),
      userRef('poster'),
      { model: PurchaseOrder, as: 'order', attributes: ['id', 'number'] },
      { model: GoodsReceipt, as: 'receipt', attributes: ['id', 'number'] },
      {
        model: SupplierBillItem,
        as: 'items',
        include: purchaseLineIncludes(),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const allocations = await sequelize.query(
    `SELECT a.id, a.source_type AS sourceType, a.source_id AS sourceId, a.amount, a.created_at AS createdAt,
            COALESCE(p.number, r.number) AS sourceNumber, COALESCE(p.payment_date, r.return_date) AS sourceDate
       FROM payable_allocations a
       LEFT JOIN supplier_payments p ON a.source_type = 'payment' AND p.id = a.source_id
       LEFT JOIN purchase_returns r ON a.source_type = 'debit_note' AND r.id = a.source_id
      WHERE a.bill_id = ? ORDER BY a.id`,
    { replacements: [doc.id], type: 'SELECT' },
  );
  return { ...doc.toJSON(), balance: balanceOf(doc), allocations };
}

async function writeDraft(ctx, doc, input, t) {
  const supplier = await findSupplier(ctx, input.supplierId, t);
  let order = null;
  let receipt = null;
  if (input.orderId) {
    order = await PurchaseOrder.findOne({
      where: { id: input.orderId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (!order || String(order.supplierId) !== String(supplier.id))
      throw invalid('orderId', 'Purchase order not found for this supplier');
  }
  if (input.receiptId) {
    receipt = await GoodsReceipt.findOne({
      where: { id: input.receiptId, companyId: ctx.auth.companyId, status: 'posted' },
      transaction: t,
    });
    if (!receipt || String(receipt.supplierId) !== String(supplier.id))
      throw invalid('receiptId', 'Posted goods receipt not found for this supplier');
  }
  const lines = await normalizeLines(ctx, input.items, t);
  for (const l of lines) {
    if (l.orderItemId) {
      const oi = await PurchaseOrderItem.findOne({
        where: { id: l.orderItemId, ...(order && { orderId: order.id }) },
        transaction: t,
      });
      if (!oi || !order) throw invalid(`${l.field}.orderItemId`, 'This line is not on the purchase order');
    }
    if (l.receiptItemId) {
      const ri = await GoodsReceiptItem.findOne({
        where: { id: l.receiptItemId, ...(receipt && { receiptId: receipt.id }) },
        transaction: t,
      });
      if (!ri || !receipt) throw invalid(`${l.field}.receiptItemId`, 'This line is not on the goods receipt');
    }
  }
  const { lines: priced, totals } = await priceLines(ctx.auth.companyId, lines, t);
  const settings = await purchaseSettings(ctx.auth.companyId, t);
  const billDate = input.billDate ?? doc.billDate;
  const terms = order?.paymentTermsDays ?? (supplier.paymentTermsDays || settings.defaultPaymentTermsDays);
  await doc.update(
    {
      supplierId: supplier.id,
      orderId: order?.id ?? receipt?.orderId ?? null,
      receiptId: receipt?.id ?? null,
      ...(order && { branchId: order.branchId }),
      ...(receipt && { branchId: receipt.branchId }),
      supplierInvoiceNo: input.supplierInvoiceNo ?? null,
      billDate,
      dueDate: input.dueDate ?? addDays(billDate, terms),
      notes: input.notes ?? null,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await SupplierBillItem.destroy({ where: { billId: doc.id }, transaction: t });
  await SupplierBillItem.bulkCreate(
    priced.map((l, i) => ({
      billId: doc.id,
      orderItemId: l.orderItemId ?? null,
      receiptItemId: l.receiptItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      unitPrice: fixed(l.unitPrice),
      discountPercent: l.discountPercent,
      taxGroupId: l.taxGroupId ?? null,
      taxAmount: l.taxAmount,
      lineSubtotal: l.lineSubtotal,
      lineTotal: l.lineTotal,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

/** Branch of a new bill: its order's or receipt's, else the user's current branch. */
async function branchFor(ctx, input, t) {
  if (input.receiptId) {
    const r = await GoodsReceipt.findOne({
      where: { id: input.receiptId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (r) return r.branchId;
  }
  if (input.orderId) {
    const o = await PurchaseOrder.findOne({
      where: { id: input.orderId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (o) return o.branchId;
  }
  const id = ctx.branchId ?? ctx.auth.branches?.find((b) => b.isDefault)?.id ?? ctx.auth.branchIds?.[0];
  if (!id) throw AppError.forbidden('You have no branch to record bills for');
  return id;
}

export async function createBillDraft(ctx, input, t) {
  const branchId = await branchFor(ctx, input, t);
  assertBranchAccess(ctx, branchId);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'purchase_bill',
    branchId,
    transaction: t,
  });
  const doc = await SupplierBill.create(
    {
      companyId: ctx.auth.companyId,
      branchId,
      supplierId: input.supplierId,
      number,
      billDate: input.billDate ?? (await companyToday(ctx.auth.companyId)),
      dueDate: input.billDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

export async function createBill(ctx, input) {
  const doc = await sequelize.transaction((t) => createBillDraft(ctx, input, t));
  return getBill(ctx, doc.id);
}

export async function updateBill(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SupplierBill, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getBill(ctx, id);
}

export async function deleteBill(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SupplierBill, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Add (sign = 1) or remove (sign = −1) a bill's quantities from its GRN and PO lines. */
async function applyBilledQuantities(doc, sign, t) {
  const items = await SupplierBillItem.findAll({
    where: { billId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  for (const [i, item] of items.entries()) {
    const qty = D(item.baseQuantity).times(sign);
    if (item.receiptItemId) {
      const ri = await GoodsReceiptItem.findByPk(item.receiptItemId, { transaction: t, lock: t.LOCK.UPDATE });
      const after = D(ri.billedBaseQuantity).plus(qty);
      if (after.gt(D(ri.baseQuantity).minus(ri.returnedBaseQuantity))) {
        throw invalid(`items.${i}.quantity`, 'More than was received (less returns) on the goods receipt');
      }
      await ri.update({ billedBaseQuantity: fixed(after) }, { transaction: t });
    }
    if (item.orderItemId) {
      const oi = await PurchaseOrderItem.findByPk(item.orderItemId, { transaction: t, lock: t.LOCK.UPDATE });
      const after = D(oi.billedBaseQuantity).plus(qty);
      if (sign > 0 && after.gt(oi.receivedBaseQuantity)) {
        throw invalid(
          `items.${i}.quantity`,
          `Only ${D(oi.receivedBaseQuantity).minus(oi.billedBaseQuantity).toFixed()} received and not yet billed on the order line`,
        );
      }
      await oi.update({ billedBaseQuantity: fixed(after) }, { transaction: t });
    }
  }
}

export async function postBill(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SupplierBill, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    if (!(await SupplierBillItem.count({ where: { billId: doc.id }, transaction: t })))
      throw invalid('items', 'Add at least one item');
    if (doc.supplierInvoiceNo) {
      const dup = await SupplierBill.findOne({
        where: {
          companyId: ctx.auth.companyId,
          supplierId: doc.supplierId,
          supplierInvoiceNo: doc.supplierInvoiceNo,
          id: { [Op.ne]: doc.id },
          status: { [Op.notIn]: ['draft', 'cancelled'] },
        },
        transaction: t,
      });
      if (dup)
        throw invalid(
          'supplierInvoiceNo',
          `Supplier invoice ${doc.supplierInvoiceNo} is already on bill ${dup.number}`,
        );
    }
    await applyBilledQuantities(doc, 1, t);
    await doc.update(
      { status: 'unpaid', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await postSource('supplier_bill', doc.id, by(ctx, t));
    await refreshOrderStatus(doc.orderId, t);
  });
  return getBill(ctx, id);
}

export async function cancelBill(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SupplierBill, ctx, id, t, { label: LABEL, allowed: ['draft', 'unpaid'] });
    assertBranchAccess(ctx, doc.branchId);
    if (doc.status === 'unpaid') {
      if (await PayableAllocation.count({ where: { billId: doc.id }, transaction: t })) {
        throw AppError.conflict('Payments or debit notes are applied to this bill');
      }
      await applyBilledQuantities(doc, -1, t);
      await unpostSource('supplier_bill', doc.id, by(ctx, t));
    }
    await doc.update(
      {
        status: 'cancelled',
        cancelledBy: ctx.auth.userId,
        cancelledAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await refreshOrderStatus(doc.orderId, t);
  });
  return getBill(ctx, id);
}

/** Recompute paid amount and status from the allocations (call with the bill locked). */
export async function refreshBillPayment(billId, t) {
  const bill = await SupplierBill.findByPk(billId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!bill || ['draft', 'cancelled'].includes(bill.status)) return bill;
  const paid = D(await PayableAllocation.sum('amount', { where: { billId }, transaction: t }));
  const status = paid.gte(bill.total) ? 'paid' : paid.gt(0) ? 'partially_paid' : 'unpaid';
  await bill.update({ paidAmount: fixed(paid), status }, { transaction: t });
  return bill;
}

// ── Conversions ────────────────────────────────────────────────────────────

/** Draft bill for what was received on an order and not billed yet. */
export async function billFromOrder(ctx, orderId) {
  const doc = await sequelize.transaction(async (t) => {
    const order = await lockDoc(PurchaseOrder, ctx, orderId, t, {
      label: 'Purchase order',
      allowed: ['partially_received', 'received', 'closed'],
    });
    assertBranchAccess(ctx, order.branchId);
    const items = await PurchaseOrderItem.findAll({
      where: { orderId: order.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const lines = items
      .map((i) => {
        const left = D(i.receivedBaseQuantity).minus(i.billedBaseQuantity);
        if (left.lte(0)) return null;
        const inUnit = left.dividedBy(i.unitFactor);
        const sameUnit = inUnit.isInteger() || D(i.unitFactor).eq(1);
        return {
          orderItemId: String(i.id),
          productId: String(i.productId),
          variantId: i.variantId ? String(i.variantId) : null,
          unitId: sameUnit ? i.unitId : null,
          quantity: sameUnit ? inUnit.toFixed() : left.toFixed(),
          unitPrice: sameUnit ? i.unitPrice : D(i.unitPrice).dividedBy(i.unitFactor).toFixed(4),
          discountPercent: i.discountPercent,
          taxGroupId: i.taxGroupId,
          notes: i.notes,
        };
      })
      .filter(Boolean);
    if (!lines.length) throw AppError.conflict('Nothing received on this order is waiting to be billed');
    return createBillDraft(ctx, { supplierId: order.supplierId, orderId: order.id, items: lines }, t);
  });
  return getBill(ctx, doc.id);
}

/** Draft bill for the unbilled lines of a posted goods receipt (at the receipt's net prices). */
export async function billFromReceipt(ctx, receiptId) {
  const doc = await sequelize.transaction(async (t) => {
    const receipt = await lockDoc(GoodsReceipt, ctx, receiptId, t, {
      label: 'Goods receipt',
      allowed: ['posted'],
    });
    assertBranchAccess(ctx, receipt.branchId);
    const items = await GoodsReceiptItem.findAll({
      where: { receiptId: receipt.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const lines = items
      .map((i) => {
        const left = D(i.baseQuantity).minus(i.returnedBaseQuantity).minus(i.billedBaseQuantity);
        if (left.lte(0)) return null;
        const inUnit = left.dividedBy(i.unitFactor);
        const sameUnit = inUnit.isInteger() || D(i.unitFactor).eq(1);
        return {
          receiptItemId: String(i.id),
          orderItemId: i.orderItemId ? String(i.orderItemId) : null,
          productId: String(i.productId),
          variantId: i.variantId ? String(i.variantId) : null,
          unitId: sameUnit ? i.unitId : null,
          quantity: sameUnit ? inUnit.toFixed() : left.toFixed(),
          unitPrice: sameUnit ? i.unitPrice : D(i.unitPrice).dividedBy(i.unitFactor).toFixed(4),
          discountPercent: '0',
          taxGroupId: i.taxGroupId,
          notes: i.notes,
        };
      })
      .filter(Boolean);
    if (!lines.length) throw AppError.conflict('Every line of this receipt is already billed');
    return createBillDraft(
      ctx,
      {
        supplierId: receipt.supplierId,
        receiptId: receipt.id,
        orderId: receipt.orderId,
        supplierInvoiceNo: null,
        items: lines,
      },
      t,
    );
  });
  return getBill(ctx, doc.id);
}
