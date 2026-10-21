import { sequelize } from '../../config/db.js';
import {
  DeliveryChallan,
  DeliveryChallanItem,
  SalesInvoice,
  SalesOrder,
  SalesOrderItem,
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
import {
  D,
  branchRef,
  customerRef,
  dateRange,
  findCustomer,
  fixed,
  inScope,
  invalid,
  lockDoc,
  salesLineIncludes,
  userRef,
  warehouseRef,
} from './sales.common.js';
import { lockOpenOrder, refreshOrderStatus } from './orders.service.js';

/**
 * Delivery challans. A challan delivers part or all of a sales order (or goods without an order).
 * Posting takes the goods out of stock (movement "sale") at their cost and marks the order lines
 * delivered. Batch-tracked items need a batch and serial-tracked items their serials to post.
 *   draft → posted, or cancelled (drafts only).
 */

const LABEL = 'Delivery challan';

const LIST_OPTIONS = {
  sortable: ['number', 'challanDate', 'createdAt'],
  searchable: ['number', 'vehicleNo', 'notes'],
  filterable: ['status', 'customerId', 'warehouseId', 'orderId'],
  defaultSort: '-createdAt',
};

export async function listChallans(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await DeliveryChallan.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('challanDate', query) },
    include: [
      customerRef(),
      warehouseRef(),
      userRef('creator'),
      { model: SalesOrder, as: 'order', attributes: ['id', 'number'] },
    ],
    attributes: {
      include: [
        [
          sequelize.literal(
            '(SELECT COUNT(*) FROM delivery_challan_items i WHERE i.challan_id = DeliveryChallan.id)',
          ),
          'itemsCount',
        ],
      ],
    },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getChallan(ctx, id) {
  const doc = await DeliveryChallan.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      customerRef(),
      warehouseRef(),
      branchRef(),
      userRef('creator'),
      userRef('poster'),
      { model: SalesOrder, as: 'order', attributes: ['id', 'number', 'status'] },
      {
        model: DeliveryChallanItem,
        as: 'items',
        include: [
          ...salesLineIncludes({ batch: true, tax: false }),
          {
            model: SalesOrderItem,
            as: 'orderItem',
            attributes: ['id', 'baseQuantity', 'deliveredBaseQuantity'],
          },
        ],
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const invoices = await SalesInvoice.findAll({
    where: { challanId: doc.id },
    attributes: ['id', 'number', 'status', 'total'],
  });
  return { ...doc.toJSON(), invoices: invoices.map((i) => i.toJSON()) };
}

async function writeDraft(ctx, doc, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const customer = await findCustomer(ctx, input.customerId, t);
  let order = null;
  if (input.orderId) {
    order = await SalesOrder.findOne({
      where: { id: input.orderId, companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (!order || String(order.customerId) !== String(customer.id))
      throw invalid('orderId', 'Sales order not found for this customer');
  }
  const lines = await normalizeLines(ctx, input.items, t);
  const orderItems = order
    ? await SalesOrderItem.findAll({ where: { orderId: order.id }, transaction: t })
    : [];
  const orderItemOf = new Map(orderItems.map((i) => [String(i.id), i]));
  for (const l of lines) {
    if (order && !l.orderItemId)
      throw invalid(
        `${l.field}.orderItemId`,
        'Every line of a challan against an order must refer to an order line',
      );
    if (l.orderItemId) {
      const oi = orderItemOf.get(String(l.orderItemId));
      if (
        !oi ||
        String(oi.productId) !== String(l.productId) ||
        String(oi.variantId ?? '') !== String(l.variantId ?? '')
      ) {
        throw invalid(`${l.field}.orderItemId`, 'This line is not on the sales order');
      }
    }
  }
  await doc.update(
    {
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      customerId: customer.id,
      orderId: order?.id ?? null,
      challanDate: input.challanDate ?? doc.challanDate,
      shippingAddress: input.shippingAddress ?? order?.shippingAddress ?? null,
      vehicleNo: input.vehicleNo ?? null,
      driverName: input.driverName ?? null,
      notes: input.notes ?? null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await DeliveryChallanItem.destroy({ where: { challanId: doc.id }, transaction: t });
  await DeliveryChallanItem.bulkCreate(
    lines.map((l, i) => ({
      challanId: doc.id,
      orderItemId: l.orderItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      batchId: l.batchId,
      serialNumbers: l.serialNumbers,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

export async function createChallanDraft(ctx, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'delivery_note',
    branchId: warehouse.branchId,
    transaction: t,
  });
  const doc = await DeliveryChallan.create(
    {
      companyId: ctx.auth.companyId,
      branchId: warehouse.branchId,
      warehouseId: warehouse.id,
      customerId: input.customerId,
      number,
      challanDate: input.challanDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

export async function createChallan(ctx, input) {
  const doc = await sequelize.transaction(async (t) => {
    if (input.orderId) await lockOpenOrder(ctx, input.orderId, t);
    return createChallanDraft(ctx, input, t);
  });
  return getChallan(ctx, doc.id);
}

export async function updateChallan(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(DeliveryChallan, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getChallan(ctx, id);
}

export async function deleteChallan(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(DeliveryChallan, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

export async function cancelChallan(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(DeliveryChallan, ctx, id, t, { label: LABEL, allowed: ['draft'] });
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
  return getChallan(ctx, id);
}

/** Post: goods leave stock, the order lines are marked delivered. */
export async function postChallan(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(DeliveryChallan, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    await writableWarehouse(ctx, doc.warehouseId, 'warehouseId', t);
    if (doc.orderId) await lockOpenOrder(ctx, doc.orderId, t);
    const items = await DeliveryChallanItem.findAll({
      where: { challanId: doc.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    if (!items.length) throw invalid('items', 'Add at least one item');
    const lines = await normalizeLines(
      ctx,
      items.map((i) => i.toJSON()),
      t,
    );

    for (const [i, line] of lines.entries()) {
      if (isLotTracked(line.product) && !line.batchId)
        throw invalid(`items.${i}.batchId`, `Choose the batch of ${line.product.name} to deliver`);
      if (line.product.trackSerial && line.serialNumbers.length !== Number(line.baseQuantity)) {
        throw invalid(
          `items.${i}.serialNumbers`,
          `Enter ${Number(line.baseQuantity)} serial number(s) for ${line.product.name}`,
        );
      }
      if (items[i].orderItemId) {
        const oi = await SalesOrderItem.findByPk(items[i].orderItemId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        const after = D(oi.deliveredBaseQuantity).plus(items[i].baseQuantity);
        if (after.gt(oi.baseQuantity)) {
          throw invalid(
            `items.${i}.quantity`,
            `More than ordered: ${D(oi.baseQuantity).toFixed()} ordered, ${D(oi.deliveredBaseQuantity).toFixed()} already delivered`,
          );
        }
        await oi.update({ deliveredBaseQuantity: fixed(after) }, { transaction: t });
      }
    }

    const movements = await postMovements({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: doc.challanDate,
      reference: { type: 'delivery_challan', id: doc.id, no: doc.number },
      entries: items.map((item, i) => ({
        warehouseId: doc.warehouseId,
        productId: item.productId,
        variantId: item.variantId,
        batchId: item.batchId,
        quantity: D(item.baseQuantity).neg().toFixed(),
        type: 'sale',
        referenceItemId: item.id,
        serialNumbers: item.serialNumbers,
        serialStatus: 'issued',
        field: `items.${i}`,
      })),
      transaction: t,
    });
    let cost = D(0);
    for (const [i, m] of movements.entries()) {
      await items[i].update({ unitCost: m.unitCost }, { transaction: t });
      cost = cost.plus(D(m.totalCost).abs());
    }
    await doc.update(
      {
        status: 'posted',
        costTotal: fixed(cost),
        postedBy: ctx.auth.userId,
        postedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await refreshOrderStatus(doc.orderId, t);
  });
  return getChallan(ctx, id);
}

/** Draft challan for everything still to deliver on an order. */
export async function challanFromOrder(ctx, orderId) {
  const doc = await sequelize.transaction(async (t) => {
    const order = await lockOpenOrder(ctx, orderId, t);
    const items = await SalesOrderItem.findAll({
      where: { orderId: order.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const lines = items
      .map((i) => {
        const left = D(i.baseQuantity).minus(i.deliveredBaseQuantity);
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
    if (!lines.length) throw AppError.conflict('Everything on this order has been delivered');
    return createChallanDraft(
      ctx,
      { customerId: order.customerId, warehouseId: order.warehouseId, orderId: order.id, items: lines },
      t,
    );
  });
  return getChallan(ctx, doc.id);
}
