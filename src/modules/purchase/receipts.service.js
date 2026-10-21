import Decimal from 'decimal.js';
import { sequelize } from '../../config/db.js';
import {
  GoodsReceipt,
  GoodsReceiptCost,
  GoodsReceiptItem,
  Product,
  PurchaseOrder,
  PurchaseOrderItem,
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
import { isLotTracked, postMovements, resolveBatch } from '../inventory/stock.engine.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  D,
  branchRef,
  dateRange,
  findSupplier,
  fixed,
  inScope,
  invalid,
  lockDoc,
  purchaseLineIncludes,
  purchaseSettings,
  supplierRef,
  userRef,
  warehouseRef,
} from './purchase.common.js';
import { lockReceivableOrder, refreshOrderStatus } from './orders.service.js';

/**
 * Goods received notes (GRN). A GRN may receive part of an order; several GRNs can complete it.
 * Posting puts the goods into stock through the ledger (movement type purchase_receipt) at
 *   unit cost = (line value + allocated landed cost) / base quantity
 * where landed costs (freight, duty, …) are spread over the lines by value or by quantity.
 * Posted GRNs are final — send goods back with a purchase return.
 */

const LABEL = 'Goods receipt';

const LIST_OPTIONS = {
  sortable: ['number', 'receiptDate', 'totalCost', 'createdAt'],
  searchable: ['number', 'supplierReference', 'notes'],
  filterable: ['status', 'supplierId', 'warehouseId', 'orderId'],
  defaultSort: '-createdAt',
};

export async function listReceipts(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await GoodsReceipt.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('receiptDate', query) },
    include: [
      supplierRef(),
      warehouseRef(),
      userRef('creator'),
      { model: PurchaseOrder, as: 'order', attributes: ['id', 'number'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getReceipt(ctx, id) {
  const doc = await GoodsReceipt.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      supplierRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('poster'),
      { model: PurchaseOrder, as: 'order', attributes: ['id', 'number', 'status'] },
      { model: GoodsReceiptCost, as: 'costs', separate: true, order: [['id', 'ASC']] },
      {
        model: GoodsReceiptItem,
        as: 'items',
        include: [
          ...purchaseLineIncludes({ batch: true }),
          {
            model: PurchaseOrderItem,
            as: 'orderItem',
            attributes: ['id', 'baseQuantity', 'receivedBaseQuantity'],
          },
        ],
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return doc.toJSON();
}

/**
 * Spread landed costs over the lines. Each cost uses its own basis (line value or base quantity);
 * the last line takes the rounding remainder so the shares add up exactly.
 */
export function allocateLandedCosts(lines, costs) {
  const shares = lines.map(() => D(0));
  for (const cost of costs) {
    const weights = lines.map((l) => D(cost.allocation === 'quantity' ? l.baseQuantity : l.lineValue));
    const total = weights.reduce((s, w) => s.plus(w), D(0));
    if (total.lte(0)) continue;
    let given = D(0);
    weights.forEach((w, i) => {
      const share =
        i === weights.length - 1
          ? D(cost.amount).minus(given)
          : D(cost.amount).times(w).dividedBy(total).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      given = given.plus(share);
      shares[i] = shares[i].plus(share);
    });
  }
  return shares;
}

/** Price per entered unit of a PO line, net of discount, excluding tax. */
const orderNetPrice = (orderItem, unitFactor) =>
  D(orderItem.lineSubtotal).dividedBy(orderItem.baseQuantity).times(unitFactor);

async function writeDraft(ctx, doc, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const supplier = await findSupplier(ctx, input.supplierId, t);
  let order = null;
  if (input.orderId) {
    order = await PurchaseOrder.findOne({
      where: { id: input.orderId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (!order) throw invalid('orderId', 'Purchase order not found');
    if (String(order.supplierId) !== String(supplier.id))
      throw invalid('supplierId', 'The supplier must match the purchase order');
  }
  const lines = await normalizeLines(ctx, input.items, t, { allowNewBatch: true });
  const orderItems = order
    ? await PurchaseOrderItem.findAll({ where: { orderId: order.id }, transaction: t })
    : [];
  const orderItemOf = new Map(orderItems.map((i) => [String(i.id), i]));
  const products = await Product.findAll({
    where: { id: lines.map((l) => l.productId) },
    attributes: ['id', 'purchasePrice', 'taxGroupId'],
    transaction: t,
  });
  const productOf = new Map(products.map((p) => [String(p.id), p]));

  const shaped = lines.map((l) => {
    let unitPrice;
    let taxGroupId = l.taxGroupId ?? null;
    if (l.orderItemId) {
      const oi = orderItemOf.get(String(l.orderItemId));
      if (!oi) throw invalid(`${l.field}.orderItemId`, 'This line is not on the purchase order');
      if (
        String(oi.productId) !== String(l.productId) ||
        String(oi.variantId ?? '') !== String(l.variantId ?? '')
      ) {
        throw invalid(`${l.field}.productId`, 'The item must match the purchase order line');
      }
      unitPrice = orderNetPrice(oi, l.unitFactor);
      taxGroupId = oi.taxGroupId;
    } else {
      if (order)
        throw invalid(
          `${l.field}.orderItemId`,
          'Every line of a receipt against an order must refer to an order line',
        );
      const p = productOf.get(String(l.productId));
      unitPrice = l.unitPrice != null ? D(l.unitPrice) : D(p?.purchasePrice).times(l.unitFactor);
      if (taxGroupId === null && l.taxGroupId === undefined) taxGroupId = p?.taxGroupId ?? null;
    }
    return {
      ...l,
      unitPrice,
      taxGroupId,
      lineValue: D(l.quantity).times(unitPrice).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    };
  });

  const costs = input.costs ?? [];
  const shares = allocateLandedCosts(shaped, costs);
  const goodsValue = shaped.reduce((s, l) => s.plus(l.lineValue), D(0));
  const landed = costs.reduce((s, c) => s.plus(c.amount), D(0));

  await doc.update(
    {
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      supplierId: supplier.id,
      orderId: order?.id ?? null,
      receiptDate: input.receiptDate ?? doc.receiptDate,
      supplierReference: input.supplierReference ?? null,
      notes: input.notes ?? null,
      goodsValue: fixed(goodsValue),
      landedCostTotal: fixed(landed),
      totalCost: fixed(goodsValue.plus(landed)),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await GoodsReceiptItem.destroy({ where: { receiptId: doc.id }, transaction: t });
  await GoodsReceiptItem.bulkCreate(
    shaped.map((l, i) => ({
      receiptId: doc.id,
      orderItemId: l.orderItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      unitPrice: fixed(l.unitPrice),
      taxGroupId: l.taxGroupId,
      lineValue: fixed(l.lineValue),
      landedCost: fixed(shares[i]),
      unitCost: fixed(l.lineValue.plus(shares[i]).dividedBy(l.baseQuantity)),
      batchId: l.batchId ?? null,
      batchNo: l.batchId ? null : (l.batchNo ?? null),
      expiryDate: l.batchId ? null : (l.expiryDate ?? null),
      mfgDate: l.batchId ? null : (l.mfgDate ?? null),
      serialNumbers: l.serialNumbers,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
  await GoodsReceiptCost.destroy({ where: { receiptId: doc.id }, transaction: t });
  await GoodsReceiptCost.bulkCreate(
    costs.map((c) => ({
      receiptId: doc.id,
      costType: c.costType,
      description: c.description ?? null,
      amount: fixed(c.amount),
      allocation: c.allocation,
    })),
    { transaction: t },
  );
}

export async function createReceiptDraft(ctx, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'goods_receipt',
    branchId: warehouse.branchId,
    transaction: t,
  });
  const doc = await GoodsReceipt.create(
    {
      companyId: ctx.auth.companyId,
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      supplierId: input.supplierId,
      number,
      receiptDate: input.receiptDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

export async function createReceipt(ctx, input) {
  const doc = await sequelize.transaction(async (t) => {
    if (input.orderId) await lockReceivableOrder(ctx, input.orderId, t);
    return createReceiptDraft(ctx, input, t);
  });
  return getReceipt(ctx, doc.id);
}

export async function updateReceipt(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(GoodsReceipt, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getReceipt(ctx, id);
}

export async function deleteReceipt(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(GoodsReceipt, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

export async function cancelReceipt(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(GoodsReceipt, ctx, id, t, { label: LABEL, allowed: ['draft'] });
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
  return getReceipt(ctx, id);
}

/** Post a draft GRN: stock in at landed cost, update the order's received quantities. */
export async function postReceipt(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(GoodsReceipt, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
    if (doc.orderId) await lockReceivableOrder(ctx, doc.orderId, t);
    const items = await GoodsReceiptItem.findAll({
      where: { receiptId: doc.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    if (!items.length) throw invalid('items', 'Add at least one item');
    const lines = await normalizeLines(
      ctx,
      items.map((i) => i.toJSON()),
      t,
      { allowNewBatch: true },
    );

    // Over-receipt check per order line (with the tolerance from Settings → Purchase).
    if (doc.orderId) {
      const { overReceiptPercent } = await purchaseSettings(ctx.auth.companyId, t);
      const orderItems = await PurchaseOrderItem.findAll({
        where: { orderId: doc.orderId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const orderItemOf = new Map(orderItems.map((i) => [String(i.id), i]));
      const incoming = new Map();
      for (const i of items)
        incoming.set(
          String(i.orderItemId),
          (incoming.get(String(i.orderItemId)) ?? D(0)).plus(i.baseQuantity),
        );
      for (const [orderItemId, qty] of incoming) {
        const oi = orderItemOf.get(orderItemId);
        const limit = D(oi.baseQuantity).times(D(100).plus(overReceiptPercent)).dividedBy(100);
        const after = D(oi.receivedBaseQuantity).plus(qty);
        if (after.gt(limit)) {
          const idx = items.findIndex((i) => String(i.orderItemId) === orderItemId);
          throw invalid(
            `items.${idx}.quantity`,
            `More than ordered: ${D(oi.baseQuantity).toFixed()} ordered, ${D(oi.receivedBaseQuantity).toFixed()} already received`,
          );
        }
        await oi.update({ receivedBaseQuantity: fixed(after) }, { transaction: t });
      }
    }

    const entries = [];
    for (const [i, line] of lines.entries()) {
      const item = items[i];
      if (line.product.trackSerial && line.serialNumbers.length !== Number(line.baseQuantity)) {
        throw invalid(
          `items.${i}.serialNumbers`,
          `Enter ${Number(line.baseQuantity)} serial number(s) for ${line.product.name}`,
        );
      }
      let batchId = item.batchId;
      // Drafts may be incomplete (e.g. converted from an order); batch details are required to post.
      if (isLotTracked(line.product) && !batchId && !item.batchNo) {
        throw invalid(`items.${i}.batchNo`, `Enter a batch number for ${line.product.name}`);
      }
      if (line.product.trackExpiry && !batchId && !item.expiryDate) {
        throw invalid(`items.${i}.expiryDate`, `Enter the expiry date for ${line.product.name}`);
      }
      if (isLotTracked(line.product) && !batchId) {
        const batch = await resolveBatch(
          {
            companyId: ctx.auth.companyId,
            product: line.product,
            variantId: line.variantId,
            batchNo: item.batchNo,
            expiryDate: item.expiryDate,
            mfgDate: item.mfgDate,
            userId: ctx.auth.userId,
            field: `items.${i}`,
          },
          t,
        );
        batchId = batch.id;
        await item.update({ batchId }, { transaction: t });
      }
      const value = D(item.lineValue).plus(item.landedCost);
      entries.push({
        warehouseId: doc.warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        batchId,
        quantity: item.baseQuantity,
        unitCost: value.dividedBy(item.baseQuantity).toFixed(),
        totalCost: value.toFixed(),
        type: 'purchase_receipt',
        referenceItemId: item.id,
        serialNumbers: line.serialNumbers,
        field: `items.${i}`,
      });
    }
    await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: doc.receiptDate,
      reference: { type: 'goods_receipt', id: doc.id, no: doc.number },
      entries,
      transaction: t,
    });
    await doc.update(
      { status: 'posted', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await refreshOrderStatus(doc.orderId, t);
  });
  return getReceipt(ctx, id);
}

/** Draft GRN for everything still to receive on an order. */
export async function receiptFromOrder(ctx, orderId) {
  const doc = await sequelize.transaction(async (t) => {
    const order = await lockReceivableOrder(ctx, orderId, t);
    const items = await PurchaseOrderItem.findAll({
      where: { orderId: order.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const lines = items
      .map((i) => {
        const left = D(i.baseQuantity).minus(i.receivedBaseQuantity);
        if (left.lte(0)) return null;
        const inUnit = left.dividedBy(i.unitFactor);
        const sameUnit = inUnit.isInteger() || D(i.unitFactor).eq(1);
        return {
          orderItemId: String(i.id),
          productId: String(i.productId),
          variantId: i.variantId ? String(i.variantId) : null,
          unitId: sameUnit ? i.unitId : null,
          quantity: sameUnit ? inUnit.toFixed() : left.toFixed(),
          notes: i.notes,
        };
      })
      .filter(Boolean);
    if (!lines.length) throw AppError.conflict('Everything on this order has been received');
    // Batch numbers, expiry dates and serials are filled in on the GRN before posting.
    return createReceiptDraft(
      ctx,
      { supplierId: order.supplierId, warehouseId: order.warehouseId, orderId: order.id, items: lines },
      t,
    );
  });
  return getReceipt(ctx, doc.id);
}
