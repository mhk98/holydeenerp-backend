import { sequelize } from '../../config/db.js';
import {
  GoodsReceipt,
  GoodsReceiptItem,
  PurchaseReturn,
  PurchaseReturnItem,
  SupplierBill,
  SupplierBillItem,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import {
  assertBranchAccess,
  companyToday,
  normalizeLines,
  writableWarehouse,
} from '../inventory/inventory.common.js';
import { isLotTracked, postMovements } from '../inventory/stock.engine.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { by, postSource } from '../accounting/posting.service.js';
import {
  D,
  branchRef,
  dateRange,
  findSupplier,
  fixed,
  inScope,
  invalid,
  lockDoc,
  priceLines,
  purchaseLineIncludes,
  supplierRef,
  userRef,
  warehouseRef,
} from './purchase.common.js';
import { allocateToBills } from './payments.service.js';

/**
 * Purchase returns and debit notes — one document, two types:
 *   return      goods go back to the supplier: stock out of the warehouse (purchase_return)
 *   debit_note  a claim without goods moving (short supply, price difference, damage the supplier accepts)
 * Both reduce what is owed to the supplier. When linked to a bill, the value is applied to it
 * on posting; otherwise it stays as a credit to apply later.
 *   draft → posted, or cancelled.
 */

const LABEL = 'Purchase return';

const LIST_OPTIONS = {
  sortable: ['number', 'returnDate', 'total', 'createdAt'],
  searchable: ['number', 'reason', 'notes'],
  filterable: ['status', 'supplierId', 'type'],
  defaultSort: '-createdAt',
};

export async function listReturns(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await PurchaseReturn.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('returnDate', query) },
    include: [supplierRef(), warehouseRef(), userRef('creator')],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getReturn(ctx, id) {
  const doc = await PurchaseReturn.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      supplierRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('poster'),
      { model: GoodsReceipt, as: 'receipt', attributes: ['id', 'number'] },
      { model: SupplierBill, as: 'bill', attributes: ['id', 'number', 'total', 'paidAmount'] },
      {
        model: PurchaseReturnItem,
        as: 'items',
        include: purchaseLineIncludes({ batch: true }),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return { ...doc.toJSON(), unapplied: fixed(D(doc.total).minus(doc.appliedAmount)) };
}

async function writeDraft(ctx, doc, input, t) {
  const supplier = await findSupplier(ctx, input.supplierId, t);
  let receipt = null;
  let bill = null;
  if (input.receiptId) {
    receipt = await GoodsReceipt.findOne({
      where: { id: input.receiptId, companyId: ctx.auth.companyId, status: 'posted' },
      transaction: t,
    });
    if (!receipt || String(receipt.supplierId) !== String(supplier.id))
      throw invalid('receiptId', 'Posted goods receipt not found for this supplier');
  }
  if (input.billId) {
    bill = await SupplierBill.findOne({
      where: { id: input.billId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (
      !bill ||
      String(bill.supplierId) !== String(supplier.id) ||
      ['draft', 'cancelled'].includes(bill.status)
    ) {
      throw invalid('billId', 'Posted bill not found for this supplier');
    }
  }
  let warehouse = null;
  if (input.type === 'return') {
    const warehouseId = input.warehouseId ?? receipt?.warehouseId;
    if (!warehouseId) throw invalid('warehouseId', 'Choose the warehouse the goods leave from');
    warehouse = await writableWarehouse(ctx, warehouseId, 'warehouseId', t);
  }
  const lines = await normalizeLines(ctx, input.items, t);
  for (const l of lines) {
    if (l.receiptItemId) {
      const ri = await GoodsReceiptItem.findOne({
        where: { id: l.receiptItemId, ...(receipt && { receiptId: receipt.id }) },
        transaction: t,
      });
      if (!ri || !receipt) throw invalid(`${l.field}.receiptItemId`, 'This line is not on the goods receipt');
      if (String(ri.productId) !== String(l.productId))
        throw invalid(`${l.field}.productId`, 'The item must match the goods receipt line');
    }
    if (l.billItemId) {
      const bi = await SupplierBillItem.findOne({
        where: { id: l.billItemId, ...(bill && { billId: bill.id }) },
        transaction: t,
      });
      if (!bi || !bill) throw invalid(`${l.field}.billItemId`, 'This line is not on the bill');
    }
    if (input.type === 'return' && isLotTracked(l.product) && !l.batchId)
      throw invalid(`${l.field}.batchId`, `Choose the batch of ${l.product.name} to return`);
  }
  const { lines: priced, totals } = await priceLines(ctx.auth.companyId, lines, t);
  await doc.update(
    {
      type: input.type,
      supplierId: supplier.id,
      warehouseId: warehouse?.id ?? null,
      ...(warehouse && { branchId: warehouse.branchId }),
      receiptId: receipt?.id ?? null,
      billId: bill?.id ?? null,
      returnDate: input.returnDate ?? doc.returnDate,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await PurchaseReturnItem.destroy({ where: { returnId: doc.id }, transaction: t });
  await PurchaseReturnItem.bulkCreate(
    priced.map((l, i) => ({
      returnId: doc.id,
      receiptItemId: l.receiptItemId ?? null,
      billItemId: l.billItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      batchId: input.type === 'return' ? (l.batchId ?? null) : null,
      serialNumbers: input.type === 'return' ? l.serialNumbers : [],
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

export async function createReturnDraft(ctx, input, t) {
  let branchId = ctx.branchId ?? ctx.auth.branches?.find((b) => b.isDefault)?.id ?? ctx.auth.branchIds?.[0];
  for (const [model, id] of [
    [GoodsReceipt, input.receiptId],
    [SupplierBill, input.billId],
  ]) {
    if (!id) continue;
    const src = await model.findOne({ where: { id, companyId: ctx.auth.companyId }, transaction: t });
    if (src) branchId = src.branchId;
  }
  if (!branchId) throw AppError.forbidden('You have no branch to record returns for');
  assertBranchAccess(ctx, branchId);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'purchase_return',
    branchId,
    transaction: t,
  });
  const doc = await PurchaseReturn.create(
    {
      companyId: ctx.auth.companyId,
      branchId,
      supplierId: input.supplierId,
      type: input.type,
      number,
      returnDate: input.returnDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

export async function createReturn(ctx, input) {
  const doc = await sequelize.transaction((t) => createReturnDraft(ctx, input, t));
  return getReturn(ctx, doc.id);
}

export async function updateReturn(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseReturn, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getReturn(ctx, id);
}

export async function deleteReturn(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseReturn, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

export async function cancelReturn(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseReturn, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update(
      {
        status: 'cancelled',
        cancelledBy: ctx.auth.userId,
        cancelledAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getReturn(ctx, id);
}

export async function postReturn(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseReturn, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    const items = await PurchaseReturnItem.findAll({
      where: { returnId: doc.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    if (!items.length) throw invalid('items', 'Add at least one item');

    if (doc.type === 'return') {
      await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
      for (const [i, item] of items.entries()) {
        if (!item.receiptItemId) continue;
        const ri = await GoodsReceiptItem.findByPk(item.receiptItemId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        const after = D(ri.returnedBaseQuantity).plus(item.baseQuantity);
        if (after.gt(ri.baseQuantity)) {
          throw invalid(
            `items.${i}.quantity`,
            `Only ${D(ri.baseQuantity).minus(ri.returnedBaseQuantity).toFixed()} of this receipt line can still be returned`,
          );
        }
        await ri.update({ returnedBaseQuantity: fixed(after) }, { transaction: t });
      }
      const movements = await postMovements({
        companyId: ctx.auth.companyId,
        userId: ctx.auth.userId,
        date: doc.returnDate,
        reference: { type: 'purchase_return', id: doc.id, no: doc.number },
        entries: items.map((item, i) => ({
          warehouseId: doc.warehouseId,
          productId: item.productId,
          variantId: item.variantId,
          batchId: item.batchId,
          quantity: D(item.baseQuantity).neg().toFixed(),
          type: 'purchase_return',
          referenceItemId: item.id,
          serialNumbers: item.serialNumbers,
          serialStatus: 'issued',
          field: `items.${i}`,
        })),
        transaction: t,
      });
      for (const [i, m] of movements.entries()) {
        await items[i].update({ stockCost: fixed(D(m.totalCost).abs()) }, { transaction: t });
      }
    }

    await doc.update(
      { status: 'posted', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await postSource('purchase_return', doc.id, by(ctx, t));

    // Apply to the linked bill as far as it is still open.
    if (doc.billId) {
      const bill = await SupplierBill.findByPk(doc.billId, { transaction: t, lock: t.LOCK.UPDATE });
      const open = D(bill.total).minus(bill.paidAmount);
      const amount = open.lt(doc.total) ? open : D(doc.total);
      if (amount.gt(0) && ['unpaid', 'partially_paid'].includes(bill.status)) {
        const applied = await allocateToBills(
          ctx,
          {
            sourceType: 'debit_note',
            sourceId: doc.id,
            supplierId: doc.supplierId,
            available: D(doc.total),
            allocations: [{ billId: bill.id, amount: fixed(amount) }],
          },
          t,
        );
        await doc.update({ appliedAmount: fixed(applied) }, { transaction: t });
      }
    }
  });
  return getReturn(ctx, id);
}

// ── Conversions ────────────────────────────────────────────────────────────

/** Draft return of the lines of a posted goods receipt (everything not returned yet). */
export async function returnFromReceipt(ctx, receiptId) {
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
        const left = D(i.baseQuantity).minus(i.returnedBaseQuantity);
        if (left.lte(0)) return null;
        return {
          receiptItemId: String(i.id),
          productId: String(i.productId),
          variantId: i.variantId ? String(i.variantId) : null,
          unitId: null,
          quantity: left.toFixed(),
          unitPrice: D(i.unitPrice).dividedBy(i.unitFactor).toFixed(4),
          taxGroupId: i.taxGroupId,
          batchId: i.batchId ? String(i.batchId) : null,
          serialNumbers: i.serialNumbers,
        };
      })
      .filter(Boolean);
    if (!lines.length) throw AppError.conflict('Everything on this receipt has already been returned');
    // The bill of this receipt (if any) gets the debit note applied.
    const bill = await SupplierBill.findOne({
      where: { receiptId: receipt.id, status: ['unpaid', 'partially_paid', 'paid'] },
      order: [['id', 'DESC']],
      transaction: t,
    });
    return createReturnDraft(
      ctx,
      {
        type: 'return',
        supplierId: receipt.supplierId,
        warehouseId: receipt.warehouseId,
        receiptId: receipt.id,
        billId: bill?.id ?? null,
        items: lines,
      },
      t,
    );
  });
  return getReturn(ctx, doc.id);
}

/** Draft debit note against a bill (all its lines; reduce to what is claimed). */
export async function debitNoteFromBill(ctx, billId) {
  const doc = await sequelize.transaction(async (t) => {
    const bill = await lockDoc(SupplierBill, ctx, billId, t, {
      label: 'Bill',
      allowed: ['unpaid', 'partially_paid', 'paid'],
    });
    assertBranchAccess(ctx, bill.branchId);
    const items = await SupplierBillItem.findAll({
      where: { billId: bill.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    return createReturnDraft(
      ctx,
      {
        type: 'debit_note',
        supplierId: bill.supplierId,
        billId: bill.id,
        items: items.map((i) => ({
          billItemId: String(i.id),
          productId: String(i.productId),
          variantId: i.variantId ? String(i.variantId) : null,
          unitId: i.unitId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          discountPercent: i.discountPercent,
          taxGroupId: i.taxGroupId,
        })),
      },
      t,
    );
  });
  return getReturn(ctx, doc.id);
}
