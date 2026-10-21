import { sequelize } from '../../config/db.js';
import {
  DeliveryChallanItem,
  SalesInvoice,
  SalesInvoiceItem,
  SalesReturn,
  SalesReturnItem,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import {
  assertBranchAccess,
  companyToday,
  itemPosition,
  writableWarehouse,
} from '../inventory/inventory.common.js';
import { isLotTracked, postMovements } from '../inventory/stock.engine.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { by, postSource } from '../accounting/posting.service.js';
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
  prepareLines,
  pricedColumns,
  salesLineIncludes,
  totalsColumns,
  userRef,
  warehouseRef,
} from './sales.common.js';
import { allocateToInvoices } from './receipts.service.js';

/**
 * Sales returns and credit notes — one document, two types:
 *   return       goods come back into stock (movement "sales_return") at the cost they left at
 *   credit_note  money only (price difference, goodwill) — stock does not change
 * Both reduce what the customer owes; when linked to an invoice the value is applied to it on posting,
 * otherwise it stays as a credit to apply later.   draft → posted, or cancelled.
 */

const LABEL = 'Sales return';

const LIST_OPTIONS = {
  sortable: ['number', 'returnDate', 'total', 'createdAt'],
  searchable: ['number', 'reason', 'notes'],
  filterable: ['status', 'customerId', 'type', 'invoiceId'],
  defaultSort: '-createdAt',
};

export async function listReturns(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await SalesReturn.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('returnDate', query) },
    include: [
      customerRef(),
      warehouseRef(),
      userRef('creator'),
      { model: SalesInvoice, as: 'invoice', attributes: ['id', 'number'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getReturn(ctx, id) {
  const doc = await SalesReturn.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      customerRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('poster'),
      { model: SalesInvoice, as: 'invoice', attributes: ['id', 'number', 'total', 'paidAmount', 'status'] },
      {
        model: SalesReturnItem,
        as: 'items',
        include: salesLineIncludes({ batch: true }),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return {
    ...doc.toJSON(),
    unapplied: fixed(D(doc.total).minus(doc.appliedAmount).minus(doc.refundedAmount)),
  };
}

async function writeDraft(ctx, doc, input, t) {
  const customer = await findCustomer(ctx, input.customerId, t);
  let invoice = null;
  if (input.invoiceId) {
    invoice = await SalesInvoice.findOne({
      where: { id: input.invoiceId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (
      !invoice ||
      String(invoice.customerId) !== String(customer.id) ||
      ['draft', 'cancelled'].includes(invoice.status)
    ) {
      throw invalid('invoiceId', 'Posted invoice not found for this customer');
    }
  }
  let warehouse = null;
  if (input.type === 'return') {
    const warehouseId = input.warehouseId ?? invoice?.warehouseId;
    if (!warehouseId) throw invalid('warehouseId', 'Choose the warehouse the goods come back to');
    warehouse = await writableWarehouse(ctx, warehouseId, 'warehouseId', t);
  }
  const date = input.returnDate ?? doc.returnDate;
  const { lines, totals } = await prepareLines(
    ctx,
    { customerId: customer.id, date, items: input.items, header: input },
    t,
  );
  for (const l of lines) {
    if (l.invoiceItemId) {
      const ii = await SalesInvoiceItem.findOne({
        where: { id: l.invoiceItemId, ...(invoice && { invoiceId: invoice.id }) },
        transaction: t,
      });
      if (!ii || !invoice || String(ii.productId) !== String(l.productId))
        throw invalid(`${l.field}.invoiceItemId`, 'This line is not on the invoice');
    }
    if (input.type === 'return' && isLotTracked(l.product) && !l.batchId)
      throw invalid(`${l.field}.batchId`, `Choose the batch of ${l.product.name} coming back`);
  }
  await doc.update(
    {
      type: input.type,
      customerId: customer.id,
      warehouseId: warehouse?.id ?? null,
      ...(warehouse && { branchId: warehouse.branchId }),
      invoiceId: invoice?.id ?? null,
      returnDate: date,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      ...totalsColumns(totals),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await SalesReturnItem.destroy({ where: { returnId: doc.id }, transaction: t });
  await SalesReturnItem.bulkCreate(
    lines.map((l, i) => ({
      returnId: doc.id,
      invoiceItemId: l.invoiceItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      ...pricedColumns(l),
      batchId: input.type === 'return' ? l.batchId : null,
      serialNumbers: input.type === 'return' ? l.serialNumbers : [],
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

export async function createReturnDraft(ctx, input, t) {
  let branchId = currentBranch(ctx);
  if (input.invoiceId) {
    const inv = await SalesInvoice.findOne({
      where: { id: input.invoiceId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (inv) branchId = inv.branchId;
  }
  assertBranchAccess(ctx, branchId);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'sales_return',
    branchId,
    transaction: t,
  });
  const doc = await SalesReturn.create(
    {
      companyId: ctx.auth.companyId,
      branchId,
      customerId: input.customerId,
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
    const doc = await lockDoc(SalesReturn, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getReturn(ctx, id);
}

export async function deleteReturn(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesReturn, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

export async function cancelReturn(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesReturn, ctx, id, t, { label: LABEL, allowed: ['draft'] });
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

/** Post a locked draft return inside a transaction (stock back, credit applied to its invoice). */
export async function postReturnDoc(ctx, doc, t) {
  assertBranchAccess(ctx, doc.branchId);
  const items = await SalesReturnItem.findAll({
    where: { returnId: doc.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  if (!items.length) throw invalid('items', 'Add at least one item');

  // Returned quantities can't exceed what the invoice line sold.
  for (const [i, item] of items.entries()) {
    if (!item.invoiceItemId) continue;
    const ii = await SalesInvoiceItem.findByPk(item.invoiceItemId, { transaction: t, lock: t.LOCK.UPDATE });
    const after = D(ii.returnedBaseQuantity).plus(item.baseQuantity);
    if (after.gt(ii.baseQuantity)) {
      throw invalid(
        `items.${i}.quantity`,
        `Only ${D(ii.baseQuantity).minus(ii.returnedBaseQuantity).toFixed()} of this invoice line can still be returned`,
      );
    }
    await ii.update({ returnedBaseQuantity: fixed(after) }, { transaction: t });
  }

  if (doc.type === 'return') {
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
    const entries = [];
    for (const [i, item] of items.entries()) {
      // Back at the cost it left at; without a source line, at the current average cost.
      let unitCost = null;
      if (item.invoiceItemId) {
        const ii = await SalesInvoiceItem.findByPk(item.invoiceItemId, { transaction: t });
        unitCost = D(ii.unitCost).gt(0) ? D(ii.unitCost) : null;
        if (!unitCost && ii.challanItemId)
          unitCost = D((await DeliveryChallanItem.findByPk(ii.challanItemId, { transaction: t })).unitCost);
      }
      if (!unitCost || unitCost.lte(0)) {
        unitCost = (
          await itemPosition(
            { warehouseId: doc.warehouseId, productId: item.productId, variantId: item.variantId },
            t,
          )
        ).avgCost;
      }
      entries.push({
        warehouseId: doc.warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        batchId: item.batchId,
        quantity: item.baseQuantity,
        unitCost: unitCost.toFixed(),
        type: 'sales_return',
        referenceItemId: item.id,
        serialNumbers: item.serialNumbers,
        field: `items.${i}`,
      });
    }
    const movements = await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: doc.returnDate,
      reference: { type: 'sales_return', id: doc.id, no: doc.number },
      entries,
      transaction: t,
    });
    for (const [i, m] of movements.entries())
      await items[i].update({ unitCost: m.unitCost }, { transaction: t });
  }

  await doc.update(
    { status: 'posted', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
    { transaction: t },
  );
  await postSource('sales_return', doc.id, by(ctx, t));

  if (doc.invoiceId) {
    const inv = await SalesInvoice.findByPk(doc.invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
    const open = D(inv.total).minus(inv.paidAmount);
    const amount = open.lt(doc.total) ? open : D(doc.total);
    if (amount.gt(0) && ['unpaid', 'partially_paid'].includes(inv.status)) {
      const applied = await allocateToInvoices(
        ctx,
        {
          sourceType: 'credit_note',
          sourceId: doc.id,
          customerId: doc.customerId,
          available: D(doc.total),
          allocations: [{ invoiceId: inv.id, amount: fixed(amount) }],
        },
        t,
      );
      await doc.update({ appliedAmount: fixed(applied) }, { transaction: t });
    }
  }
}

export async function postReturn(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(SalesReturn, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    await postReturnDoc(ctx, doc, t);
  });
  return getReturn(ctx, id);
}

/**
 * Draft return (or credit note) for the unreturned lines of an invoice. Lines are priced at what the
 * customer paid per base unit (tax included), so the refund matches the invoice exactly.
 */
/**
 * Return lines for an invoice, priced at what the customer paid per base unit (tax included) so the
 * refund matches the invoice. `quantities` (invoice item id → base quantity) picks part of it.
 */
export async function invoiceReturnLines(invoice, type, t, quantities = null) {
  const items = await SalesInvoiceItem.findAll({
    where: { invoiceId: invoice.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  const lines = [];
  for (const item of items) {
    const remaining = D(item.baseQuantity).minus(item.returnedBaseQuantity);
    const wanted = quantities ? quantities.get(String(item.id)) : remaining;
    if (wanted == null) continue;
    if (D(wanted).gt(remaining))
      throw invalid('items', `Only ${remaining.toFixed()} of a line can still be returned`);
    const left = D(wanted);
    if (left.lte(0)) continue;
    let batchId = item.batchId;
    let serials = item.serialNumbers;
    if (item.challanItemId) {
      const ci = await DeliveryChallanItem.findByPk(item.challanItemId, { transaction: t });
      batchId = ci.batchId;
      serials = ci.serialNumbers;
    }
    lines.push({
      invoiceItemId: String(item.id),
      productId: String(item.productId),
      variantId: item.variantId ? String(item.variantId) : null,
      unitId: null,
      quantity: left.toFixed(),
      unitPrice: D(item.lineTotal).dividedBy(item.baseQuantity).toFixed(4),
      discountType: 'percent',
      discountValue: '0',
      taxGroupId: item.taxGroupId ? String(item.taxGroupId) : null,
      priceIncludesTax: Boolean(item.taxGroupId),
      batchId: type === 'return' && batchId ? String(batchId) : null,
      serialNumbers: type === 'return' && serials.length === Number(left) ? serials : [],
    });
  }
  return lines;
}

export async function returnFromInvoice(ctx, invoiceId, { type = 'return' } = {}) {
  const doc = await sequelize.transaction(async (t) => {
    const invoice = await lockDoc(SalesInvoice, ctx, invoiceId, t, {
      label: 'Invoice',
      allowed: ['unpaid', 'partially_paid', 'paid'],
    });
    assertBranchAccess(ctx, invoice.branchId);
    const lines = await invoiceReturnLines(invoice, type, t);
    if (!lines.length) throw AppError.conflict('Everything on this invoice has already been returned');
    return createReturnDraft(
      ctx,
      {
        type,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        warehouseId: invoice.warehouseId,
        items: lines,
      },
      t,
    );
  });
  return getReturn(ctx, doc.id);
}
